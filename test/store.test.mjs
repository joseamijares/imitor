import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import {
  agentsData, appendActivity, appendCapture, clientDisplayName, listCaptures, listProblems, listRuns, parsePr,
  pruneRuns, readRun, readState, recordCaptures, recordRun, resolveBy, setSeen,
} from "../src/store.mjs";

// An invented plant-care app, "fernwood", with one flow of three shots.
const CONFIG = {
  shims: { "expo-sqlite": "sqljs", "@shopify/react-native-skia": "skia" },
  devices: ["iphone-16"],
  schemes: ["light", "dark"],
  flows: [{ name: "first-run", start: "/", steps: [{ shot: "01-welcome" }, { tap: "Continue" }, { shot: "02-plants" }, { tap: "Add fern" }, { shot: "03-today" }] }],
};
const NOBODY = { HOME: "/nonexistent" }; // no CI, no agent variables

function fixture({ git = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-store-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fernwood" }));
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify(CONFIG));
  if (git) {
    const run = (cmd) => execSync(cmd, { cwd: root, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "Ada Lovelace", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "Ada Lovelace", GIT_COMMITTER_EMAIL: "a@example.com" } });
    run("git init -q -b feat/larger-targets");
    run("git config user.name 'Ada Lovelace'");
    run(`git commit -q --allow-empty -m ${JSON.stringify(git)}`);
  }
  const out = path.join(root, "preview");
  fs.mkdirSync(path.join(out, "screens"), { recursive: true });
  return { root, out, config: loadConfig(root) };
}

const shot = (name, scheme, stubs = []) => ({ file: `screens/first-run-${name}-iphone-16-${scheme}.png`, flow: "first-run", shot: name, device: "iphone-16", platform: "ios", width: 393, height: 852, scheme, route: `/${name}`, stubs });

/** Write a manifest and its screens at the top of `out`, as `imitor shoot` does, then record the run. */
function fakeRun(f, { shots, problems = [], startedAt, by = { name: "Ada", kind: "person" }, env = NOBODY }) {
  fs.rmSync(path.join(f.out, "screens"), { recursive: true, force: true });
  fs.mkdirSync(path.join(f.out, "screens"), { recursive: true });
  for (const s of shots) fs.writeFileSync(path.join(f.out, s.file), "png");
  for (const p of problems) if (p.file) fs.writeFileSync(path.join(f.out, p.file), "png");
  const manifest = { tool: "imitor", app: "fernwood", commit: null, generatedAt: startedAt, shims: CONFIG.shims, shots, problems, notCovered: [] };
  fs.writeFileSync(path.join(f.out, "manifest.json"), JSON.stringify(manifest));
  return recordRun(f.out, { root: f.root, config: f.config, manifest, startedAt, finishedAt: new Date(Date.parse(startedAt) + 30000).toISOString(), by, env });
}

const allShots = (stubs = []) => ["light", "dark"].flatMap((scheme) => ["01-welcome", "02-plants", "03-today"].map((n) => shot(n, scheme, n === "03-today" ? stubs : [])));
const failure = { where: "first-run / iphone-16 / dark", kind: "flow-failed", message: "locator.click: Timeout 10000ms exceeded.", file: "screens/first-run-FAILED-iphone-16-dark.png", flow: "first-run", device: "iphone-16", scheme: "dark", step: 4, stepConfig: { tap: "Add fern" }, lastGoodShot: "screens/first-run-02-plants-iphone-16-dark.png", notReached: ["03-today"] };

