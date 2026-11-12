import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import * as derive from "../src/derive.mjs";
import { agentsSummary, captureEntries, fileUrl, problemsAcross, runDetail, runProblems, schemaVersionOf, SCHEMA_VERSION } from "../src/derive.mjs";
import * as store from "../src/store.mjs";
import { agentsData, appendActivity, appendCapture, listCaptures, listProblems, listRuns, readRun, readState, recordRun } from "../src/store.mjs";

// An invented plant-care app, "fernwood": one flow, one device, two schemes.
const CONFIG = {
  devices: ["iphone-16"],
  schemes: ["light", "dark"],
  flows: [{ name: "first-run", start: "/", steps: [{ shot: "01-welcome" }, { tap: "Continue" }, { shot: "02-plants" }] }],
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-derive-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fernwood" }));
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify(CONFIG));
  const out = path.join(root, "preview");
  fs.mkdirSync(path.join(out, "screens"), { recursive: true });
  return { root, out, config: loadConfig(root) };
}

function record(f, startedAt, { stubs = [], fail = false } = {}) {
  const shots = ["light", "dark"].flatMap((scheme) => ["01-welcome", "02-plants"].filter((n) => !(fail && scheme === "dark" && n === "02-plants")).map((n) => ({ file: `screens/first-run-${n}-iphone-16-${scheme}.png`, flow: "first-run", shot: n, device: "iphone-16", scheme, route: `/${n}`, stubs: n === "02-plants" ? stubs : [] })));
  const problems = fail ? [{ where: "first-run / iphone-16 / dark", kind: "flow-failed", message: "locator.click: Timeout", file: "screens/first-run-FAILED-iphone-16-dark.png", flow: "first-run", device: "iphone-16", scheme: "dark", step: 2, stepConfig: { tap: "Continue" }, lastGoodShot: "screens/first-run-01-welcome-iphone-16-dark.png", notReached: ["02-plants"] }] : [];
  for (const s of [...shots, ...problems]) fs.writeFileSync(path.join(f.out, s.file), "png");
  return recordRun(f.out, { root: f.root, config: f.config, manifest: { commit: null, shots, problems }, startedAt, finishedAt: startedAt, by: { name: "Ada", kind: "person" }, env: {} });
}

test("store.mjs still exports what it exported before derive.mjs, as the same functions", () => {
  for (const name of ["CONNECT_COMMANDS", "PROBLEM_RUNS", "fileUrl", "flowDetail", "runStatus"]) assert.equal(store[name], derive[name], name);
  for (const name of ["KEEP_RUNS", "agentsData", "appendActivity", "appendCapture", "clientDisplayName", "gitInfo", "listCaptures", "listProblems", "listRuns", "parsePr", "problemsOfRun", "pruneRuns", "readRun", "readState", "recordCaptures", "recordRun", "resolveBy", "setSeen"]) assert.ok(name in store, name);
});

test("fileUrl takes a prefix, /files/ by default, and encodes each segment", () => {
  assert.equal(fileUrl("runs/x/screens/a b.png"), "/files/runs/x/screens/a%20b.png");
  assert.equal(fileUrl("runs/x/screens/a b.png", "https://cloud.example/v1/files/"), "https://cloud.example/v1/files/runs/x/screens/a%20b.png");
  assert.equal(fileUrl(null), null);
  assert.equal(fileUrl("", "/x/"), null);
});

test("the pure derivations give what the store gives, and use another prefix when asked", () => {
  const f = fixture();
  record(f, "2026-11-10T09:00:00.000Z");
  const second = record(f, "2026-11-10T10:00:00.000Z", { stubs: ["skia"], fail: true });
  const load = (id) => ({ run: JSON.parse(fs.readFileSync(path.join(f.out, "runs", id, "run.json"), "utf8")), manifest: JSON.parse(fs.readFileSync(path.join(f.out, "runs", id, "manifest.json"), "utf8")) });
  const ids = listRuns(f.out).map((r) => r.id);
  const loaded = ids.map(load);
  const state = readState(f.out);

  assert.deepEqual(problemsAcross(loaded, state), listProblems(f.out));
  const problems = problemsAcross(loaded, state).filter((p) => p.run.id === second.id);
  assert.deepEqual(runDetail(loaded[0].run, problems), readRun(f.out, second.id));

  const prefix = "/v1/projects/prj_1/files/";
  const detail = runDetail(loaded[0].run, problems, prefix);
  const shots = detail.flows.flatMap((fl) => fl.steps.map((s) => s.shot)).filter(Boolean);
  assert.ok(shots.length > 0 && shots.every((u) => u.startsWith(`${prefix}runs/${second.id}/screens/`)), shots.join(" "));
  const failed = runProblems(loaded[0], loaded[1], prefix).find((p) => p.kind === "flow-failed");
  assert.equal(failed.detail.failureShot, `${prefix}runs/${second.id}/screens/first-run-FAILED-iphone-16-dark.png`);
  assert.equal(failed.detail.lastGoodShot, `${prefix}runs/${second.id}/screens/first-run-01-welcome-iphone-16-dark.png`);
});

test("captureEntries and agentsSummary match listCaptures and agentsData", () => {
  const f = fixture();
  appendCapture(f.out, { kind: "screenshot", file: "captures/today.png", route: "/today", device: "iphone-16", scheme: "light", by: { name: "Claude Code", kind: "agent" } });
  appendActivity(f.out, { by: { name: "Claude Code", kind: "agent" }, tool: "imitor_screenshot", text: "took a screenshot of /today on iphone-16" });
  const lines = (file) => fs.readFileSync(path.join(f.out, file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(captureEntries(lines("captures/index.jsonl")), listCaptures(f.out));
  assert.equal(captureEntries(lines("captures/index.jsonl"), "/c/")[0].file, "/c/captures/today.png");
  const now = new Date();
  assert.deepEqual(agentsSummary(lines("activity.jsonl"), [{ name: "t", description: "d" }], now), agentsData(f.out, [{ name: "t", description: "d" }], now));
});

test("recordRun writes schemaVersion 1, and a run.json without one still reads as version 1", () => {
  const f = fixture();
  const run = record(f, "2026-11-10T09:00:00.000Z");
  assert.equal(SCHEMA_VERSION, 1);
  const file = path.join(f.out, "runs", run.id, "run.json");
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.schemaVersion, 1);
  assert.equal(schemaVersionOf(onDisk), 1);

  // A run recorded before schemaVersion existed.
  const before = readRun(f.out, run.id);
  const { schemaVersion, ...older } = onDisk;
  fs.writeFileSync(file, JSON.stringify(older, null, 2));
  assert.equal(schemaVersionOf(older), 1);
  assert.deepEqual(readRun(f.out, run.id), before);
  assert.deepEqual(listRuns(f.out).map((r) => r.id), [run.id]);
  assert.ok(!("schemaVersion" in listRuns(f.out)[0]), "the run list keeps its fields");
});
