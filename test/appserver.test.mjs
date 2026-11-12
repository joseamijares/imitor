import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startAppServer } from "../src/appserver.mjs";
import { patchHtml } from "../src/build.mjs";
import { loadConfig } from "../src/config.mjs";
import { TOOLS } from "../src/mcp.mjs";
import { appendActivity, appendCapture, recordRun } from "../src/store.mjs";

// An invented app, "fernwood", with one recorded run (one failed scheme), one capture and one MCP call.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-app-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fernwood" }));
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify({
    shims: { "expo-sqlite": "sqljs", "@shopify/react-native-skia": "skia" },
    devices: ["pixel-9"],
    flows: [{ name: "first-run", start: "/", steps: [{ shot: "01-welcome" }, { tap: "Continue" }, { fill: { placeholder: "Plant name", value: "Fern" } }, { shot: "02-today" }] }],
  }));
  const out = path.join(root, "preview");
  fs.mkdirSync(path.join(out, "screens"), { recursive: true });
  fs.mkdirSync(path.join(out, "app", "_expo"), { recursive: true });
  fs.writeFileSync(path.join(out, "app", "index.html"), `<!doctype html><html><head><title>fernwood</title></head><body><script src="/_expo/a.js"></script></body></html>`);
  fs.writeFileSync(path.join(out, "app", "_expo", "a.js"), "console.log('fernwood')");
  fs.writeFileSync(path.join(root, "secret.txt"), "outside the output folder");
  const shots = ["light", "dark"].flatMap((scheme) => ["01-welcome", "02-today"].filter((n) => scheme === "light" || n === "01-welcome").map((n) => ({ file: `screens/first-run-${n}-pixel-9-${scheme}.png`, flow: "first-run", shot: n, device: "pixel-9", scheme, route: "/", stubs: n === "02-today" ? ["skia"] : [] })));
  const problems = [{ where: "first-run / pixel-9 / dark", kind: "flow-failed", message: "locator.fill: Timeout 10000ms exceeded.", file: "screens/first-run-FAILED-pixel-9-dark.png", flow: "first-run", device: "pixel-9", scheme: "dark", step: 3, stepConfig: { fill: { placeholder: "Plant name", value: "Fern" } }, lastGoodShot: "screens/first-run-01-welcome-pixel-9-dark.png", notReached: ["02-today"] }];
  for (const f of [...shots, ...problems]) fs.writeFileSync(path.join(out, f.file), "png");
  const manifest = { commit: null, shots, problems };
  const run = recordRun(out, { root, config: loadConfig(root), manifest, startedAt: "2026-11-10T09:00:00.000Z", by: { name: "GitHub Actions", kind: "ci" }, env: {} });
  fs.mkdirSync(path.join(out, "captures"), { recursive: true });
  fs.writeFileSync(path.join(out, "captures", "today-pixel-9-light.png"), "png-bytes");
  appendCapture(out, { kind: "screenshot", file: "captures/today-pixel-9-light.png", route: "/today", device: "pixel-9", scheme: "light", by: { name: "Claude Code", kind: "agent" }, standIns: ["skia"] });
  appendActivity(out, { by: { name: "Claude Code", kind: "agent" }, tool: "imitor_screenshot", text: "took a screenshot of /today on pixel-9" });
  return { root, out, run };
}

