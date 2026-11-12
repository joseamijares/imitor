// The receive-only upload API: web-standard handle(request, deps) -> Response, so it runs behind node:http
// (server.mjs) or any platform that speaks Request and Response. It stores finished runs; it never builds, runs or
// serves what it receives, and it only accepts images, videos and JSON.
//
//   POST /v1/runs                 (Authorization: Bearer imk_...) register a run, get presigned upload URLs
//   POST /v1/runs/:id/complete    check every file arrived as declared, mark the run ready, prune, get its URL
//
// deps: { db, storage, publicUrl, minCliVersion, allowUnverified, now, log }
import { redact } from "../../src/redact.mjs";
import { checkUpload, MAX_BODY_BYTES } from "../../src/upload.mjs";
import { newId } from "./ids.mjs";
import { mapLimit } from "./limit.mjs";

export { MAX_BODY_BYTES };
export const KEEP_RUNS = 50;
export const KEEP_DAYS = 30;
/** Unfinished uploads: at most this many per project, each dropped (with its files) after UNFINISHED_HOURS. */
export const MAX_UNFINISHED = 5;
export const UNFINISHED_HOURS = 24;
export const UPLOAD_SECONDS = 15 * 60;
const HOUR = 3600 * 1000;

const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status, error, extra = {}) => json(status, { error, ...extra });
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const nowOf = (deps) => deps.now?.() || new Date();

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
  if (!key) return fail(401, "this key is not valid: it is unknown, expired or was revoked");

  if (pathname === "/v1/runs" && request.method === "POST") return createRun(request, deps, key);
  const complete = /^\/v1\/runs\/([^/]+)\/complete$/.exec(pathname);
  if (complete && request.method === "POST") return completeRun(deps, key, complete[1]);
  return fail(403, "a project key can only upload runs: POST /v1/runs and POST /v1/runs/<id>/complete");
}

/**
 * The body as JSON, read as a stream and abandoned past MAX_BODY_BYTES, so a chunked body without a content-length
 * (or with a false one) cannot make the server hold more than that.
 */
async function readJson(request) {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return { tooLarge: true };
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    return { body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { body: undefined };
  }
}

const runUrl = (deps, id) => `${String(deps.publicUrl || "").replace(/\/+$/, "")}/runs/${id}`;
const sameFiles = (a, b) => a.length === b.length && a.every((f, i) => f.path === b[i].path && f.size === b[i].size && f.sha256 === b[i].sha256 && f.contentType === b[i].contentType);
const byPath = (files) => [...files].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
const runPrefix = (run) => `${run.projectId}/${run.id}/`;
const expired = (deps, run) => run.status !== "ready" && Date.parse(run.createdAt) < nowOf(deps).getTime() - UNFINISHED_HOURS * HOUR;

/** Files of a run with no object of the declared size, from one listing of the run's prefix. */
async function missingFiles(storage, run) {
  const found = new Map((await storage.list(runPrefix(run))).map((o) => [o.key, o.size]));
  return run.files.filter((f) => found.get(f.key) !== f.size);
}

/** Files whose object is not exactly as declared: size, content type and SHA-256, a few HEADs at a time. */
async function unverifiedFiles(deps, files) {
  const checked = await mapLimit(files, async (f) => {
    const o = await deps.storage.head(f.key);
    const sum = o?.sha256 === f.sha256 || (o?.sha256 == null && deps.allowUnverified === true);
    return o && o.size === f.size && o.contentType === f.contentType && sum ? null : f;
  });
  return checked.filter(Boolean);
}

async function uploadsFor(storage, files) {
  return mapLimit(files, async (f) => ({ path: f.path, ...(await storage.presignPut(f.key, { size: f.size, sha256: f.sha256, contentType: f.contentType, expiresIn: UPLOAD_SECONDS })) }));
}

