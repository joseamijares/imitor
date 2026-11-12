// The body of a run upload (src/schema/run-upload.v1.json), checked the same way by `imitor push` before it sends
// and by a server when it receives, so a bad run is refused on the machine that has it with the same message.
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_RUN_BYTES = 300 * 1024 * 1024;
export const MAX_FILES = 5000;
export const MAX_LINES = 1000;
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

/** The first thing wrong with an upload body, as a plain sentence, or null if it is valid. */
export function checkUpload(body) {
  if (!isObject(body)) return "the body must be a JSON object";
  const extra = Object.keys(body).find((k) => !KEYS.includes(k));
  if (extra) return `unknown field "${extra}"`;
  if (typeof body.clientRunId !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(body.clientRunId)) return "clientRunId must be a run folder name (letters, digits and dashes)";
  if (body.schemaVersion !== 1) return Number.isInteger(body.schemaVersion) && body.schemaVersion > 1 ? `schemaVersion ${body.schemaVersion} is newer than this version understands (1)` : "schemaVersion must be 1";
  if (!isObject(body.run)) return "run must be the run.json object";
  if (body.run.id !== body.clientRunId) return "run.id must equal clientRunId";
  if (typeof body.run.startedAt !== "string" || !Array.isArray(body.run.flows)) return "run must have startedAt and flows";
  if (!isObject(body.manifest) || !Array.isArray(body.manifest.shots) || !Array.isArray(body.manifest.problems)) return "manifest must be the manifest.json object, with shots and problems";
  for (const key of ["captures", "activity"]) {
    if (body[key] === undefined) continue;
    if (!Array.isArray(body[key]) || !body[key].every(isObject)) return `${key} must be a list of objects`;
    if (body[key].length > MAX_LINES) return `${key} has ${body[key].length} lines; the limit is ${MAX_LINES}`;
  }
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
  return null;
}