test("recordRun copies the run, sets status and list fields, and lists newest first", () => {
  const f = fixture();
  const passed = fakeRun(f, { shots: allShots(), startedAt: "2026-11-10T09:00:00.000Z" });
  assert.equal(passed.id, "20261110T090000-nocommit");
  assert.equal(passed.status, "passed");
  assert.equal(passed.title, "No commit");
  assert.equal(passed.pr, null);
  assert.equal(passed.shots, 6);
  assert.ok(fs.existsSync(path.join(f.out, "runs", passed.id, "screens", "first-run-01-welcome-iphone-16-light.png")));
  assert.ok(fs.existsSync(path.join(f.out, "runs", passed.id, "manifest.json")));

  const standIns = fakeRun(f, { shots: allShots(["skia"]), startedAt: "2026-11-10T10:00:00.000Z" });
  assert.equal(standIns.status, "stand-ins");
  assert.equal(standIns.problems, 0);

  const darkShots = allShots().filter((s) => !(s.scheme === "dark" && s.shot === "03-today"));
  const failed = fakeRun(f, { shots: darkShots, problems: [failure, { where: "first-run / iphone-16 / light", kind: "page-error", message: "TypeError: x is undefined", flow: "first-run", device: "iphone-16", scheme: "light" }], startedAt: "2026-11-10T11:00:00.000Z" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.problems, 2);

  const runs = listRuns(f.out);
  assert.deepEqual(runs.map((r) => r.id), [failed.id, standIns.id, passed.id]);
  assert.deepEqual(Object.keys(runs[0]), ["id", "status", "title", "pr", "branch", "commit", "by", "shots", "problems", "startedAt", "finishedAt"]);
  assert.deepEqual(runs[0].by, { name: "Ada", kind: "person" });
});

test("readRun gives one entry per flow, device and scheme with ok, stand-in, failed and not-reached tiles", () => {
  const f = fixture();
  const twoLeft = allShots(["skia"]).filter((s) => !(s.scheme === "dark" && s.shot !== "01-welcome"));
  const run = fakeRun(f, { shots: twoLeft, problems: [{ ...failure, step: 2, stepConfig: { tap: "Continue" }, lastGoodShot: "screens/first-run-01-welcome-iphone-16-dark.png", notReached: ["02-plants", "03-today"] }], startedAt: "2026-11-10T11:00:00.000Z" });
  const detail = readRun(f.out, run.id);
  assert.equal(detail.run.id, run.id);
  assert.deepEqual(detail.devices, ["iphone-16"]);
  assert.deepEqual(detail.schemes, ["light", "dark"]);
  assert.equal(detail.flows.length, 2);
  const [light, dark] = detail.flows;
  assert.equal(light.status, "stand-ins");
  assert.deepEqual(light.steps.map((s) => [s.index, s.name, s.status]), [[1, "01-welcome", "ok"], [3, "02-plants", "ok"], [5, "03-today", "stand-in"]]);
  assert.equal(light.steps[0].shot, `/files/runs/${run.id}/screens/first-run-01-welcome-iphone-16-light.png`);
  assert.equal(light.steps[0].route, "/01-welcome");
  assert.deepEqual(light.steps[2].standIns, ["skia"]);
  assert.equal(dark.status, "failed");
  assert.deepEqual(dark.steps.map((s) => s.status), ["ok", "failed", "not-reached"]);
  assert.equal(dark.steps[1].shot, `/files/runs/${run.id}/screens/first-run-FAILED-iphone-16-dark.png`);
  assert.equal(dark.steps[2].shot, null);
  assert.equal(detail.problems.length, 2); // the failure and the skia stand-in
  assert.equal(readRun(f.out, "20990101T000000-nope"), null);
  assert.equal(readRun(f.out, "../../etc"), null);
});

test("problems: flow failures, page errors and stand-ins, with stable ids and seen rules", () => {
  const f = fixture();
  const first = fakeRun(f, { shots: allShots(["skia"]), startedAt: "2026-11-10T09:00:00.000Z" });
  const second = fakeRun(f, { shots: allShots(["skia"]).filter((s) => !(s.scheme === "dark" && s.shot === "03-today")), problems: [failure], startedAt: "2026-11-10T10:00:00.000Z" });

  const problems = listProblems(f.out);
  assert.deepEqual(problems.map((p) => [p.run.id, p.kind]), [[second.id, "flow-failed"], [second.id, "stand-in"], [first.id, "stand-in"]]);
  const [failed, standInAgain, standInNew] = problems;
  assert.match(failed.id, /^p_[0-9a-f]{12}$/);
  assert.equal(failed.title, "first-run failed at step 4");
  assert.equal(failed.device, "iphone-16");
  assert.equal(failed.scheme, "dark");
  assert.equal(failed.seen, false);
  assert.deepEqual(failed.run, { id: second.id, pr: null, commit: null, title: "No commit" });
  assert.deepEqual(failed.detail, {
    message: "locator.click: Timeout 10000ms exceeded.", flow: "first-run", step: 4, stepConfig: { tap: "Add fern" },
    lastGoodShot: `/files/runs/${second.id}/screens/first-run-02-plants-iphone-16-dark.png`,
    failureShot: `/files/runs/${second.id}/screens/first-run-FAILED-iphone-16-dark.png`,
  });
  assert.equal(standInAgain.title, "skia stand-in on 1 shot"); // the dark 03-today shot was not reached
  assert.equal(standInAgain.seen, true, "a stand-in the previous run also had is seen automatically");
  assert.equal(standInNew.title, "skia stand-in on 2 shots");
  assert.equal(standInNew.seen, false, "a stand-in new compared with the previous run (none) needs a look");

  // Ids are stable across reads; seen state round-trips, including un-seeing an automatically seen stand-in.
  assert.deepEqual(listProblems(f.out).map((p) => p.id), problems.map((p) => p.id));
  setSeen(f.out, failed.id, true);
  setSeen(f.out, standInAgain.id, false);
  const after = listProblems(f.out);
  assert.equal(after[0].seen, true);
  assert.equal(after[1].seen, false);
  assert.deepEqual(readState(f.out).seenProblems, [failed.id]);
  setSeen(f.out, failed.id, false);
  setSeen(f.out, standInAgain.id, true);
  assert.equal(listProblems(f.out)[0].seen, false);
  assert.equal(listProblems(f.out)[1].seen, true);
  assert.deepEqual(readState(f.out).seenProblems, [standInAgain.id]);
});

test("problems: a dialog the app showed is listed with its flow and step", () => {
  const f = fixture();
  const run = fakeRun(f, { shots: allShots(), problems: [{ where: "first-run / iphone-16 / light", kind: "dialog", message: "alert: Error No connection", flow: "first-run", device: "iphone-16", scheme: "light", step: 4 }], startedAt: "2026-11-10T09:00:00.000Z" });
  const [dialog] = listProblems(f.out);
  assert.equal(dialog.kind, "dialog");
  assert.equal(dialog.run.id, run.id);
  assert.equal(dialog.title, "Dialog in first-run at step 4");
  assert.equal(dialog.detail.message, "alert: Error No connection");
});

test("problems from manifests written before problems carried flow, device and scheme", () => {
  const f = fixture();
  const run = fakeRun(f, { shots: [], problems: [{ where: "first-run / iphone-16 / light", kind: "flow-failed", message: "boom", file: "screens/first-run-FAILED-iphone-16-light.png" }], startedAt: "2026-11-10T09:00:00.000Z" });
  const [p] = listProblems(f.out);
  assert.equal(p.detail.flow, "first-run");
  assert.equal(p.scheme, "light");
  assert.equal(p.title, "first-run failed before its first step");
  const light = readRun(f.out, run.id).flows.find((x) => x.scheme === "light");
  assert.deepEqual(light.steps.map((s) => s.status), ["failed", "not-reached", "not-reached"]);
});

test("pr comes from GITHUB_REF, then a commit subject ending in (#n); title, branch and commit come from git", () => {
  assert.equal(parsePr({ GITHUB_REF: "refs/pull/118/merge" }, "Larger targets"), 118);
  assert.equal(parsePr({ GITHUB_REF: "refs/heads/main" }, "Larger targets (#119)"), 119);
  assert.equal(parsePr({}, "Larger targets (#119) and more"), null);
  assert.equal(parsePr({}, null), null);

  const f = fixture({ git: "Larger watering targets on Today (#118)" });
  const run = fakeRun(f, { shots: allShots(), startedAt: "2026-11-10T09:00:00.000Z" });
  assert.equal(run.title, "Larger watering targets on Today (#118)");
  assert.equal(run.pr, 118);
  assert.equal(run.branch, "feat/larger-targets");
  assert.match(run.commit, /^[0-9a-f]{7,}$/);
  assert.equal(run.id, `20261110T090000-${run.commit}`);
});

test("by: MCP client name, then IMITOR_AGENT, then GitHub Actions, then the git user's first name", () => {
  assert.deepEqual(resolveBy({ clientName: "claude-code", env: { IMITOR_AGENT: "x" } }), { name: "Claude Code", kind: "agent" });
  assert.equal(clientDisplayName("Cursor IDE"), "Cursor");
  assert.equal(clientDisplayName("codex-mcp-client"), "Codex");
  assert.equal(clientDisplayName("zed"), "zed");
  assert.deepEqual(resolveBy({ env: { IMITOR_AGENT: "Fern Bot", GITHUB_ACTIONS: "true" } }), { name: "Fern Bot", kind: "agent" });
  assert.deepEqual(resolveBy({ env: { GITHUB_ACTIONS: "true" } }), { name: "GitHub Actions", kind: "ci" });
  const f = fixture({ git: "init" });
  assert.deepEqual(resolveBy({ env: {}, root: f.root }), { name: "Ada", kind: "person" });
});

test("pruning keeps the newest runs", () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) fakeRun(f, { shots: [], startedAt: `2026-11-10T0${i}:00:00.000Z` });
  const removed = pruneRuns(f.out, 2);
  assert.deepEqual(removed, ["20261110T010000-nocommit", "20261110T000000-nocommit"]);
  assert.deepEqual(listRuns(f.out).map((r) => r.id), ["20261110T030000-nocommit", "20261110T020000-nocommit"]);
  for (let i = 0; i < 52; i++) fs.mkdirSync(path.join(f.out, "runs", `20250101T0000${String(i).padStart(2, "0")}-old`));
  fakeRun(f, { shots: [], startedAt: "2026-11-11T00:00:00.000Z" });
  assert.equal(fs.readdirSync(path.join(f.out, "runs")).length, 50);
  assert.ok(fs.existsSync(path.join(f.out, "runs", "20261111T000000-nocommit")));
});

