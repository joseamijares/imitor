import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { describe, runFlow, screenshot } from "../src/agent.mjs";
import { projectData } from "../src/appserver.mjs";
import { bootKinds, bootSources, patchBuild, patchHtml } from "../src/build.mjs";
import { loadConfig } from "../src/config.mjs";
import { evaluate } from "../src/gate.mjs";
import { serve } from "../src/serve.mjs";
import { shoot } from "../src/shoot.mjs";

const require = createRequire(import.meta.url);
let hasPlaywright = true;
try { require("playwright"); } catch { hasPlaywright = false; }
const browser = { skip: hasPlaywright ? false : "playwright is not installed" };

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "imitor-boot-"));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

/**
 * An app folder with a fake canvaskit-wasm: its loader defines CanvasKitInit like the real Emscripten build, records
 * what happens on window.events, and fetches its "wasm" through locateFile before it resolves.
 */
function fakeApp({ skia = "0.40.0", canvaskit = true } = {}) {
  const root = tmp();
  write(path.join(root, "package.json"), JSON.stringify({ name: "fernwood" }));
  if (skia) write(path.join(root, "node_modules/@shopify/react-native-skia/package.json"), JSON.stringify({ name: "@shopify/react-native-skia", version: "2.2.0", dependencies: { "canvaskit-wasm": skia } }));
  if (canvaskit) {
    const dir = path.join(root, "node_modules/canvaskit-wasm");
    write(path.join(dir, "package.json"), JSON.stringify({ name: "canvaskit-wasm", version: skia || "0.40.0" }));
    write(path.join(dir, "bin/full/canvaskit.js"), `var CanvasKitInit = function (opts) {
  (window.events = window.events || []).push("canvaskit:script");
  return new Promise(function (ok) { setTimeout(ok, 150) })
    .then(function () { return fetch(opts.locateFile("canvaskit.wasm")) })
    .then(function (r) { return r.text() })
    .then(function (wasm) { window.events.push("canvaskit:ready"); return { fake: wasm.trim(), MakeWebGLCanvasSurface: function () {} } });
};`);
    write(path.join(dir, "bin/full/canvaskit.wasm"), "fake canvaskit wasm\n");
  }
  return root;
}

/** A built preview whose page loads two app scripts that record what was ready when they ran. */
function fakeBuild(root) {
  const appDir = path.join(root, "preview", "app");
  write(path.join(appDir, "index.html"), `<!doctype html><html><head><title>t</title></head><body><div id="root"></div><script src="/_expo/static/js/web/a.js" defer></script><script src="/_expo/static/js/web/b.js" defer></script></body></html>`);
  const app = (name) => `window.events = window.events || []; window.events.push("${name}:" + (globalThis.CanvasKit ? globalThis.CanvasKit.fake : "no CanvasKit") + ":" + !!(globalThis.__imitor && globalThis.__imitor.SQL));`;
  write(path.join(appDir, "_expo/static/js/web/a.js"), app("a"));
  write(path.join(appDir, "_expo/static/js/web/b.js"), app("b"));
  return appDir;
}

test("bootKinds: the libraries a config needs, in a fixed order", () => {
  assert.deepEqual(bootKinds({ "@shopify/react-native-skia": "canvaskit", "expo-sqlite": "sqljs" }), ["sqljs", "canvaskit"]);
  assert.deepEqual(bootKinds({ "@shopify/react-native-skia": "skia" }), []);
  assert.deepEqual(bootKinds({}), []);
});

test("patchHtml: the boot loader loads the libraries it is given, then the app scripts", () => {
  const html = `<html><body><script src="/_expo/a.js" defer></script></body></html>`;
  const both = patchHtml(html, { boot: ["sqljs", "canvaskit"] });
  assert.ok(both.includes('l("/_imitor/sql-wasm.js")') && both.includes('l("/_imitor/canvaskit.js")'));
  assert.ok(both.includes("Promise.all(["), "the libraries load side by side");
  const ck = patchHtml(html, { boot: ["canvaskit"] });
  assert.ok(ck.includes("CanvasKitInit") && !ck.includes("sql-wasm"));
  assert.ok(patchHtml(html).includes("sql-wasm.js"), "boot: true still means sql.js");
  assert.ok(!patchHtml(html, { boot: [] }).includes("Promise.all"), "no libraries, no boot loader");
  assert.equal(patchHtml(both, { boot: ["sqljs", "canvaskit"] }), both, "patching twice changes nothing");
});