async function createRun(request, deps, key) {
  const { db, storage } = deps;
  const { body, tooLarge } = await readJson(request);
  if (tooLarge) return fail(413, `the body is larger than ${MAX_BODY_BYTES / 1024 / 1024} MB; files go to the upload URLs, not in the body`);
  if (body === undefined) return fail(400, "the body must be JSON");
  const problem = checkUpload(body); // first: it refuses a body too deep for redact's copy or any other walk
  if (problem) return fail(400, problem);
  const clean = redact(body); // the client redacts; this catches one that did not

  await prune(deps, key.projectId, key.id); // drops expired unfinished uploads before they are counted
  let existing = await db.findRun(key.projectId, clean.clientRunId);
  if (!existing) {
    const unfinished = await db.listRuns(key.projectId, { status: "uploading" });
    if (unfinished.length >= MAX_UNFINISHED) {
      return fail(429, `this project already has ${plural(unfinished.length, "unfinished upload")}; push one of them again to finish it, or wait: an upload not completed within ${UNFINISHED_HOURS} hours is dropped`);
    }
    const id = newId("run");
    const files = byPath(clean.files).map((f) => ({ ...f, key: `${key.projectId}/${id}/${f.path}` }));
    const { run, created } = await db.createRun({
      id, projectId: key.projectId, clientRunId: clean.clientRunId, schemaVersion: clean.schemaVersion, run: clean.run, manifest: clean.manifest, files, keyId: key.id,
    });
    if (created) {
      for (const kind of ["captures", "activity"]) if (clean[kind]?.length) await db.addLines(kind, key.projectId, run.id, clean[kind]);
      await db.addAudit({ projectId: key.projectId, keyId: key.id, action: "run.create", detail: { runId: run.id, clientRunId: run.clientRunId } });
      return json(201, { id: run.id, status: run.status, uploads: await uploadsFor(storage, run.files), complete: `/v1/runs/${run.id}/complete` });
    }
    existing = run; // created by a push of the same run that got in first
  }
  const run = existing;
  if (!sameFiles(run.files, byPath(clean.files))) {
    return fail(409, `run ${clean.clientRunId} was already pushed to this project with different files; push it again under a new run`, { id: run.id });
  }
  if (run.status === "ready") return json(200, { id: run.id, status: run.status, uploads: [], complete: `/v1/runs/${run.id}/complete`, url: runUrl(deps, run.id) });
  return json(200, { id: run.id, status: run.status, uploads: await uploadsFor(storage, await missingFiles(storage, run)), complete: `/v1/runs/${run.id}/complete` });
}

async function completeRun(deps, key, id) {
  const { db, storage } = deps;
  let run = await db.getRun(id);
  // Another project's run reads as no run at all, so a key cannot learn which ids exist elsewhere.
  if (run?.projectId !== key.projectId) run = null;
  // An upload left unfinished past its time cannot be completed: it goes, with the rest of what is due.
  if (run && expired(deps, run)) {
    await prune(deps, key.projectId, key.id);
    run = null;
  }
  if (!run) return fail(404, `no run ${id} in this project (an upload not completed within ${UNFINISHED_HOURS} hours is dropped; push it again)`);
  if (run.status !== "ready") {
    const missing = await missingFiles(storage, run);
    const present = run.files.filter((f) => !missing.includes(f));
    const wrong = await unverifiedFiles(deps, present);
    // Deleted, so the next push lists them as missing and uploads them again.
    if (wrong.length) await storage.delete(wrong.map((f) => f.key)).catch((error) => deps.log?.(error));
    const bad = [...missing, ...wrong];
    if (bad.length) {
      const names = bad.slice(0, 5).map((f) => f.path).join(", ");
      return fail(409, `${plural(bad.length, "file")} not uploaded yet (or not with the declared size, type and checksum): ${names}${bad.length > 5 ? ", ..." : ""}`, { missing: bad.map((f) => f.path) });
    }
    await db.updateRun(run.id, { status: "ready", completedAt: nowOf(deps).toISOString() });
    await db.addAudit({ projectId: key.projectId, keyId: key.id, action: "run.complete", detail: { runId: run.id } });
  }
  await prune(deps, key.projectId, key.id);
  return json(200, { id: run.id, status: "ready", url: runUrl(deps, run.id) });
}

/**
 * Keep the newest KEEP_RUNS ready runs of a project, none older than KEEP_DAYS, and unfinished uploads for
 * UNFINISHED_HOURS; delete the rest and their files. A run's object keys are recorded before the run is deleted and
 * forgotten only once storage has deleted them, so a storage failure is logged and retried on the next prune (every
 * create and complete) instead of failing the request or leaving files behind. Returns the ids of deleted runs.
 */
export async function prune(deps, projectId, keyId = null) {
  const { db } = deps;
  const time = nowOf(deps).getTime();
  const runs = await db.listRuns(projectId);
  const keep = new Set(runs.filter((r) => r.status === "ready").slice(0, KEEP_RUNS).map((r) => r.id));
  const reason = (r) => {
    if (r.status !== "ready") return expired(deps, r) ? "unfinished" : null;
    if (!keep.has(r.id)) return "newest-runs";
    return Date.parse(r.completedAt) < time - KEEP_DAYS * 24 * HOUR ? "age" : null;
  };
  const doomed = runs.map((r) => [r, reason(r)]).filter(([, why]) => why);
  for (const [r, why] of doomed) {
    await db.addPendingDeletions(projectId, r.files.map((f) => f.key));
    await db.deleteRun(r.id);
    await db.addAudit({ projectId, keyId, action: "run.prune", detail: { runId: r.id, reason: why } });
  }
  const keys = await db.listPendingDeletions(projectId);
  if (keys.length) {
    try {
      await deps.storage.delete(keys);
      await db.removePendingDeletions(keys);
    } catch (error) {
      deps.log?.(error);
    }
  }
  return doomed.map(([r]) => r.id);
}