/** A raw request, so paths reach the server exactly as written (fetch would normalise ".."). */
function request(base, method, rawPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + "/", { method, path: rawPath, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body: data, json: () => JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("API: project, runs, one run, captures, problems, agents", async (t) => {
  const f = fixture();
  const server = await startAppServer(f.root, { port: 0, appDir: path.join(f.root, "no-app") });
  t.after(() => server.close());
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const get = async (p) => {
    const r = await request(server.url, "GET", p);
    assert.equal(r.status, 200, `${p}: ${r.body}`);
    assert.match(r.type, /^application\/json/);
    return r.json();
  };

  const project = await get("/api/project");
  assert.equal(project.name, "fernwood");
  assert.equal(project.built, true);
  assert.deepEqual(project.devices.map((d) => d.name), ["pixel-9", "iphone-16", "iphone-se", "small-android"]);
  assert.deepEqual(project.devices[0], { name: "pixel-9", width: 412, height: 915, platform: "android" });
  assert.deepEqual(project.schemes, ["light", "dark"]);
  assert.deepEqual(project.flows[0].steps.map(({ step, ...rest }) => rest), [{ index: 1, action: "shot", label: "01-welcome" }, { index: 2, action: "tap", label: "Continue" }, { index: 3, action: "fill", label: "Plant name" }, { index: 4, action: "shot", label: "02-today" }]);
  assert.deepEqual(project.flows[0].steps[2].step, { fill: { placeholder: "Plant name", value: "Fern" } }, "the step as configured, for replaying it in the live preview");
  assert.deepEqual(project.standIns, [{ module: "expo-sqlite", kind: "sqljs", fidelity: "genuine" }, { module: "@shopify/react-native-skia", kind: "skia", fidelity: "stand-in" }]);
  assert.ok(project.notCovered.length > 3);

  const { runs } = await get("/api/runs");
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], { id: f.run.id, status: "failed", title: "No commit", pr: null, branch: null, commit: null, by: { name: "GitHub Actions", kind: "ci" }, shots: 3, problems: 1, startedAt: "2026-11-10T09:00:00.000Z", finishedAt: f.run.finishedAt });

  const detail = await get(`/api/runs/${f.run.id}`);
  assert.deepEqual(detail.run, runs[0]);
  assert.deepEqual(detail.devices, ["pixel-9"]);
  assert.deepEqual(detail.flows.map((x) => [x.scheme, x.status, x.steps.map((s) => s.status)]), [["light", "stand-ins", ["ok", "stand-in"]], ["dark", "failed", ["ok", "failed"]]]);
  assert.equal(detail.flows[1].steps[1].shot, `/files/runs/${f.run.id}/screens/first-run-FAILED-pixel-9-dark.png`);
  assert.deepEqual(detail.problems.map((p) => p.kind), ["flow-failed", "stand-in"]);

  const { captures } = await get("/api/captures");
  assert.equal(captures.length, 1);
  assert.equal(captures[0].file, "/files/captures/today-pixel-9-light.png");
  assert.deepEqual(captures[0].by, { name: "Claude Code", kind: "agent" });

  const { problems } = await get("/api/problems");
  assert.equal(problems[0].title, "first-run failed at step 3");
  assert.deepEqual(problems[0].detail.stepConfig, { fill: { placeholder: "Plant name", value: "•••" } }, "a fill value never leaves the run, even from a manifest written before values were hidden");
  assert.equal(problems[0].detail.lastGoodShot, `/files/runs/${f.run.id}/screens/first-run-01-welcome-pixel-9-dark.png`);
  assert.equal(problems[1].title, "skia stand-in on 1 shot");

  const agents = await get("/api/agents");
  assert.deepEqual(Object.keys(agents.commands), ["Claude Code", "Cursor", "Codex", "Other", "CI"]);
  assert.deepEqual(agents.tools.map((x) => x.name), TOOLS.map((x) => x.name));
  assert.equal(agents.connections[0].name, "Claude Code");
  assert.equal(agents.connections[0].active, true);
  assert.equal(agents.activity[0].text, "took a screenshot of /today on pixel-9");

  // Every /files/ URL the API hands out is served.
  for (const url of [...detail.flows.flatMap((x) => x.steps.map((s) => s.shot)), captures[0].file, problems[0].detail.lastGoodShot]) {
    assert.equal((await request(server.url, "GET", url)).status, 200, url);
  }
});

test("API: unknown ids and endpoints are 404 with an error", async (t) => {
  const f = fixture();
  const server = await startAppServer(f.root, { port: 0 });
  t.after(() => server.close());
  for (const p of ["/api/runs/20990101T000000-nope", "/api/runs/..%2F..%2Fsecret", "/api/nope"]) {
    const r = await request(server.url, "GET", p);
    assert.equal(r.status, 404, p);
    assert.equal(typeof r.json().error, "string");
  }
  const r = await request(server.url, "POST", "/api/problems/p_000000000000/seen", JSON.stringify({ seen: true }));
  assert.equal(r.status, 404);
});

test("POST /api/problems/:id/seen stores the seen state", async (t) => {
  const f = fixture();
  const server = await startAppServer(f.root, { port: 0 });
  t.after(() => server.close());
  const before = (await request(server.url, "GET", "/api/problems")).json().problems[0];
  assert.equal(before.seen, false);
  const r = await request(server.url, "POST", `/api/problems/${before.id}/seen`, JSON.stringify({ seen: true }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json(), { ok: true });
  assert.equal((await request(server.url, "GET", "/api/problems")).json().problems[0].seen, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.out, "state.json"), "utf8")).seenProblems, [before.id]);
  await request(server.url, "POST", `/api/problems/${before.id}/seen`, JSON.stringify({ seen: false }));
  assert.equal((await request(server.url, "GET", "/api/problems")).json().problems[0].seen, false);
  assert.equal((await request(server.url, "POST", `/api/problems/${before.id}/seen`, "not json")).status, 400);
  assert.equal((await request(server.url, "POST", `/api/problems/${before.id}/seen`, JSON.stringify({ seen: "yes" }))).status, 400);
});