test("bootSources: CanvasKit comes from the app, next to its React Native Skia; missing, the error says what to install", () => {
  const root = fakeApp();
  const sources = bootSources(root, ["sqljs", "canvaskit"]);
  assert.deepEqual(Object.keys(sources), ["sql-wasm.js", "sql-wasm.wasm", "canvaskit.js", "canvaskit.wasm"]);
  assert.equal(sources["canvaskit.wasm"], path.join(root, "node_modules/canvaskit-wasm/bin/full/canvaskit.wasm"));

  // A copy nested under Skia (the version it was built for) wins over a different hoisted one.
  const nested = path.join(root, "node_modules/@shopify/react-native-skia/node_modules/canvaskit-wasm");
  write(path.join(nested, "package.json"), JSON.stringify({ name: "canvaskit-wasm", version: "0.40.0" }));
  write(path.join(nested, "bin/full/canvaskit.js"), "");
  write(path.join(nested, "bin/full/canvaskit.wasm"), "");
  assert.equal(bootSources(root, ["canvaskit"])["canvaskit.js"], path.join(nested, "bin/full/canvaskit.js"));

  assert.throws(() => bootSources(fakeApp({ canvaskit: false }), ["canvaskit"]), /canvaskit-wasm@0\.40\.0/);
  assert.throws(() => bootSources(fakeApp({ skia: null, canvaskit: false }), ["canvaskit"]), /Install @shopify\/react-native-skia/);
  assert.deepEqual(bootSources(fakeApp({ skia: null, canvaskit: false }), []), {}, "nothing is resolved unless canvaskit is configured");
});

test("metro: the canvaskit kind leaves @shopify/react-native-skia to the real resolver", () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify({ shims: { "@shopify/react-native-skia": "canvaskit" } }));
  const before = process.env.IMITOR;
  process.env.IMITOR = "1";
  try {
    const { withImitor } = require("../src/metro.cjs");
    const real = (context, moduleName) => ({ type: "sourceFile", filePath: `/real/${moduleName}` });
    const { resolver } = withImitor({ projectRoot: root, resolver: { resolveRequest: real } });
    const from = { originModulePath: path.join(root, "app.js") };
    assert.equal(resolver.resolveRequest(from, "@shopify/react-native-skia", "web").filePath, "/real/@shopify/react-native-skia");
    assert.equal(resolver.resolveRequest(from, "@shopify/react-native-skia/lib/module/web", "web").filePath, "/real/@shopify/react-native-skia/lib/module/web");
  } finally {
    if (before === undefined) delete process.env.IMITOR;
    else process.env.IMITOR = before;
  }
});

test("metro: a boot kind given only in withImitor's options is refused, since imitor build would not load its library", () => {
  const root = tmp();
  write(path.join(root, "imitor.config.json"), JSON.stringify({ shims: { "expo-sqlite": "sqljs" } }));
  const before = process.env.IMITOR;
  process.env.IMITOR = "1";
  try {
    const { withImitor } = require("../src/metro.cjs");
    const config = { projectRoot: root, resolver: {} };
    assert.throws(() => withImitor(config, { shims: { "@shopify/react-native-skia": "canvaskit" } }), /withImitor: set "@shopify\/react-native-skia": "canvaskit" in imitor\.config\.json "shims"/);
    assert.throws(() => withImitor({ projectRoot: tmp(), resolver: {} }, { shims: { "expo-sqlite": "sqljs" } }), /"expo-sqlite": "sqljs" in imitor\.config\.json/);
    // Kinds that need nothing loaded first, and boot kinds the config already lists, are fine.
    assert.ok(withImitor(config, { shims: { "expo-sqlite": "sqljs", "react-native-maps": "inert", "some-sdk": "./stand-ins/sdk.js" } }).resolver.resolveRequest);
  } finally {
    if (before === undefined) delete process.env.IMITOR;
    else process.env.IMITOR = before;
  }
});

test("describe and the review interface list canvaskit as genuine and skia as a stand-in", () => {
  const root = fakeApp();
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify({ shims: { "@shopify/react-native-skia": "canvaskit", "expo-sqlite": "sqljs", "react-native-maps": "inert" } }));
  assert.deepEqual(describe(root).fidelity, { "@shopify/react-native-skia": "genuine", "expo-sqlite": "genuine", "react-native-maps": "stand-in" });
  const project = projectData(root, { git: { branch: "main", commit: "abc1234" } });
  assert.deepEqual(project.standIns.map((s) => s.fidelity), ["genuine", "genuine", "stand-in"]);
});

