// The receive-only upload API: web-standard handle(request, deps) -> Response, so it runs behind node:http
// (server.mjs) or any platform that speaks Request and Response. It stores finished runs; it never builds, runs or
// serves what it receives, and it only accepts images, videos and JSON.
//
//   POST /v1/runs                 (Authorization: Bearer imk_...) register a run, get presigned upload URLs
//   POST /v1/runs/:id/complete    check every file arrived, mark the run ready, prune, get its URL
//
// deps: { db, storage, publicUrl, minCliVersion, now, log }
import { redact } from "../../src/redact.mjs";
import { checkUpload } from "../../src/upload.mjs";
import { newId } from "./ids.mjs";

export const KEEP_RUNS = 50;
export const KEEP_DAYS = 30;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const UPLOAD_SECONDS = 3600;

const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status, error, extra = {}) => json(status, { error, ...extra });
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** [major, minor, patch] of "imitor/1.2.3 ..." or "1.2.3", or null. */
export function parseVersion(text) {
  const m = /(?:^|imitor\/)(\d+)\.(\d+)\.(\d+)/.exec(String(text || ""));
  return m ? m.slice(1).map(Number) : null;
}
const older = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export async function handle(request, deps) {
  try {
    return await route(request, deps);
  } catch (error) {
    deps.log?.(error);
    return fail(500, "the server failed to handle this request; try again");
  }
}

async function route(request, deps) {
  const { pathname } = new URL(request.url);
  if (pathname !== "/v1" && !pathname.startsWith("/v1/")) return fail(404, `no endpoint ${request.method} ${pathname}`);

  // Before the key, so an outdated CLI hears what to do about it whatever else is wrong.
  const agent = request.headers.get("user-agent") || "";
  const client = /^imitor\//.test(agent) ? parseVersion(agent) : null;
  const min = parseVersion(deps.minCliVersion);
  if (client && min && older(client, min) < 0) {
    return fail(426, `this imitor (${client.join(".")}) is too old for this server; update to ${min.join(".")} or newer`, { minVersion: min.join(".") });
  }

  const auth = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") || "");
  if (!auth) return fail(401, "no key: send Authorization: Bearer <project key> (it starts with imk_)");
  const key = await deps.db.findAccessKey(auth[1]);
  if (!key) return fail(401, "this key is not valid: it is unknown or was revoked");

  if (pathname === "/v1/runs" && request.method === "POST") return createRun(request, deps, key);
  const complete = /^\/v1\/runs\/([^/]+)\/complete$/.exec(pathname);
  if (complete && request.method === "POST") return completeRun(deps, key, complete[1]);
  return fail(403, "a project key can only upload runs: POST /v1/runs and POST /v1/runs/<id>/complete");
}

async function readJson(request) {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return { tooLarge: true };
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { tooLarge: true };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { body: undefined };
  }
}

const runUrl = (deps, id) => `${String(deps.publicUrl || "").replace(/\/+$/, "")}/runs/${id}`;
const sameFiles = (a, b) => a.length === b.length && a.every((f, i) => f.path === b[i].path && f.size === b[i].size && f.sha256 === b[i].sha256 && f.contentType === b[i].contentType);
const byPath = (files) => [...files].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));

/** Files whose object is missing or has another size than declared. */
async function missingFiles(storage, files) {
  const missing = [];
  for (const f of files) {
    const found = await storage.head(f.key);
    if (!found || found.size !== f.size) missing.push(f);
  }
  return missing;
}

async function uploadsFor(storage, files) {
  return Promise.all(files.map(async (f) => ({ path: f.path, ...(await storage.presignPut(f.key, { size: f.size, sha256: f.sha256, contentType: f.contentType, expiresIn: UPLOAD_SECONDS })) })));
}

async function createRun(request, deps, key) {
  const { db, storage } = deps;
  const { body, tooLarge } = await readJson(request);
  if (tooLarge) return fail(413, `the body is larger than ${MAX_BODY_BYTES / 1024 / 1024} MB; files go to the upload URLs, not in the body`);
  if (body === undefined) return fail(400, "the body must be JSON");
  const problem = checkUpload(body);
  if (problem) return fail(400, problem);
  const clean = redact(body); // the client redacts; this catches one that did not

  const id = newId("run");
  const files = byPath(clean.files).map((f) => ({ ...f, key: `${key.projectId}/${id}/${f.path}` }));
  const { run, created } = await db.createRun({
    id, projectId: key.projectId, clientRunId: clean.clientRunId, schemaVersion: clean.schemaVersion, run: clean.run, manifest: clean.manifest, files,
  });
  if (created) {
    for (const kind of ["captures", "activity"]) if (clean[kind]?.length) await db.addLines(kind, key.projectId, run.id, clean[kind]);
    await db.addAudit({ projectId: key.projectId, keyId: key.id, action: "run.create", runId: run.id, clientRunId: run.clientRunId });
    return json(201, { id: run.id, status: run.status, uploads: await uploadsFor(storage, run.files), complete: `/v1/runs/${run.id}/complete` });
  }
  if (!sameFiles(run.files, byPath(clean.files))) {
    return fail(409, `run ${clean.clientRunId} was already pushed to this project with different files; push it again under a new run`, { id: run.id });
  }
  if (run.status === "ready") return json(200, { id: run.id, status: run.status, uploads: [], complete: `/v1/runs/${run.id}/complete`, url: runUrl(deps, run.id) });
  return json(200, { id: run.id, status: run.status, uploads: await uploadsFor(storage, await missingFiles(storage, run.files)), complete: `/v1/runs/${run.id}/complete` });
}

async function completeRun(deps, key, id) {
  const { db, storage } = deps;
  const run = await db.getRun(id);
  // Another project's run reads as no run at all, so a key cannot learn which ids exist elsewhere.
  if (!run || run.projectId !== key.projectId) return fail(404, `no run ${id} in this project`);
  if (run.status !== "ready") {
    const missing = await missingFiles(storage, run.files);
    if (missing.length) {
      const names = missing.slice(0, 5).map((f) => f.path).join(", ");
      return fail(409, `${plural(missing.length, "file")} not uploaded yet (or not with the declared size): ${names}${missing.length > 5 ? ", ..." : ""}`, { missing: missing.map((f) => f.path) });
    }
    await db.updateRun(run.id, { status: "ready", completedAt: (deps.now?.() || new Date()).toISOString() });
    await db.addAudit({ projectId: key.projectId, keyId: key.id, action: "run.complete", runId: run.id });
    await prune(deps, key.projectId);
  }
  return json(200, { id: run.id, status: "ready", url: runUrl(deps, run.id) });
}

/** Keep the newest KEEP_RUNS ready runs of a project, none older than KEEP_DAYS; delete the rest and their files. */
export async function prune({ db, storage, now }, projectId) {
  const cutoff = (now?.() || new Date()).getTime() - KEEP_DAYS * 24 * 3600 * 1000;
  const runs = await db.listRuns(projectId);
  const keep = new Set(runs.filter((r) => r.status === "ready").slice(0, KEEP_RUNS).map((r) => r.id));
  const old = (r) => Date.parse(r.completedAt || r.createdAt) < cutoff;
  const doomed = runs.filter((r) => (r.status === "ready" && !keep.has(r.id)) || old(r));
  for (const r of doomed) {
    await storage.delete(r.files.map((f) => f.key));
    await db.deleteRun(r.id);
  }
  return doomed.map((r) => r.id);
}
