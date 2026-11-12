// `imitor push`: upload one finished run to an Imitor Cloud instance. The body (run.json, manifest.json and the list
// of files, with typed values redacted) goes to POST /v1/runs, each file goes straight to the storage URL the server
// answers with, then POST /v1/runs/<id>/complete. Pushing the same run again resumes: the server asks only for the
// files it does not have yet.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { fillValues, redact } from "./redact.mjs";
import { listRuns, schemaVersionOf } from "./store.mjs";
import { checkUpload, extension, fileRefs, UPLOAD_TYPES } from "./upload.mjs";

export const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export const USER_AGENT = `imitor/${VERSION}`;
const RUN_FILES = new Set(["run.json", "manifest.json"]); // sent in the body, not as files
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
};

/** Every file under `dir`, as paths relative to it with / between folders, sorted. */
function filesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join("/"))
    .sort();
}

/**
 * The upload body for run `runId` (the newest run when null) of the app at `root`, redacted.
 * Returns { body, dir: the run folder, skipped: files left out because their type is not accepted }.
 */
export function buildUpload(root, runId = null) {
  const config = loadConfig(root);
  const out = path.resolve(root, config.out);
  const id = runId || listRuns(out)[0]?.id;
  if (!id) throw new Error(`no runs in ${path.relative(root, path.join(out, "runs")) || "runs"} yet. Run imitor first.`);
  const dir = path.join(out, "runs", String(id));
  if (!/^[A-Za-z0-9-]+$/.test(String(id)) || !fs.existsSync(path.join(dir, "run.json"))) {
    throw new Error(`no run "${id}" in ${path.relative(root, path.join(out, "runs"))}. Runs: ${listRuns(out).slice(0, 5).map((r) => r.id).join(", ") || "none"}`);
  }
  const run = readJson(path.join(dir, "run.json"));
  const manifest = fs.existsSync(path.join(dir, "manifest.json")) ? readJson(path.join(dir, "manifest.json")) : { shots: [], problems: [] };
  const all = filesIn(dir).filter((rel) => !RUN_FILES.has(rel));
  const skipped = all.filter((rel) => !UPLOAD_TYPES[extension(rel)]);
  const files = all.filter((rel) => UPLOAD_TYPES[extension(rel)]).map((rel) => {
    const bytes = fs.readFileSync(path.join(dir, rel));
    return { path: rel, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), contentType: UPLOAD_TYPES[extension(rel)] };
  });
  const raw = { clientRunId: String(id), schemaVersion: schemaVersionOf(run), run, manifest, files };
  // A failure screenshot the browser could not take is named in the manifest but is not on disk: leave it out.
  const listed = new Set(files.map((f) => f.path));
  for (const ref of fileRefs(raw)) if (ref.optional && !listed.has(ref.path)) ref.holder[ref.key] = null;
  // Checked before redaction, so a run too deep or too odd to copy is refused with a sentence, not a stack overflow.
  const problem = checkUpload(raw);
  if (problem) throw new Error(`run ${id} cannot be pushed: ${problem}`);
  const body = redact(raw, { secrets: [...fillValues(config)] });
  return { body, dir, skipped };
}

/**
 * Push a run. opts: { run: run id (default the newest), cloudUrl, token, fetch }.
 * Returns { id: the cloud run id, clientRunId, url, uploaded, files, skipped }.
 */
export async function push(root, { run = null, cloudUrl, token, fetch = globalThis.fetch } = {}) {
  if (!cloudUrl) throw new Error("IMITOR_CLOUD_URL is not set. Set it to the address of your Imitor Cloud, e.g. IMITOR_CLOUD_URL=https://cloud.example.com");
  if (!token) throw new Error("IMITOR_TOKEN is not set. Set it to the project's upload key (it starts with imk_).");
  if (!token.startsWith("imk_")) throw new Error("IMITOR_TOKEN is not a project upload key: those start with imk_.");
  let url;
  try {
    url = new URL(cloudUrl);
  } catch {
    throw new Error(`IMITOR_CLOUD_URL needs a full URL like https://cloud.example.com, got "${cloudUrl}"`);
  }
  // The key and the run travel in this request: plain http only to this machine, where nothing is on the wire.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error(`IMITOR_CLOUD_URL must start with https:// (plain http:// only for localhost, 127.0.0.1 or [::1]), got "${cloudUrl}"`);
  }
  const base = url.href.replace(/\/+$/, "");
  const { body, dir, skipped } = buildUpload(root, run);
  const problem = checkUpload(body);
  if (problem) throw new Error(`run ${body.clientRunId} cannot be pushed: ${problem}`);

  const call = async (route, payload) => {
    let res;
    try {
      res = await fetch(base + route, { method: "POST", headers: { authorization: `Bearer ${token}`, "user-agent": USER_AGENT, "content-type": "application/json" }, body: JSON.stringify(payload) });
    } catch (error) {
      throw new Error(`could not reach ${base}: ${error.cause?.message || error.message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${base} refused the push (${res.status}): ${data.error || res.statusText}`);
    return data;
  };

  const created = await call("/v1/runs", body);
  const declared = new Set(body.files.map((f) => f.path));
  for (const upload of created.uploads || []) {
    // Only ever send a file this push listed, whatever path the server names.
    if (!declared.has(upload.path)) throw new Error(`${base} asked for ${upload.path}, which this run did not list; stopping`);
    const headers = Object.fromEntries(Object.entries(upload.headers || {}).filter(([k]) => !["content-length", "host"].includes(k.toLowerCase())));
    let res;
    try {
      res = await fetch(upload.url, { method: upload.method || "PUT", headers, body: fs.readFileSync(path.join(dir, upload.path)) });
    } catch (error) {
      throw new Error(`uploading ${upload.path} failed: ${error.cause?.message || error.message}`);
    }
    if (!res.ok) throw new Error(`uploading ${upload.path} failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  const done = await call(`/v1/runs/${encodeURIComponent(created.id)}/complete`, {});
  return { id: created.id, clientRunId: body.clientRunId, url: done.url, uploaded: (created.uploads || []).length, files: body.files.length, skipped };
}