test("static: /files/ rejects paths that escape the output folder", async (t) => {
  const f = fixture();
  const server = await startAppServer(f.root, { port: 0 });
  t.after(() => server.close());
  const ok = await request(server.url, "GET", "/files/captures/today-pixel-9-light.png");
  assert.equal(ok.status, 200);
  assert.equal(ok.type, "image/png");
  assert.equal(ok.body, "png-bytes");
  for (const p of ["/files/../secret.txt", "/files/..%2fsecret.txt", "/files/%2e%2e/secret.txt", "/files/captures/..%2F..%2Fsecret.txt", "/files/..%5csecret.txt"]) {
    const r = await request(server.url, "GET", p);
    assert.ok([403, 404].includes(r.status), `${p} gave ${r.status}`);
    assert.ok(!r.body.includes("outside the output folder"), p);
  }
  assert.equal((await request(server.url, "GET", "/files/../secret.txt")).status, 403);
  assert.equal((await request(server.url, "GET", "/files/captures/missing.png")).status, 404);
});

test("static: other paths serve the app page; the preview build is not mixed into the interface's origin", async (t) => {
  const f = fixture();
  const appDir = path.join(f.root, "fake-app");
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, "index.html"), "<!doctype html><title>Imitor</title><div id=app></div>");
  fs.writeFileSync(path.join(appDir, "app.css"), "body{}");
  const server = await startAppServer(f.root, { port: 0, appDir });
  t.after(() => server.close());
  for (const p of ["/", "/runs/abc/shots", "/agents", "/runs/abc/live", "/onboarding/stand-ins"]) {
    const r = await request(server.url, "GET", p);
    assert.equal(r.status, 200, p);
    assert.match(r.body, /<div id=app>/);
  }
  assert.equal((await request(server.url, "GET", "/app.css")).type, "text/css");
  assert.equal((await request(server.url, "GET", "/nope.js")).status, 404);
  assert.equal((await request(server.url, "GET", "/_expo/a.js")).status, 404);
});

