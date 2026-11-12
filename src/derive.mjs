// What the interface shows, derived from a run's run.json and manifest.json without touching the disk, so the same
// code can serve runs from the output folder (store.mjs) or from anywhere else they are kept.
// File links are built with a URL prefix, "/files/" by default (the local server's file route).
import crypto from "node:crypto";
import path from "node:path";
import { stateInfo } from "./state.mjs";

/** The run.json format written by this version. A run.json without schemaVersion is version 1. */
export const SCHEMA_VERSION = 1;
export const PROBLEM_RUNS = 20;

export const schemaVersionOf = (run) => run?.schemaVersion ?? 1;

/** The URL of a file at `rel` (a path relative to the output folder), or null. */
export const fileUrl = (rel, prefix = "/files/") => (rel ? prefix + rel.split(path.sep).map(encodeURIComponent).join("/") : null);

/** The URL of a file at `rel` inside a run's folder, or null. */
const runFileUrl = (run, rel, prefix) => fileUrl(rel && path.join("runs", run.id, rel), prefix);

/** "first-run / iphone-16 / light" from manifests written before problems carried these fields. */
export function locate(problem) {
  const [flow, device, scheme] = String(problem.where || "").split(" / ");
  return { flow: problem.flow ?? flow ?? null, device: problem.device ?? device ?? null, scheme: problem.scheme ?? scheme ?? null };
}

/** One entry per flow, device and scheme, with a tile per shot step. Paths are relative to the run folder. */
export function flowDetail(config, manifest) {
  const flows = [];
  for (const flow of config.flows) {
    const shotSteps = (flow.steps || []).map((step, i) => ({ step, index: i + 1 })).filter((s) => s.step.shot);
    for (const device of config.devices) {
      for (const scheme of config.schemes) {
        const here = (x) => x.flow === flow.name && x.device === device.name && x.scheme === scheme;
        const failure = manifest.problems.find((p) => p.kind === "flow-failed" && here(locate(p)));
        let failedMarked = false;
        const steps = shotSteps.map(({ step, index }) => {
          const shot = manifest.shots.find((s) => here(s) && s.shot === step.shot);
          // state and seeded: whether the shot shows invented data (a state label for the stand-ins, or a seed).
          if (shot) return { index, name: step.shot, status: shot.stubs.length ? "stand-in" : "ok", shot: shot.file, route: shot.route, standIns: shot.stubs, state: shot.state ?? null, seeded: shot.seeded === true };
          if (failure && !failedMarked && (failure.step == null || index >= failure.step)) {
            failedMarked = true;
            return { index, name: step.shot, status: "failed", shot: failure.file || null, route: null, standIns: [] };
          }
          return { index, name: step.shot, status: "not-reached", shot: null, route: null, standIns: [] };
        });
        const status = failure ? "failed" : steps.some((s) => s.status === "stand-in") ? "stand-ins" : "passed";
        flows.push({ name: flow.name, status, device: device.name, scheme, ...stateInfo(flow), steps });
      }
    }
  }
  return flows;
}

export function runStatus(manifest) {
  if (manifest.problems.some((p) => p.kind === "flow-failed" || p.kind === "seed-failed")) return "failed";
  if (manifest.shots.some((s) => s.stubs.length)) return "stand-ins";
  return "passed";
}

const LIST_FIELDS = ["id", "status", "title", "pr", "branch", "commit", "by", "shots", "problems", "startedAt", "finishedAt"];

/** A run.json reduced to the fields the run list shows. */
export const listEntry = (run) => Object.fromEntries(LIST_FIELDS.map((k) => [k, run[k] ?? null]));

/** One run with its flows and shot tiles, given its problems (see runProblems and withSeen). */
export function runDetail(run, problems, prefix = "/files/") {
  const url = (rel) => runFileUrl(run, rel, prefix);
  return {
    run: listEntry(run),
    devices: run.devices,
    schemes: run.schemes,
    flows: run.flows.map((f) => ({ ...f, steps: f.steps.map((s) => ({ ...s, shot: url(s.shot) })) })),
    problems,
  };
}

// ---------- problems ----------

export const problemId = (runId, kind, flow, device, scheme, message) =>
  "p_" + crypto.createHash("sha1").update(JSON.stringify([runId, kind, flow, device, scheme, message])).digest("hex").slice(0, 12);

/**
 * Problems of one run ({ run, manifest }), before seen state is applied. `previous` is the run before it, for
 * new-stand-in detection.
 */
