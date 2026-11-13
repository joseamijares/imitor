// What the review interface reads, for one project of the cloud: the same responses as the local server's /api/*
// (src/appserver.mjs apiGet), built with the same functions from src/derive.mjs over the runs in the database instead
// of the output folder. Only ready runs are shown. Inside each run.json the cloud's run id replaces the id it had on
// the machine that pushed it, so file URLs (/p/<slug>/files/runs/<id>/...) and problem ids name the cloud's run.
import { agentsSummary, captureEntries, listEntry, PROBLEM_RUNS, problemsAcross, runDetail, runProblems, withSeen } from "../../src/derive.mjs";
import { DEVICES, NOT_COVERED } from "../../src/config.mjs";
import { TOOLS } from "../../src/tools.mjs";

export const filesPrefix = (slug) => `/p/${slug}/files/`;

/** A run record as derive.mjs reads it: { run, manifest }, with the cloud's id. */
const loaded = (record) => ({ run: { ...record.run, id: record.id }, manifest: record.manifest, record });

/** The project's ready runs, newest first by when they started (the order the local server lists them in). */
export async function readyRuns(db, projectId) {
  const runs = (await db.listRuns(projectId, { status: "ready" })).map(loaded);
  return runs.sort((a, b) => String(b.run.startedAt).localeCompare(String(a.run.startedAt)) || b.run.id.localeCompare(a.run.id));
}

/** { seenProblems, unseenProblems } for a person, as state.json holds them locally. */
export async function seenState(db, projectId, userId) {
  const marks = await db.listSeen(projectId, userId);
  return { seenProblems: marks.filter((m) => m.seen).map((m) => m.problemId), unseenProblems: marks.filter((m) => !m.seen).map((m) => m.problemId) };
}

/**
 * GET /api/project. The cloud has runs, not the app's folder: devices, schemes and flows are those of the newest run,
 * and there is no web build, so no live preview.
 */
function projectBody(project, runs) {
  const newest = runs[0]?.run;
  const flows = [];
  for (const f of newest?.flows || []) {
    if (flows.some((x) => x.name === f.name)) continue;
    const { name, status, device, scheme, steps, ...state } = f;
    flows.push({ name, start: null, after: state.after ?? null, state: state.state ?? null, seeded: state.seeded === true, clock: state.clock ?? null, secrets: Array.isArray(state.secrets) ? state.secrets : [], chain: { start: null, before: [] }, steps: (steps || []).map((s) => ({ index: s.index, action: "shot", label: s.name, step: { shot: s.name } })) });
  }
  return {
    name: project.name,
    branch: newest?.branch ?? null,
    commit: newest?.commit ?? null,
    built: false,
    previewUrl: null,
    builtAt: null,
    previewAppearance: false,
    devices: (newest?.devices || []).map((n) => ({ name: n, width: DEVICES[n]?.width ?? null, height: DEVICES[n]?.height ?? null, platform: DEVICES[n]?.platform || null })),
    schemes: newest?.schemes || [],
    flows,
    standIns: [],
    notCovered: NOT_COVERED,
  };
}

/** Every line of `kind` that came with the ready runs, oldest run first; capture files made relative to the runs folder. */
async function linesOf(db, runs, kind) {
  const out = [];
  for (const r of [...runs].reverse()) {
    const lines = await db.listLines(kind, r.run.id);
    out.push(...(kind === "captures" ? lines.map((c) => ({ ...c, file: c.file ? `runs/${r.run.id}/${c.file}` : c.file })) : lines));
  }
  return out;
}

/**
 * The body of a GET route of the interface's API for `project`, as seen by `userId`. Returns { status, body }, or
 * null for no such endpoint. opts: { now }.
 */
export async function readRoute(db, project, userId, route, { now = new Date() } = {}) {
  const prefix = filesPrefix(project.slug);
  const runs = await readyRuns(db, project.id);
  if (route === "/api/project") return { status: 200, body: projectBody(project, runs) };
  if (route === "/api/runs") return { status: 200, body: { runs: runs.map((r) => listEntry(r.run)) } };
  const m = /^\/api\/runs\/([^/]+)$/.exec(route);
  if (m) {
    const i = runs.findIndex((r) => r.run.id === m[1]);
    if (i < 0) return { status: 404, body: { error: `no run ${m[1]}` } };
    const problems = withSeen(runProblems(runs[i], runs[i + 1], prefix), await seenState(db, project.id, userId));
    return { status: 200, body: runDetail(runs[i].run, problems, prefix) };
  }
  if (route === "/api/problems") return { status: 200, body: { problems: problemsAcross(runs.slice(0, PROBLEM_RUNS + 1), await seenState(db, project.id, userId), prefix) } };
  if (route === "/api/captures") return { status: 200, body: { captures: captureEntries(await linesOf(db, runs, "captures"), prefix) } };
  if (route === "/api/agents") return { status: 200, body: agentsSummary(await linesOf(db, runs, "activity"), TOOLS, now) };
  return null;
}

/**
 * The problems of one run record that its Problems tab counts (failed flows, page errors, dialogs, seed problems; not
 * stand-ins, which it lists but does not count): what the run's page shows as its number of problems. They do not
 * depend on the run before it, so none is needed.
 */
export const runFailures = (record) => runProblems(loaded(record), null).filter((p) => p.kind !== "stand-in");

/** The run a problem id belongs to, among the project's ready runs, or null. */
export async function problemRun(db, project, problemId) {
  const runs = await readyRuns(db, project.id);
  for (const [i, r] of runs.entries()) if (runProblems(r, runs[i + 1]).some((p) => p.id === problemId)) return r.record;
  return null;
}
