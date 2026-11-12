import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { describe, readProblems, recordVideo, runFlow, screenshot, uniqueSuffix } from "../src/agent.mjs";
import { createServer, TOOLS } from "../src/mcp.mjs";

// A stand-in for a built preview: one static page with a button, so no Expo build is needed.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-test-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-app" }));
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify({
    shims: { "expo-sqlite": "sqljs" },
    flows: [
      { name: "welcome", start: "/", steps: [{ shot: "start" }, { tap: "Continue" }, { waitFor: "Second screen" }, { shot: "second" }] },
      { name: "broken", start: "/", steps: [{ tap: "Continue" }, { tap: "No such button" }, { shot: "never" }] },
    ],
  }));
  fs.mkdirSync(path.join(root, "preview", "app"), { recursive: true });
  fs.writeFileSync(path.join(root, "preview", "app", "index.html"), `<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif"><h1 id="t">First screen</h1><div data-imitor-stub="skia" style="height:40px"></div><button onclick="document.getElementById('t').textContent='Second screen'">Continue</button></body>`);
  return root;
}
let hasPlaywright = true;
try { createRequire(import.meta.url)("playwright"); } catch { hasPlaywright = false; }
const browser = { skip: hasPlaywright ? false : "playwright is not installed" };

test("describe lists flows, devices and build state", () => {
  const d = describe(fixture());
  assert.deepEqual(d.flows.map((f) => f.name), ["welcome", "broken"]);
  assert.deepEqual(d.flows[0].shots, ["start", "second"]);
  assert.ok(d.devices.includes("iphone-16") && d.devices.includes("pixel-9"));
  assert.equal(d.built, true);
});

test("readProblems needs a run, then summarises the manifest", () => {
  const root = fixture();
  assert.throws(() => readProblems(root), /no run found/);
  fs.writeFileSync(path.join(root, "preview", "manifest.json"), JSON.stringify({ commit: "abc1234", generatedAt: "x", shots: [{ file: "screens/a.png", stubs: ["skia"] }, { file: "screens/b.png", stubs: [] }], problems: [{ kind: "flow-failed" }], notCovered: ["keyboard"] }));
  const p = readProblems(root);
  assert.equal(p.shots, 2);
  assert.deepEqual(p.standInsSeen, ["skia"]);
  assert.deepEqual(p.shotsWithStandIns, ["screens/a.png"]);
  assert.equal(p.problems.length, 1);
});

test("screenshot saves a PNG and reports stand-ins", browser, async () => {
  const root = fixture();
  const r = await screenshot(root, { flow: "welcome", device: "pixel-9", scheme: "dark", name: "after welcome" });
  assert.equal(r.file, path.join("preview", "captures", "after-welcome.png"));
  assert.ok(fs.statSync(path.join(root, r.file)).size > 1000);
  assert.deepEqual(r.standIns, ["skia"]);
  assert.equal(r.device, "pixel-9");
  assert.equal(r.failedAt, null);
  await assert.rejects(() => screenshot(root, { device: "nokia-3310" }), /unknown device/);
});

test("runFlow reports each step and where a flow failed", browser, async () => {
  const root = fixture();
  const ok = await runFlow(root, { flow: "welcome" });
  assert.equal(ok.passed, true);
  assert.deepEqual(ok.shots.map((s) => s.shot), ["start", "second"]);
  const bad = await runFlow(root, { flow: "broken" });
  assert.equal(bad.passed, false);
  assert.equal(bad.failedAt, 2);
  assert.equal(bad.steps.at(-1).ok, false);
  assert.ok(fs.existsSync(path.join(root, bad.failureShot)));
  await assert.rejects(() => runFlow(root, { flow: "nope" }), /unknown flow "nope"/);
});

test("captures taken twice with the same route, flow, device and scheme keep separate files", browser, async () => {
  const root = fixture();
  const a = await screenshot(root, { route: "/", device: "pixel-9", scheme: "dark" });
  const b = await screenshot(root, { route: "/", device: "pixel-9", scheme: "dark" });
  assert.match(a.file, /captures[\\/]root-pixel-9-dark-[a-z0-9]{6,}\.png$/);
  assert.notEqual(a.file, b.file);
  assert.ok(fs.existsSync(path.join(root, a.file)) && fs.existsSync(path.join(root, b.file)));
  const f1 = await runFlow(root, { flow: "welcome" });
  const f2 = await runFlow(root, { flow: "welcome" });
  assert.notEqual(f1.shots[0].file, f2.shots[0].file);
  assert.ok(f1.shots.every((s) => fs.existsSync(path.join(root, s.file))));
  const bad1 = await runFlow(root, { flow: "broken" });
  const bad2 = await runFlow(root, { flow: "broken" });
  assert.notEqual(bad1.failureShot, bad2.failureShot);
});