test("preview: its own origin, single-page fallback, the live driver, reloads keep the app", async (t) => {
  const f = fixture();
  const server = await startAppServer(f.root, { port: 0, appDir: path.join(f.root, "no-app") });
  t.after(() => server.close());
  const project = (await request(server.url, "GET", "/api/project")).json();
  assert.equal(project.previewUrl, server.previewUrl);
  assert.match(project.previewUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(project.previewUrl, server.url);
  assert.match(project.builtAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(project.previewAppearance, false, "the fixture's build predates the scheme override");

  for (const p of ["/", "/plants/fern", "/plants/fern?x=1"]) {
    const r = await request(project.previewUrl, "GET", p);
    assert.equal(r.status, 200, p);
    assert.match(r.body, /<title>fernwood<\/title>/, `${p} serves the app itself, so a reload inside the frame keeps it`);
    assert.match(r.body, /__imitorLive=\{"parents":\["http:\/\/127\.0\.0\.1:\d+","http:\/\/localhost:\d+"\]\}/);
    assert.ok(r.body.includes(`__imitorLive={"parents":["${server.url}",`), "the driver obeys only the interface's origin");
  }
  assert.equal((await request(project.previewUrl, "GET", "/_expo/a.js")).body, "console.log('fernwood')");
  const driver = await request(project.previewUrl, "GET", "/__imitor_live/driver.js");
  assert.equal(driver.status, 200);
  assert.match(driver.type, /javascript/);
  assert.match(driver.body, /step-done/);
  assert.equal((await request(project.previewUrl, "GET", "/missing.js")).status, 404);
  assert.notEqual((await request(project.previewUrl, "GET", "/../secret.txt")).body, "outside the output folder");
  assert.equal((await request(server.url, "GET", "/preview/plants/fern")).body.includes("fernwood</title>"), false, "/preview/ is gone");

  // A build with the override reports it.
  const index = path.join(f.out, "app", "index.html");
  fs.writeFileSync(index, patchHtml(fs.readFileSync(index, "utf8"), { boot: false }));
  assert.equal((await request(server.url, "GET", "/api/project")).json().previewAppearance, true);
});

test("static: a placeholder page when src/app is not there yet", async (t) => {
  const f = fixture();
  const server = await startAppServer(f.root, { port: 0, appDir: path.join(f.root, "no-app") });
  t.after(() => server.close());
  const r = await request(server.url, "GET", "/");
  assert.equal(r.status, 200);
  assert.match(r.body, /not built yet/);
});

let hasPlaywright = true;
try { (await import("node:module")).createRequire(import.meta.url)("playwright"); } catch { hasPlaywright = false; }

test("live driver: the interface drives the preview in its frame (tap, fill, reset, stand-ins)", { skip: !hasPlaywright && "playwright is not installed" }, async (t) => {
  const f = fixture();
  fs.writeFileSync(path.join(f.out, "app", "index.html"), `<!doctype html><html><head><title>fernwood</title></head><body>
    <div id="one"><h1>Welcome</h1><div role="button" onclick="one.hidden=true;two.hidden=false"><span>Continue</span></div></div>
    <div id="two" hidden><input placeholder="Plant name" oninput="echo.textContent=this.value"><p id="echo"></p><div data-imitor-stub="skia" style="height:20px"></div></div>
    <script>sessionStorage.setItem("app-data", "x"); sessionStorage.setItem("imitor-scheme", "dark")</script></body></html>`);
  const appDir = path.join(f.root, "fake-app");
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, "index.html"), `<!doctype html><iframe id="f"></iframe><script>
    window.messages = [];
    addEventListener("message", (e) => window.messages.push(e.data));
    window.next = (kind, from) => new Promise((ok) => { const i = setInterval(() => { const m = window.messages.slice(from).find((x) => x.imitor === kind); if (m) { clearInterval(i); ok(m); } }, 20); });
    window.ask = (msg, kind) => { const n = window.messages.length; document.getElementById("f").contentWindow.postMessage(msg, "*"); return window.next(kind, n); };
  </script>`);
  const server = await startAppServer(f.root, { port: 0, appDir });
  t.after(() => server.close());
  const { chromium } = (await import("node:module")).createRequire(import.meta.url)("playwright");
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url + "/live");
  const ready = await page.evaluate((url) => { document.getElementById("f").src = url + "/"; return window.next("ready", 0); }, server.previewUrl);
  assert.equal(ready.route, "/");
  assert.equal(ready.media, null, "this build has no scheme override");
  const frame = page.frames().find((x) => x !== page.mainFrame());

  assert.deepEqual(await page.evaluate(() => window.ask({ imitor: "step", id: 1, step: { tap: "Continue" } }, "step-done")).then((r) => [r.id, r.ok]), [1, true]);
  assert.equal(await frame.evaluate(() => document.getElementById("two").hidden), false);
  const filled = await page.evaluate(() => window.ask({ imitor: "step", id: 2, step: { fill: { placeholder: "Plant name", value: "Fern" } } }, "step-done"));
  assert.equal(filled.ok, true);
  assert.deepEqual(filled.standIns, [{ kind: "skia", count: 1 }]);
  assert.equal(await frame.evaluate(() => document.getElementById("echo").textContent), "Fern");
  const bad = await page.evaluate(() => window.ask({ imitor: "step", id: 3, step: { swipe: "left" } }, "step-done"));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /cannot be performed/);

  await page.evaluate(() => window.ask({ imitor: "reset", id: 4 }, "reset-done"));
  assert.deepEqual(await frame.evaluate(() => Object.keys(sessionStorage)), ["imitor-scheme"], "reset keeps only the imitor-* settings");
});

// ---------- values from the environment in the live preview ----------

/** An app whose only flow signs in with { env } values, with one run whose shot carries `secrets`. */
function signInFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-app-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "signin" }));
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify({
    secrets: ["TEST_EMAIL"],
    devices: ["iphone-16"],
    schemes: ["light"],
    flows: [{ name: "sign-in", start: "/", steps: [{ tap: "Begin" }, { fill: { placeholder: "Email", value: { env: "TEST_EMAIL" } } }, { shot: "filled" }] }],
  }));
  const out = path.join(root, "preview");
  fs.mkdirSync(path.join(out, "screens"), { recursive: true });
  fs.mkdirSync(path.join(out, "app"), { recursive: true });
  fs.writeFileSync(path.join(out, "app", "index.html"), patchHtml(`<!doctype html><html><head><title>signin</title></head><body>
    <div role="button" id="begin" onclick="this.dataset.done='yes'"><span>Begin</span></div><input placeholder="Email"></body></html>`, { boot: false }));
  const file = "screens/sign-in-filled-iphone-16-light.png";
  fs.writeFileSync(path.join(out, file), "png");
  const manifest = { commit: "c0ffee1", shots: [{ file, flow: "sign-in", shot: "filled", step: 3, device: "iphone-16", scheme: "light", route: "/", stubs: [], secrets: ["TEST_EMAIL"] }], problems: [] };
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest));
  const run = recordRun(out, { root, config: loadConfig(root), manifest, startedAt: "2026-11-12T09:00:00.000Z", by: { name: "GitHub Actions", kind: "ci" }, env: {} });
  appendCapture(out, { kind: "screenshot", file, flow: "sign-in", device: "iphone-16", scheme: "light", by: { name: "Claude Code", kind: "agent" }, secrets: ["TEST_EMAIL"] });
  return { root, run };
}

