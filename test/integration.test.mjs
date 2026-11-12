// Where features meet: flow state with the CanvasKit boot loader, and every surface that lists what Imitor can do.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { describe } from "../src/agent.mjs";
import { projectData, withDriver } from "../src/appserver.mjs";
import { bootSources, patchBuild } from "../src/build.mjs";
import { TOOLS } from "../src/mcp.mjs";
import { serve } from "../src/serve.mjs";
import { prepareContext } from "../src/state.mjs";

const require = createRequire(import.meta.url);
let hasPlaywright = true;
try { require("playwright"); } catch { hasPlaywright = false; }
const browser = { skip: hasPlaywright ? false : "playwright is not installed" };

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

/** An invented app ("fernwood") with a fake canvaskit-wasm next to its React Native Skia, and a config with flow state. */
function fernwood() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-int-"));
  write(path.join(root, "package.json"), JSON.stringify({ name: "fernwood" }));
  write(path.join(root, "node_modules/@shopify/react-native-skia/package.json"), JSON.stringify({ name: "@shopify/react-native-skia", dependencies: { "canvaskit-wasm": "0.40.0" } }));
  const ck = path.join(root, "node_modules/canvaskit-wasm");
  write(path.join(ck, "package.json"), JSON.stringify({ name: "canvaskit-wasm", version: "0.40.0" }));
  write(path.join(ck, "bin/full/canvaskit.js"), `var CanvasKitInit = function (opts) {
  return new Promise(function (ok) { setTimeout(ok, 100) }).then(function () { return fetch(opts.locateFile("canvaskit.wasm")) })
    .then(function (r) { return r.text() }).then(function (w) { return { fake: w.trim() } });
};`);
  write(path.join(ck, "bin/full/canvaskit.wasm"), "fake canvaskit\n");
  write(path.join(root, "imitor.config.json"), JSON.stringify({
    shims: { "expo-sqlite": "sqljs", "@shopify/react-native-skia": "canvaskit", "react-native-maps": "inert" },
    clock: "2026-03-14T09:30:00Z",
    flows: [
      { name: "welcome", steps: [{ shot: "first" }, { tap: "Continue" }] },
      { name: "today", after: "welcome", state: "signed-in", seed: { storage: { "onboarding-done": "true" } }, steps: [{ shot: "today" }] },
    ],
  }));
  return root;
}

test("describe, GET /api/project and the MCP tools carry what every feature added", () => {
  const root = fernwood();
  const d = describe(root);
  assert.deepEqual(d.flows.map(({ name, after, state, seeded, clock }) => ({ name, after, state, seeded, clock })), [
    { name: "welcome", after: null, state: null, seeded: false, clock: "2026-03-14T09:30:00.000Z" },
    { name: "today", after: "welcome", state: "signed-in", seeded: true, clock: "2026-03-14T09:30:00.000Z" },
  ]);
  assert.deepEqual(d.fidelity, { "expo-sqlite": "genuine", "@shopify/react-native-skia": "genuine", "react-native-maps": "stand-in" });

  const p = projectData(root, { git: { branch: "main", commit: "abc1234" } });
  const today = p.flows.find((f) => f.name === "today");
  assert.equal(today.after, "welcome");
  assert.equal(today.seeded, true);
  assert.equal(today.clock, "2026-03-14T09:30:00.000Z");
  assert.deepEqual(today.chain.before.map((b) => b.label || b.action), [p.flows[0].steps[1].label]);
  assert.deepEqual(p.standIns.map((s) => [s.kind, s.fidelity]), [["sqljs", "genuine"], ["canvaskit", "genuine"], ["inert", "stand-in"]]);

  const names = TOOLS.map((t) => t.name);
  assert.equal(names.length, 8);
  for (const n of ["imitor_init", "imitor_describe", "imitor_build", "imitor_screenshot", "imitor_run_flow", "imitor_record_video", "imitor_read_problems", "imitor_open_preview"]) assert.ok(names.includes(n), n);
  assert.equal(TOOLS.find((t) => t.name === "imitor_screenshot").inputSchema.properties.state.type, "string");
});

/** A build whose app script records what it found when it ran: the flow state, the seed, sql.js, CanvasKit, the clock. */
function build(root) {
  const appDir = path.join(root, "preview", "app");
  write(path.join(appDir, "index.html"), `<!doctype html><html><head><title>t</title></head><body><script src="/_expo/static/js/web/a.js" defer></script></body></html>`);
  write(path.join(appDir, "_expo/static/js/web/a.js"), `var i = globalThis.__imitor || {};
window.seen = { state: i.state, flow: i.flow, SQL: !!i.SQL, CanvasKit: globalThis.CanvasKit && globalThis.CanvasKit.fake, stored: localStorage.getItem("onboarding-done"), year: new Date().getUTCFullYear(), media: !!window.__imitorMedia };`);
  patchBuild(appDir, ["sqljs", "canvaskit"], bootSources(root, ["sqljs", "canvaskit"]));
  return appDir;
}

test("a run's state prelude survives the parallel boot loader: state, seed, sql.js, CanvasKit and the clock all reach the app", browser, async (t) => {
  const root = fernwood();
  const appDir = build(root);
  const config = JSON.parse(fs.readFileSync(path.join(root, "imitor.config.json"), "utf8"));
  const { chromium } = require("playwright");
  const server = await serve(appDir);
  t.after(() => server.close()); // registered before the launch, so a failed launch still closes the server
  const b = await chromium.launch();
  t.after(() => b.close());
  const context = await b.newContext();
  await prepareContext(context, { ...config.flows[1], clock: config.clock });
  const page = await context.newPage();
  await page.goto(server.url + "/");
  await page.waitForFunction(() => window.seen, null, { timeout: 5000 });
  assert.deepEqual(await page.evaluate(() => window.seen), { state: "signed-in", flow: "today", SQL: true, CanvasKit: "fake canvaskit", stored: "true", year: 2026, media: true });
});

test("the live preview's prelude survives the parallel boot loader too", browser, async (t) => {
  const root = fernwood();
  const appDir = build(root);
  const { chromium } = require("playwright");
  const server = await serve(appDir, { html: withDriver(["http://127.0.0.1:1"], root) });
  t.after(() => server.close()); // registered before the launch, so a failed launch still closes the server
  const b = await chromium.launch();
  t.after(() => b.close());
  const page = await b.newPage();
  await page.goto(server.url + "/?imitor-flow=today");
  await page.waitForFunction(() => window.seen, null, { timeout: 5000 });
  const seen = await page.evaluate(() => window.seen);
  assert.deepEqual({ ...seen, year: undefined }, { state: "signed-in", flow: "today", SQL: true, CanvasKit: "fake canvaskit", stored: "true", year: undefined, media: true });
});