test("captures: one line per screenshot, one per flow shot, one per video; newest first", () => {
  const f = fixture();
  const by = { name: "Claude Code", kind: "agent" };
  recordCaptures(f.out, f.root, "screenshot", { file: "preview/captures/today-iphone-16-light.png", route: "/today", device: "iphone-16", scheme: "light", standIns: ["skia"], flow: null }, by);
  recordCaptures(f.out, f.root, "flow", { flow: "first-run", device: "pixel-9", scheme: "dark", shots: [{ shot: "01-welcome", file: "preview/captures/first-run/01-welcome-pixel-9-dark.png", route: "/", standIns: [] }, { shot: "02-plants", file: "preview/captures/first-run/02-plants-pixel-9-dark.png", route: "/plants", standIns: [] }] }, by);
  recordCaptures(f.out, f.root, "record", { flow: "first-run", device: "iphone-16", scheme: "light", seconds: 18.2, file: "preview/captures/first-run-iphone-16-light.webm" }, by);
  appendCapture(f.out, { kind: "screenshot", file: path.join(f.out, "captures", "x.png"), by });
  const captures = listCaptures(f.out);
  assert.equal(captures.length, 5);
  assert.equal(captures[1].kind, "video");
  assert.equal(captures[1].seconds, 18.2);
  assert.equal(captures[1].file, "/files/captures/first-run-iphone-16-light.webm");
  const first = captures.at(-1);
  assert.match(first.id, /^c_\d{8}T\d{6}_1$/);
  assert.deepEqual(Object.keys(first), ["id", "kind", "file", "route", "flow", "device", "scheme", "by", "at", "seconds", "standIns"]);
  assert.equal(first.file, "/files/captures/today-iphone-16-light.png");
  assert.deepEqual(first.standIns, ["skia"]);
  assert.equal(captures[2].flow, "first-run");
  assert.equal(captures[2].route, "/plants");
});