export function runProblems(loaded, previous, prefix = "/files/") {
  const { run, manifest } = loaded;
  const url = (rel) => runFileUrl(run, rel, prefix);
  const ref = { id: run.id, pr: run.pr, commit: run.commit, title: run.title };
  const out = [];
  for (const p of manifest.problems) {
    if (p.kind !== "flow-failed" && p.kind !== "page-error" && p.kind !== "dialog" && p.kind !== "seed-failed") continue;
    const { flow, device, scheme } = locate(p);
    const failed = p.kind === "flow-failed";
    out.push({
      id: problemId(run.id, p.kind, flow, device, scheme, p.message),
      kind: p.kind,
      title: failed ? (p.step ? `${flow} failed at step ${p.step}` : `${flow} failed before its first step`) : p.kind === "dialog" ? `Dialog in ${flow}${p.step ? ` at step ${p.step}` : ""}` : p.kind === "seed-failed" ? `Seed problem in ${flow}` : `Page error in ${flow}`,
      run: ref,
      device,
      scheme,
      at: run.finishedAt,
      autoSeen: false,
      detail: {
        message: p.message,
        flow,
        step: failed ? p.step ?? null : null,
        stepConfig: failed ? p.stepConfig ?? null : null,
        lastGoodShot: failed ? url(p.lastGoodShot) : null,
        failureShot: failed ? url(p.file) : null,
      },
    });
  }
  const before = new Set(previous ? previous.manifest.shots.flatMap((s) => s.stubs) : []);
  const kinds = [...new Set(manifest.shots.flatMap((s) => s.stubs))];
  for (const kind of kinds) {
    const shots = manifest.shots.filter((s) => s.stubs.includes(kind));
    out.push({
      id: problemId(run.id, "stand-in", null, null, null, kind),
      kind: "stand-in",
      title: `${kind} stand-in on ${shots.length} shot${shots.length === 1 ? "" : "s"}`,
      run: ref,
      device: null,
      scheme: null,
      at: run.finishedAt,
      autoSeen: before.has(kind), // only a stand-in that is new compared with the previous run asks for attention
      detail: { message: `${kind} stand-in`, flow: null, step: null, stepConfig: null, lastGoodShot: null, failureShot: null, standIn: kind, shots: shots.map((s) => url(s.file)) },
    });
  }
  return out;
}

/** Problems with `seen` set from a state ({ seenProblems, unseenProblems }). */
export function withSeen(problems, state) {
  const seen = new Set(state.seenProblems);
  const unseen = new Set(state.unseenProblems);
  return problems.map(({ autoSeen, ...p }) => ({ ...p, seen: seen.has(p.id) || (autoSeen && !unseen.has(p.id)) }));
}

/** Problems across the PROBLEM_RUNS newest of `loaded` (runs newest first, one extra for the oldest's previous), newest first. */
export function problemsAcross(loaded, state, prefix = "/files/") {
  const problems = loaded.slice(0, PROBLEM_RUNS).flatMap((run, i) => runProblems(run, loaded[i + 1], prefix));
  return withSeen(problems, state).sort((a, b) => b.at.localeCompare(a.at));
}

// ---------- captures, activity and agents ----------

/** Capture lines, newest first, with file URLs. */
export const captureEntries = (lines, prefix = "/files/") => lines.map((c) => ({ ...c, file: fileUrl(c.file, prefix) })).reverse();

export const CONNECT_COMMANDS = {
  "Claude Code": "claude mcp add imitor -- npx imitor mcp",
  Cursor: "npx imitor mcp",
  Codex: "codex mcp add imitor -- npx imitor mcp",
  Other: "npx imitor mcp",
  CI: "npx imitor",
};

/** Connect commands, tools, connections from the last 7 days of activity `lines`, and the latest 50 calls. */
export function agentsSummary(lines, tools, now = new Date()) {
  const weekAgo = now.getTime() - 7 * 24 * 3600 * 1000;
  const dayAgo = now.getTime() - 24 * 3600 * 1000;
  const connections = new Map();
  for (const line of lines) {
    const t = new Date(line.at).getTime();
    if (!(t >= weekAgo) || !line.by?.name) continue;
    const c = connections.get(line.by.name) || { name: line.by.name, kind: line.by.kind, calls24h: 0, lastAt: line.at, active: false };
    if (t >= dayAgo) c.calls24h++; // a rolling day, so the count does not drop to zero at midnight
    if (line.at > c.lastAt) c.lastAt = line.at;
    connections.set(line.by.name, c);
  }
  for (const c of connections.values()) c.active = now.getTime() - new Date(c.lastAt).getTime() < 2 * 60 * 1000;
  return {
    commands: CONNECT_COMMANDS,
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
    connections: [...connections.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
    activity: lines.slice(-50).reverse(),
  };
}