test("live driver: a step that fills from the environment is refused, and nothing is typed", async (t) => {
  const { root } = signInFixture();
  const appDir = path.join(root, "fake-app");
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, "index.html"), `<!doctype html><iframe id="f"></iframe><script>
    window.messages = [];
    addEventListener("message", (e) => window.messages.push(e.data));
    window.next = (kind, from) => new Promise((ok) => { const i = setInterval(() => { const m = window.messages.slice(from).find((x) => x.imitor === kind); if (m) { clearInterval(i); ok(m); } }, 20); });
    window.ask = (msg, kind) => { const n = window.messages.length; document.getElementById("f").contentWindow.postMessage(msg, "*"); return window.next(kind, n); };
  </script>`);
  const server = await startAppServer(root, { port: 0, appDir });
  t.after(() => server.close());
  const { chromium } = (await import("node:module")).createRequire(import.meta.url)("playwright");
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url + "/live");
  await page.evaluate((url) => { document.getElementById("f").src = url + "/"; return window.next("ready", 0); }, server.previewUrl);
  const frame = page.frames().find((x) => x !== page.mainFrame());
  const r = await page.evaluate(() => window.ask({ imitor: "step", id: 1, step: { fill: { placeholder: "Email", value: { env: "TEST_EMAIL" } } } }, "step-done"));
  assert.equal(r.ok, false);
  assert.match(r.error, /fills a value from the environment, which the live preview does not replay/);
  assert.equal(await frame.evaluate(() => document.querySelector("input").value), "", "not even \"[object Object]\" is typed");
});

test("live preview: a replay stops before a step that fills from the environment and says why; tiles are marked", async (t) => {
  const { root, run } = signInFixture();
  const server = await startAppServer(root, { port: 0 });
  t.after(() => server.close());
  const project = await (await fetch(server.url + "/api/project")).json();
  assert.deepEqual(project.flows[0].secrets, ["TEST_EMAIL"]);
  assert.deepEqual(project.flows[0].steps[1].step, { fill: { placeholder: "Email", value: { env: "TEST_EMAIL" } } }, "the interface gets the reference only");
  const { chromium } = (await import("node:module")).createRequire(import.meta.url)("playwright");
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.goto(server.url + "/live?flow=sign-in&step=3");
  const alert = page.locator("[role=alert]");
  await alert.waitFor({ timeout: 15000 });
  const text = await alert.innerText();
  assert.match(text, /step 02/i);
  assert.match(text, /fills TEST_EMAIL from the environment, which the live preview does not replay/);
  const frame = page.frames().find((x) => x.url().startsWith(server.previewUrl));
  assert.ok(frame, "the preview is open in the device frame");
  assert.equal(await frame.evaluate(() => document.getElementById("begin").dataset.done), "yes", "the steps before it ran");
  assert.equal(await frame.evaluate(() => document.querySelector("input").value), "", "the field was not filled");
  await page.getByText("Fills from").waitFor({ timeout: 5000 });
  assert.match(await page.locator(".insp-section", { hasText: "Flow state" }).innerText(), /Fills from TEST_EMAIL[\s\S]*Not replayed here/);

  await page.goto(server.url + `/runs/${run.id}/shots`);
  const runMark = page.locator(".secrets-mark").first();
  await runMark.waitFor({ timeout: 10000 });
  assert.equal(await runMark.innerText(), "Uses secrets");
  assert.match(await runMark.getAttribute("title"), /values from TEST_EMAIL\. This shot may show a real account/);

  await page.goto(server.url + "/captures");
  await page.locator(".secrets-mark").first().waitFor({ timeout: 10000 });
});
