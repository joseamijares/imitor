// The body of a run upload (src/schema/run-upload.v1.json), checked the same way by `imitor push` before it sends
// and by a server when it receives, so a bad run is refused on the machine that has it with the same message.
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_RUN_BYTES = 300 * 1024 * 1024;
export const MAX_FILES = 5000;
export const MAX_LINES = 1000;
/** The body itself (run.json, manifest.json and the file list), as JSON. */
// Under the 4.5 MB a Vercel function accepts, so a body is refused with this sentence rather than by the platform.
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_DEPTH = 64;
/** The only files a run upload may carry, by extension. Nothing a browser would run (HTML, JS, SVG). */
export const UPLOAD_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webm": "video/webm", ".json": "application/json" };

const KEYS = ["clientRunId", "schemaVersion", "run", "manifest", "files", "captures", "activity"];
const FILE_KEYS = ["path", "size", "sha256", "contentType"];
const SEGMENT = /^[\p{L}\p{N}._ @+()-]+$/u;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const mb = (n) => `${Math.round(n / 1024 / 1024)} MB`;

/** The extension of a path, with its dot ("" when none). */
export const extension = (p) => /\.[^./]*$/.exec(p)?.[0] || "";

/** Why `p` cannot be a file path in an upload, or null if it can. */
export function pathProblem(p) {
  if (typeof p !== "string" || !p) return "must be a non-empty string";
  if (p.length > 300) return "is longer than 300 characters";
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return "must be relative, not absolute";
  if (p.includes("\\")) return "must use / between folders";
  const segments = p.split("/");
  if (segments.some((s) => s === "." || s === "..")) return 'must not contain "." or ".." folders';
  if (segments.some((s) => !SEGMENT.test(s))) return "may only use letters, digits, spaces and . _ @ + ( ) - in names";
  if (!UPLOAD_TYPES[extension(p)]) return `must end in ${Object.keys(UPLOAD_TYPES).join(", ")}`;
  return null;
}

/**
 * Why `value` is nested too deeply or too large, or null. It walks without recursion and stops at the first excess, so
 * a 200,000-deep array is refused before anything recursive (a copy, redaction, JSON.stringify) can overflow the stack.
 */
export function sizeProblem(value) {
  const stack = [[value, 1]];
  let bytes = 0; // about the size of value as JSON
  while (stack.length) {
    const [v, depth] = stack.pop();
    if (depth > MAX_DEPTH) return `the body is nested more than ${MAX_DEPTH} levels deep`;
    if (typeof v === "string") bytes += Buffer.byteLength(v) + 2;
    else if (Array.isArray(v)) {
      bytes += 2 + v.length;
      for (const x of v) stack.push([x, depth + 1]);
    } else if (v && typeof v === "object") {
      bytes += 2;
      for (const [k, x] of Object.entries(v)) {
        bytes += Buffer.byteLength(k) + 4;
        stack.push([x, depth + 1]);
      }
    } else bytes += String(v).length;
    if (bytes > MAX_BODY_BYTES) return `the body is over ${mb(MAX_BODY_BYTES)} of JSON; the limit is ${mb(MAX_BODY_BYTES)}`;
  }
  return null;
}

/**
 * Every file the body points at, as { at, path, holder, key, optional } with holder[key] === path. An optional one may
 * be left out (a failure screenshot that could not be taken); a shot's file may not. Parts of the wrong shape are
 * skipped, so it can run before checkUpload.
 */
export function fileRefs(body) {
  const refs = [];
  const list = (v) => (Array.isArray(v) ? v : []);
  const add = (holder, key, at, optional = true) => {
    if (isObject(holder) && holder[key] != null) refs.push({ at: `${at}.${key}`, path: holder[key], holder, key, optional });
  };
  list(body?.manifest?.shots).forEach((s, i) => add(s, "file", `manifest.shots[${i}]`, false));
  list(body?.manifest?.problems).forEach((p, i) => ["file", "lastGoodShot"].forEach((k) => add(p, k, `manifest.problems[${i}]`)));
  list(body?.run?.flows).forEach((f, i) => list(f?.steps).forEach((s, j) => add(s, "shot", `run.flows[${i}].steps[${j}]`)));
  list(body?.captures).forEach((c, i) => add(c, "file", `captures[${i}]`));
  return refs;
}

