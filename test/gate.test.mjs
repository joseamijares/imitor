import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluate, formatMarkdown, formatText, reportToGitHub } from "../src/gate.mjs";

const shot = (file, stubs = []) => ({ file, stubs });
const clean = { commit: "abc1234", shots: [shot("screens/a.png"), shot("screens/b.png")], problems: [] };
const withStandIn = { ...clean, shots: [shot("screens/a.png", ["skia"]), shot("screens/b.png")] };
const failed = {
  commit: "abc1234",
  shots: [shot("screens/a.png")],
  problems: [
    { kind: "flow-failed", where: "log / iphone-16 / dark", flow: "log", device: "iphone-16", scheme: "dark", step: 3, stepConfig: { tap: "Add 250 ml" }, message: "locator.click: Timeout 10000ms exceeded.", file: "screens/log-FAILED-iphone-16-dark.png" },
    { kind: "page-error", where: "log / iphone-16 / dark", flow: "log", device: "iphone-16", scheme: "dark", message: "TypeError: x is | not a function" },
  ],
};

test("a clean run passes; a failed flow blocks and says where and why", () => {
  assert.equal(evaluate(clean).passed, true);
  const v = evaluate(failed);
  assert.equal(v.passed, false);
  assert.deepEqual(v.reasons, ["1 flow failed"]);
  assert.deepEqual(v.failedFlows[0], { where: "log on iphone-16, dark", step: 3, doing: 'tapping "Add 250 ml"', message: "locator.click: Timeout 10000ms exceeded.", shot: "screens/log-FAILED-iphone-16-dark.png" });
});

test("--fail-on widens what blocks: page errors, then stand-ins", () => {
  const onlyError = { ...clean, problems: [failed.problems[1]] };
  assert.equal(evaluate(onlyError).passed, true);
  assert.deepEqual(evaluate(onlyError, { failOn: "errors" }).reasons, ["1 page error"]);
  assert.equal(evaluate(withStandIn).passed, true);
  assert.equal(evaluate(withStandIn, { failOn: "errors" }).passed, true);
  assert.deepEqual(evaluate(withStandIn, { failOn: "stand-ins" }).reasons, ["1 shot with a stand-in"]);
  assert.deepEqual(evaluate(withStandIn).standIns, ["skia"]);
  assert.throws(() => evaluate(clean, { failOn: "vibes" }), /--fail-on must be one of/);
});

test("a run with no shots does not pass silently", () => {
  const v = evaluate({ shots: [], problems: [] });
  assert.equal(v.passed, false);
  assert.match(v.reasons[0], /no shots were taken/);
});

test("old manifests without flow details still read sensibly", () => {
  const v = evaluate({ shots: [shot("a.png")], problems: [{ kind: "flow-failed", where: "first-run / iphone-16 / light", message: "boom", file: "x.png" }] });
  assert.equal(v.failedFlows[0].where, "first-run / iphone-16 / light");
  assert.match(formatText(v), /stopped at step \? while opening the start route/);
});

test("text and Markdown summaries carry the verdict, the reasons and the honest limit", () => {
  const pass = formatText(evaluate(withStandIn), "preview/index.html");
  assert.match(pass, /^Imitor gate: PASSED/);
  assert.match(pass, /stand-ins seen: skia/);
  assert.match(pass, /does not test the native build/);
  const block = formatText(evaluate(failed, { failOn: "errors" }), "preview/index.html");
  assert.match(block, /^Imitor gate: BLOCKED \(1 flow failed; 1 page error\)/);
  assert.match(block, /x log on iphone-16, dark: stopped at step 3 while tapping "Add 250 ml"/);
  const md = formatMarkdown(evaluate(failed, { failOn: "errors" }), "preview/index.html");
  assert.match(md, /### Imitor gate: blocked/);
  assert.match(md, /\| log on iphone-16, dark \| step 3 \| tapping "Add 250 ml" \|/);
  assert.match(md, /x is \\\| not a function/); // table cells escape pipes
});

test("GitHub Actions: writes the job summary, the outputs and error annotations", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-gate-"));
  const env = { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: path.join(dir, "summary.md"), GITHUB_OUTPUT: path.join(dir, "out.txt") };
  const lines = [];
  const wrote = reportToGitHub(evaluate(failed), "preview/index.html", env, (s) => lines.push(s));
  assert.deepEqual(wrote, ["summary", "outputs", "annotations"]);
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), /Imitor gate: blocked/);
  const out = fs.readFileSync(env.GITHUB_OUTPUT, "utf8");
  assert.match(out, /^passed=false$/m);
  assert.match(out, /^failed-flows=1$/m);
  assert.match(out, /^report=preview\/index.html$/m);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^::error title=Imitor: flow failed::log on iphone-16, dark stopped at step 3/);
  assert.deepEqual(reportToGitHub(evaluate(clean), null, {}, () => {}), []);
});