/** Open the built page and return the events it recorded once both app scripts have run (or after a short wait). */
async function openBuild(appDir) {
  const { chromium } = require("playwright");
  const server = await serve(appDir);
  let b = null;
  try {
    b = await chromium.launch(); // inside the try, so a failed launch still closes the server
    const page = await b.newPage();
    const errors = [];
    const requests = [];
    let failed;
    const bootFailed = new Promise((done) => (failed = done));
    page.on("console", (m) => { if (m.type() !== "error") return; errors.push(m.text()); if (m.text().includes("[imitor] boot failed")) failed(); });
    page.on("request", (r) => requests.push(new URL(r.url()).pathname));
    await page.goto(server.url + "/");
    await Promise.race([bootFailed, page.waitForFunction(() => (window.events || []).some((e) => e.startsWith("b:")), null, { timeout: 5000 }).catch(() => {})]);
    await page.waitForTimeout(100); // nothing else runs after a failed boot
    return { events: await page.evaluate(() => window.events || []), errors, requests, bootError: await page.evaluate(() => window.__imitorBootError ?? null) };
  } finally {
    await b?.close();
    await server.close();
  }
}

test("boot loader in a browser: CanvasKit is loaded and set before the app scripts, which run in order", browser, async () => {
  const root = fakeApp();
  const appDir = fakeBuild(root);
  patchBuild(appDir, ["canvaskit"], bootSources(root, ["canvaskit"]));
  const { events, errors } = await openBuild(appDir);
  assert.deepEqual(events, ["canvaskit:script", "canvaskit:ready", "a:fake canvaskit wasm:false", "b:fake canvaskit wasm:false"]);
  assert.deepEqual(errors, []);
});

test("boot loader in a browser: sql.js and CanvasKit load side by side, both before the app", browser, async () => {
  const root = fakeApp();
  const appDir = fakeBuild(root);
  patchBuild(appDir, ["sqljs", "canvaskit"], bootSources(root, ["sqljs", "canvaskit"])); // the real sql.js
  const { events, errors, requests } = await openBuild(appDir);
  assert.deepEqual(events, ["canvaskit:script", "canvaskit:ready", "a:fake canvaskit wasm:true", "b:fake canvaskit wasm:true"]);
  assert.deepEqual(errors, []);
  const at = (p) => requests.indexOf(p);
  const firstWasm = Math.min(at("/_imitor/sql-wasm.wasm"), at("/_imitor/canvaskit.wasm"));
  assert.ok(at("/_imitor/sql-wasm.js") >= 0 && at("/_imitor/canvaskit.js") >= 0 && firstWasm >= 0, requests.join(" "));
  assert.ok(at("/_imitor/sql-wasm.js") < firstWasm && at("/_imitor/canvaskit.js") < firstWasm, `both loaders are requested before either wasm: ${requests.join(" ")}`);
});

test("boot loader in a browser: when CanvasKit cannot load, the app does not start and the console says why", browser, async () => {
  const root = fakeApp();
  const appDir = fakeBuild(root);
  patchBuild(appDir, ["canvaskit"], bootSources(root, ["canvaskit"]));
  fs.rmSync(path.join(appDir, "_imitor", "canvaskit.js"));
  const { events, errors, bootError } = await openBuild(appDir);
  assert.deepEqual(events, []);
  assert.ok(errors.some((e) => e.includes("[imitor] boot failed")), errors.join("\n"));
  assert.equal(bootError, "failed to load /_imitor/canvaskit.js"); // where the runner reads it
});

test("a run whose boot failed takes no shot of the blank page: the flow fails and the gate blocks", browser, async () => {
  const root = fakeApp();
  const appDir = fakeBuild(root);
  write(path.join(root, "imitor.config.json"), JSON.stringify({ shims: { "@shopify/react-native-skia": "canvaskit" }, schemes: ["light"], flows: [{ name: "garden", start: "/", steps: [{ shot: "home" }] }] }));
  patchBuild(appDir, ["canvaskit"], bootSources(root, ["canvaskit"]));
  fs.rmSync(path.join(appDir, "_imitor", "canvaskit.js"));
  const server = await serve(appDir);
  try {
    const result = await shoot(root, loadConfig(root), server.url);
    assert.deepEqual(result.shots, []);
    const failed = result.problems.filter((p) => p.kind === "flow-failed");
    assert.equal(failed.length, 1, JSON.stringify(result.problems));
    assert.match(failed[0].message, /^the app did not start: /);
    assert.equal(failed[0].step, 0); // while opening the start route
    const verdict = evaluate({ shots: result.shots, problems: result.problems });
    assert.equal(verdict.passed, false);
  } finally {
    await server.close();
  }
  // The agents' operations say so too, instead of returning a blank screen.
  await assert.rejects(runFlow(root, { flow: "garden" }), /the app did not start: failed to load \/_imitor\/canvaskit\.js/);
  await assert.rejects(screenshot(root, { route: "/" }), /the app did not start/);
});