/** The first thing wrong with an upload body, as a plain sentence, or null if it is valid. */
export function checkUpload(body) {
  if (!isObject(body)) return "the body must be a JSON object";
  const size = sizeProblem(body);
  if (size) return size;
  const extra = Object.keys(body).find((k) => !KEYS.includes(k));
  if (extra) return `unknown field "${extra}"`;
  if (typeof body.clientRunId !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(body.clientRunId)) return "clientRunId must be a run folder name (letters, digits and dashes)";
  if (body.schemaVersion !== 1) return Number.isInteger(body.schemaVersion) && body.schemaVersion > 1 ? `schemaVersion ${body.schemaVersion} is newer than this version understands (1)` : "schemaVersion must be 1";
  if (!isObject(body.run)) return "run must be the run.json object";
  if (body.run.id !== body.clientRunId) return "run.id must equal clientRunId";
  if (typeof body.run.startedAt !== "string" || typeof body.run.finishedAt !== "string" || !Array.isArray(body.run.flows)) return "run must have startedAt, finishedAt and flows";
  // The shapes src/derive.mjs reads without checking.
  const flow = body.run.flows.findIndex((f) => !isObject(f) || !Array.isArray(f.steps) || !f.steps.every(isObject));
  if (flow >= 0) return `run.flows[${flow}] must be an object with a list of steps`;
  if (!isObject(body.manifest) || !Array.isArray(body.manifest.shots) || !Array.isArray(body.manifest.problems)) return "manifest must be the manifest.json object, with shots and problems";
  const shot = body.manifest.shots.findIndex((s) => !isObject(s) || typeof s.file !== "string" || !Array.isArray(s.stubs) || !s.stubs.every((x) => typeof x === "string"));
  if (shot >= 0) return `manifest.shots[${shot}] must be an object with a file and a list of stubs`;
  const problem = body.manifest.problems.findIndex((p) => !isObject(p));
  if (problem >= 0) return `manifest.problems[${problem}] must be an object`;
  for (const key of ["captures", "activity"]) {
    if (body[key] === undefined) continue;
    if (!Array.isArray(body[key]) || !body[key].every(isObject)) return `${key} must be a list of objects`;
    if (body[key].length > MAX_LINES) return `${key} has ${body[key].length} lines; the limit is ${MAX_LINES}`;
  }
  const line = (body.activity || []).findIndex((a) => typeof a.at !== "string");
  if (line >= 0) return `activity[${line}].at must be a time`;
  if (!Array.isArray(body.files)) return "files must be a list";
  if (body.files.length > MAX_FILES) return `the run has ${body.files.length} files; the limit is ${MAX_FILES}`;
  const seen = new Set();
  let total = 0;
  for (const [i, f] of body.files.entries()) {
    const at = `files[${i}]`;
    if (!isObject(f)) return `${at} must be an object`;
    const odd = Object.keys(f).find((k) => !FILE_KEYS.includes(k));
    if (odd) return `${at} has an unknown field "${odd}"`;
    const bad = pathProblem(f.path);
    if (bad) return `${at}.path ${typeof f.path === "string" ? `"${f.path}" ` : ""}${bad}`;
    if (seen.has(f.path)) return `${f.path} is listed twice`;
    seen.add(f.path);
    if (!Number.isInteger(f.size) || f.size < 0) return `${f.path}: size must be a whole number of bytes`;
    if (f.size > MAX_FILE_BYTES) return `${f.path} is ${mb(f.size)}; the limit is ${mb(MAX_FILE_BYTES)} per file`;
    if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) return `${f.path}: sha256 must be 64 lower-case hex digits`;
    if (!Object.values(UPLOAD_TYPES).includes(f.contentType)) return `${f.path}: content type "${f.contentType}" is not accepted (only ${[...new Set(Object.values(UPLOAD_TYPES))].join(", ")})`;
    if (UPLOAD_TYPES[extension(f.path)] !== f.contentType) return `${f.path}: content type ${f.contentType} does not match its extension`;
    total += f.size;
  }
  if (total > MAX_RUN_BYTES) return `the run is ${mb(total)}; the limit is ${mb(MAX_RUN_BYTES)} per run`;
  // Every file the run points at is one of its own, so a run can never show another run's or project's file.
  for (const ref of fileRefs(body)) {
    const bad = pathProblem(ref.path);
    if (bad) return `${ref.at} ${typeof ref.path === "string" ? `"${ref.path}" ` : ""}${bad}`;
    if (!seen.has(ref.path)) return `${ref.at} points at ${ref.path}, which is not in files`;
  }
  return null;
}