// End to end through the CLI, against a static page standing in for a built preview.
let hasPlaywright = true;
try { createRequire(import.meta.url)("playwright"); } catch { hasPlaywright = false; }
const browser = { skip: hasPlaywright ? false : "playwright is not installed" };
const cli = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bin", "imitor.mjs");
function project(flows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-gate-cli-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-app" }));
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify({ schemes: ["light"], flows }));
  fs.mkdirSync(path.join(root, "preview", "app"), { recursive: true });
  fs.writeFileSync(path.join(root, "preview", "app", "index.html"), `<!doctype html><body><h1 id="t">First screen</h1><button onclick="document.getElementById('t').textContent='Second screen'">Continue</button></body>`);
  return root;
}

test("imitor gate --no-build exits 0 on a passing run and 1 on a failing one", browser, () => {
  const good = project([{ name: "welcome", start: "/", steps: [{ shot: "start" }, { tap: "Continue" }, { shot: "second" }] }]);
  const ok = spawnSync("node", [cli, "gate", "--no-build", "--json"], { cwd: good, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  const verdict = JSON.parse(ok.stdout);
  assert.equal(verdict.passed, true);
  assert.equal(verdict.shots, 2);
  assert.equal(verdict.report, path.join("preview", "index.html"));

  const bad = project([{ name: "broken", start: "/", steps: [{ shot: "start" }, { tap: "No such button" }, { shot: "never" }] }]);
  const blocked = spawnSync("node", [cli, "gate", "--no-build"], { cwd: bad, encoding: "utf8" });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /Imitor gate: BLOCKED \(1 flow failed\)/);
  assert.match(blocked.stdout, /stopped at step 2 while tapping "No such button"/);
});

test("imitor gate rejects a bad --fail-on before doing any work", () => {
  const r = spawnSync("node", [cli, "gate", "--no-build", "--fail-on", "vibes"], { cwd: project([]), encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--fail-on must be one of flows, errors, stand-ins/);
});

test("a flow that failed inside a flow it runs after says which flow and step, not step 0", () => {
  const msg = "locator.click: Timeout 10000ms exceeded.";
  const at = { kind: "flow-failed", flow: "log", device: "iphone-16", scheme: "dark", file: "screens/log-FAILED-iphone-16-dark.png" };
  const v = evaluate({
    shots: [shot("screens/a.png")],
    problems: [
      { ...at, step: 0, stepConfig: { tap: "Continue" }, message: `in "welcome", which this flow runs after, step 2: ${msg}`, error: msg, after: { flow: "welcome", step: 2 } },
      { ...at, step: 0, stepConfig: { goto: "/log" }, message: `opening its start /log, after the flows it runs after: ${msg}`, error: msg, after: { flow: "log", step: 0 } },
      { ...at, step: 0, stepConfig: { goto: "/name" }, message: `in "name", which this flow runs after, opening /name: ${msg}`, after: { flow: "name", step: 0 } },
    ],
  });
  const text = formatText(v);
  assert.match(text, /x log on iphone-16, dark: stopped at step 2 of "welcome" \(which it runs after\) while tapping "Continue"\. locator\.click: Timeout/);
  assert.match(text, /stopped at its own start \(after the flows it runs after\) while going to "\/log"\. locator/);
  // An older problem without `error` keeps its full message.
  assert.match(text, /stopped at the start of "name" \(which it runs after\) while going to "\/name"\. in "name", which this flow runs after/);
  assert.ok(!/step 0/.test(text));
  assert.match(formatMarkdown(v), /\| step 2 of "welcome" \(which it runs after\) \| tapping "Continue" \|/);
});