test("uniqueSuffix differs between calls in the same millisecond", () => {
  const seen = new Set(Array.from({ length: 50 }, () => uniqueSuffix(1794424939715)));
  assert.ok(seen.size > 40);
  assert.match(uniqueSuffix(), /^[a-z0-9]{8,}$/);
});

test("alert and confirm dialogs are recorded and dismissed, in flow results and in full runs", browser, async () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, "preview", "app", "index.html"), `<!doctype html><body><p id="t">Ready</p><button onclick="alert('Error\\n\\nNo connection');document.getElementById('t').textContent=confirm('Delete?')?'Deleted':'Kept'">Save</button></body>`);
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify({ schemes: ["light"], flows: [{ name: "save", start: "/", steps: [{ tap: "Save" }, { waitFor: "Kept" }, { shot: "after" }] }] }));
  const r = await runFlow(root, { flow: "save" });
  assert.equal(r.passed, true);
  assert.deepEqual(r.dialogs, ["alert: Error No connection", "confirm: Delete?"]);
  const { serve } = await import("../src/serve.mjs");
  const { shoot } = await import("../src/shoot.mjs");
  const { loadConfig } = await import("../src/config.mjs");
  const server = await serve(path.join(root, "preview", "app"));
  try {
    const run = await shoot(root, loadConfig(root), server.url);
    const dialogs = run.problems.filter((p) => p.kind === "dialog");
    assert.deepEqual(dialogs.map((p) => [p.message, p.step]), [["alert: Error No connection", 1], ["confirm: Delete?", 1]]);
  } finally {
    await server.close();
  }
});

test("recordVideo writes a webm", browser, async () => {
  const root = fixture();
  const r = await recordVideo(root, { flow: "welcome", holdMs: 100 });
  assert.match(r.file, /welcome-iphone-16-light-[a-z0-9]{6,}\.webm$/);
  assert.ok(r.bytes > 1000);
  assert.equal(r.passed, true);
});

test("MCP server: handshake, tool list, tool errors are results not crashes", async () => {
  const server = createServer(fixture());
  const init = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.serverInfo.name, "imitor");
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const list = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.ok(list.result.tools.every((t) => t.description && t.inputSchema.type === "object"));
  const described = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "imitor_describe" } });
  assert.equal(JSON.parse(described.result.content[0].text).flows.length, 2);
  const failed = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "imitor_read_problems" } });
  assert.equal(failed.result.isError, true);
  const unknown = await server.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } });
  assert.equal(unknown.error.code, -32602);
  const missing = await server.handle({ jsonrpc: "2.0", id: 6, method: "resources/list" });
  assert.equal(missing.error.code, -32601);
  server.close();
});

test("MCP screenshot returns the image inline", browser, async () => {
  const server = createServer(fixture());
  const r = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "imitor_screenshot", arguments: { route: "/" } } });
  assert.equal(r.result.content[1].type, "image");
  assert.equal(r.result.content[1].mimeType, "image/png");
  assert.ok(r.result.content[1].data.length > 1000);
  server.close();
});

test("a scroll step scrolls an inner scroll view (as React Native Web renders one), not only the document", browser, async () => {
  const { chromium } = createRequire(import.meta.url)("playwright");
  const { doStep } = await import("../src/shoot.mjs");
  const b = await chromium.launch();
  try {
    const page = await b.newPage({ viewport: { width: 390, height: 600 }, isMobile: true, hasTouch: true });
    await page.setContent(`<body style="margin:0;height:100vh;overflow:hidden"><div style="height:80px;background:#ddd">Header</div><div id="s" style="height:520px;overflow-y:auto"><div style="height:3000px">Long</div></div></body>`);
    await doStep(page, { scroll: 400 }, "");
    await page.waitForTimeout(300);
    assert.ok((await page.evaluate(() => document.getElementById("s").scrollTop)) > 0);
  } finally {
    await b.close();
  }
});

test("an absolute out folder is used as given, not placed under the app folder", () => {
  const root = fixture();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-out-"));
  fs.mkdirSync(path.join(elsewhere, "app"));
  fs.writeFileSync(path.join(elsewhere, "app", "index.html"), "<!doctype html>");
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify({ out: elsewhere }));
  assert.equal(describe(root).built, true);
  fs.writeFileSync(path.join(elsewhere, "manifest.json"), JSON.stringify({ commit: null, generatedAt: "x", shots: [], problems: [], notCovered: [] }));
  assert.equal(readProblems(root).shots, 0);
});
