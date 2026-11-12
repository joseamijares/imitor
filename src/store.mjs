// The data the app reads, kept as plain files in the output folder (preview/ by default):
//   runs/<runId>/run.json, manifest.json, screens/   one folder per full run (imitor, imitor shoot)
//   captures/index.jsonl                              one line per screenshot or video taken on request
//   activity.jsonl                                    one line per MCP tool call
//   state.json                                        { seenProblems: [...], unseenProblems: [...] }
// Every function takes `out`, the absolute path of the output folder.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { agentsSummary, captureEntries, flowDetail, listEntry, problemsAcross, PROBLEM_RUNS, runDetail, runProblems, runStatus, SCHEMA_VERSION, withSeen } from "./derive.mjs";

// Imported from here before derive.mjs existed.
export { CONNECT_COMMANDS, fileUrl, flowDetail, PROBLEM_RUNS, runStatus, SCHEMA_VERSION, schemaVersionOf } from "./derive.mjs";

export const KEEP_RUNS = 50;

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
const readLines = (file) => {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return []; // a half-written line from a crashed process
    }
  });
};
const appendLine = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + "\n");
};
const stamp = (date) => new Date(date).toISOString().replace(/[-:]/g, "").slice(0, 15); // 20261111T185759

function git(root, args) {
  try {
    return execSync(`git ${args}`, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    return null;
  }
}

/** Branch, short commit and commit subject of the app's checkout (nulls outside git). */
export function gitInfo(root, env = process.env) {
  let branch = git(root, "rev-parse --abbrev-ref HEAD");
  if (!branch || branch === "HEAD") branch = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || null; // detached in CI
  return { branch, commit: git(root, "rev-parse --short HEAD"), subject: git(root, "log -1 --format=%s") };
}

/** A pull request number from GITHUB_REF (refs/pull/118/merge) or a subject ending in "(#118)". */
export function parsePr(env = process.env, subject = "") {
  const fromRef = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF || "");
  if (fromRef) return Number(fromRef[1]);
  const fromSubject = /\(#(\d+)\)\s*$/.exec(subject || "");
  return fromSubject ? Number(fromSubject[1]) : null;
}

/** The display name for an MCP client's clientInfo.name. */
export function clientDisplayName(name) {
  const n = String(name).toLowerCase();
  if (n.includes("claude")) return "Claude Code";
  if (n.includes("cursor")) return "Cursor";
  if (n.includes("codex")) return "Codex";
  return String(name);
}

/** Who started something: the MCP client, then IMITOR_AGENT, then GitHub Actions, then the git user. */
export function resolveBy({ clientName, env = process.env, root = process.cwd() } = {}) {
  if (clientName) return { name: clientDisplayName(clientName), kind: "agent" };
  if (env.IMITOR_AGENT) return { name: env.IMITOR_AGENT, kind: "agent" };
  if (env.GITHUB_ACTIONS === "true") return { name: "GitHub Actions", kind: "ci" };
  const user = git(root, "config user.name");
  return { name: (user && user.split(/\s+/)[0]) || "You", kind: "person" };
}

// ---------- runs ----------

const runsDir = (out) => path.join(out, "runs");
const SAFE_ID = /^[A-Za-z0-9-]+$/;

/**
 * Keep a copy of the run that just finished (its manifest and screens, already written at the top of `out`)
 * under runs/<runId>/, then prune to the newest KEEP_RUNS. `git` ({ branch, commit, subject }) replaces reading the
 * checkout, for data assembled elsewhere (the demo).
 */
export function recordRun(out, { root, config, manifest, startedAt, finishedAt = new Date().toISOString(), by, env = process.env, git: gitOverride = null }) {
  const info = gitOverride || gitInfo(root, env);
  const commit = manifest.commit ?? info.commit;
  let id = `${stamp(startedAt)}-${commit || "nocommit"}`;
  for (let n = 2; fs.existsSync(path.join(runsDir(out), id)); n++) id = `${stamp(startedAt)}-${commit || "nocommit"}-${n}`;
  const dir = path.join(runsDir(out), id);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(path.join(out, "screens"))) fs.cpSync(path.join(out, "screens"), path.join(dir, "screens"), { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const run = {
    schemaVersion: SCHEMA_VERSION,
    id,
    status: runStatus(manifest),
    title: info.subject || "No commit",
    pr: parsePr(env, info.subject),
    branch: info.branch,
    commit,
    by: by || resolveBy({ env, root }),
    shots: manifest.shots.length,
    problems: manifest.problems.filter((p) => p.kind !== "stand-in").length,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    devices: config.devices.map((d) => d.name),
    schemes: config.schemes,
    flows: flowDetail(config, manifest),
  };
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run, null, 2));
  pruneRuns(out);
  return run;
}

/** Delete run folders beyond the newest `keep`. */
export function pruneRuns(out, keep = KEEP_RUNS) {
  const ids = runIds(out);
  for (const id of ids.slice(keep)) fs.rmSync(path.join(runsDir(out), id), { recursive: true, force: true });
  return ids.slice(keep);
}