test("agents: the call count is a rolling 24 hours, so it survives midnight", () => {
  const f = fixture();
  const claude = { name: "Claude Code", kind: "agent" };
  appendActivity(f.out, { at: "2026-11-11T23:50:00.000Z", by: claude, tool: "imitor_screenshot", text: "took a screenshot" });
  appendActivity(f.out, { at: "2026-11-11T23:55:00.000Z", by: claude, tool: "imitor_screenshot", text: "took a screenshot" });
  appendActivity(f.out, { at: "2026-11-10T22:00:00.000Z", by: claude, tool: "imitor_build", text: "built the preview" });
  const justAfterMidnight = agentsData(f.out, [], new Date("2026-11-12T00:10:00.000Z"));
  assert.equal(justAfterMidnight.connections[0].calls24h, 2);
});

test("agents: connections from the last 7 days, active within 2 minutes, latest 50 calls", () => {
  const f = fixture();
  const now = new Date("2026-11-11T12:00:00.000Z");
  const claude = { name: "Claude Code", kind: "agent" };
  const cursor = { name: "Cursor", kind: "agent" };
  appendActivity(f.out, { at: "2026-11-01T12:00:00.000Z", by: { name: "Old", kind: "agent" }, tool: "imitor_describe", text: "read the setup" });
  appendActivity(f.out, { at: "2026-11-09T12:00:00.000Z", by: cursor, tool: "imitor_build", text: "built the preview in 41 s" });
  for (let i = 0; i < 55; i++) appendActivity(f.out, { at: new Date(now.getTime() - (55 - i) * 1000).toISOString(), by: claude, tool: "imitor_screenshot", text: "took a screenshot of /today on iphone-16", ok: i !== 54 });
  const data = agentsData(f.out, [{ name: "imitor_build", description: "Build it.", inputSchema: {} }], now);
  assert.equal(data.commands["Claude Code"], "claude mcp add imitor -- npx imitor mcp");
  assert.deepEqual(data.tools, [{ name: "imitor_build", description: "Build it." }]);
  assert.deepEqual(data.connections.map((c) => [c.name, c.calls24h, c.active]), [["Claude Code", 55, true], ["Cursor", 0, false]]);
  assert.equal(data.activity.length, 50);
  assert.equal(data.activity[0].ok, false);
  assert.deepEqual(Object.keys(data.activity[0]), ["at", "by", "tool", "text", "ok"]);
});

test("MCP calls are logged to activity.jsonl under the client's name", async () => {
  const { createServer } = await import("../src/mcp.mjs");
  const f = fixture();
  const server = createServer(f.root);
  await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "1" } } });
  await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "imitor_describe" } });
  await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "imitor_read_problems" } });
  server.close();
  const { activity } = agentsData(f.out, []);
  assert.deepEqual(activity.map((a) => [a.by.name, a.by.kind, a.tool, a.ok]), [["Claude Code", "agent", "imitor_read_problems", false], ["Claude Code", "agent", "imitor_describe", true]]);
  assert.equal(activity[1].text, "read the setup: 1 flow, not built yet");
  assert.match(activity[0].text, /^tried to read problems: no run found/);
});