/** Run folder names, newest first (they start with a UTC timestamp, so name order is time order). */
function runIds(out) {
  if (!fs.existsSync(runsDir(out))) return [];
  return fs.readdirSync(runsDir(out), { withFileTypes: true }).filter((e) => e.isDirectory() && SAFE_ID.test(e.name)).map((e) => e.name).sort().reverse();
}

function loadRun(out, id) {
  if (!SAFE_ID.test(String(id))) return null;
  const dir = path.join(runsDir(out), id);
  const run = readJson(path.join(dir, "run.json"), null);
  if (!run) return null;
  return { run, manifest: readJson(path.join(dir, "manifest.json"), { shots: [], problems: [] }) };
}

/** All recorded runs, newest first, with the list fields only. */
export function listRuns(out) {
  return runIds(out).map((id) => loadRun(out, id)?.run).filter(Boolean).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(listEntry);
}

/** One run with its flows, shot tiles and problems; null for an unknown id. */
export function readRun(out, id) {
  const loaded = loadRun(out, id);
  if (!loaded) return null;
  return runDetail(loaded.run, problemsOfRun(out, loaded.run.id));
}

// ---------- problems ----------

/** Problems across the PROBLEM_RUNS newest runs, newest first, with seen state. */
export function listProblems(out) {
  const loaded = runIds(out).slice(0, PROBLEM_RUNS + 1).map((id) => loadRun(out, id)).filter(Boolean);
  return problemsAcross(loaded, readState(out));
}

/** Problems of one run (any run on disk, not only the newest PROBLEM_RUNS). */
export function problemsOfRun(out, id) {
  const ids = runIds(out);
  const i = ids.indexOf(id);
  if (i < 0) return [];
  const previous = ids.slice(i + 1).map((x) => loadRun(out, x)).find(Boolean);
  return withSeen(runProblems(loadRun(out, id), previous), readState(out));
}

// ---------- state ----------

export function readState(out) {
  const s = readJson(path.join(out, "state.json"), {});
  return { ...s, seenProblems: Array.isArray(s.seenProblems) ? s.seenProblems : [], unseenProblems: Array.isArray(s.unseenProblems) ? s.unseenProblems : [] };
}

/** Mark a problem seen or not. unseenProblems keeps an explicit "not seen" on a stand-in that is seen by default. */
export function setSeen(out, id, seen) {
  const state = readState(out);
  const without = (list) => list.filter((x) => x !== id);
  state.seenProblems = seen ? [...without(state.seenProblems), id] : without(state.seenProblems);
  state.unseenProblems = seen ? without(state.unseenProblems) : [...without(state.unseenProblems), id];
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "state.json"), JSON.stringify(state, null, 2));
  return state;
}

// ---------- captures ----------

const capturesFile = (out) => path.join(out, "captures", "index.jsonl");

/** Append one capture. `file` is relative to `out` (or absolute). */
export function appendCapture(out, { kind, file, route = null, flow = null, device = null, scheme = null, by, at = new Date().toISOString(), seconds = null, standIns = [], state = null, seeded = false, secrets = [] }) {
  const n = readLines(capturesFile(out)).length + 1;
  const rel = path.isAbsolute(file) ? path.relative(out, file) : file;
  const line = { id: `c_${stamp(at)}_${n}`, kind, file: rel.split(path.sep).join("/"), route, flow, device, scheme, by, at, seconds, standIns, state, seeded, secrets };
  appendLine(capturesFile(out), line);
  return line;
}

/** Record what `imitor screenshot`, `imitor flow` or `imitor record` (or their MCP tools) produced. Paths in `result` are relative to `root`. */
export function recordCaptures(out, root, command, result, by) {
  const abs = (f) => path.join(root, f);
  const made = { state: result.state ?? null, seeded: result.seeded === true, secrets: Array.isArray(result.secrets) ? result.secrets : [] };
  if (command === "screenshot") return [appendCapture(out, { kind: "screenshot", file: abs(result.file), route: result.route, flow: result.flow ?? null, device: result.device, scheme: result.scheme, by, standIns: result.standIns, ...made })];
  if (command === "flow") return result.shots.map((s) => appendCapture(out, { kind: "screenshot", file: abs(s.file), route: s.route, flow: result.flow, device: result.device, scheme: result.scheme, by, standIns: s.standIns, ...made }));
  if (command === "record") return [appendCapture(out, { kind: "video", file: abs(result.file), route: null, flow: result.flow, device: result.device, scheme: result.scheme, by, seconds: result.seconds, standIns: [], ...made })];
  throw new Error(`unknown capture command ${command}`);
}

/** Captures, newest first, with /files/ URLs. */
export function listCaptures(out) {
  return captureEntries(readLines(capturesFile(out)));
}

// ---------- activity and agents ----------

const activityFile = (out) => path.join(out, "activity.jsonl");

export function appendActivity(out, { at = new Date().toISOString(), by, tool, text, ok = true }) {
  const line = { at, by, tool, text, ok };
  appendLine(activityFile(out), line);
  return line;
}

/** Connect commands, tools, connections from the last 7 days of activity, and the latest 50 calls. */
export function agentsData(out, tools, now = new Date()) {
  return agentsSummary(readLines(activityFile(out)), tools, now);
}
