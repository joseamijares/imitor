import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildDemo } from "../demo/build.mjs";
import { startAppServer } from "../src/appserver.mjs";
import { loadConfig } from "../src/config.mjs";
import { exportSite, normalizeBase, SPA_REWRITE, spaRewrite } from "../src/export.mjs";
import { appendActivity, appendCapture, listProblems, recordRun, setSeen } from "../src/store.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));

// An invented app, "fernwood", with two recorded runs (the newer one failed in the dark scheme), a screenshot, a video
// and one MCP call. A file in the output folder that nothing references must stay out of the export.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-export-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fernwood" }));
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify({
    shims: { "@shopify/react-native-skia": "skia" },
    devices: ["iphone-16"],
    flows: [{ name: "first-run", start: "/", steps: [{ shot: "01-welcome" }, { tap: "Continue" }, { shot: "02-today" }] }],
  }));
  const out = path.join(root, "preview");
  fs.mkdirSync(path.join(out, "app"), { recursive: true });
  fs.writeFileSync(path.join(out, "app", "index.html"), "<!doctype html><title>fernwood</title>");
  fs.writeFileSync(path.join(out, "unreferenced.txt"), "not part of any response");
  const config = loadConfig(root);
  const runs = [];
  for (const [i, failDark] of [[0, false], [1, true]]) {
    fs.rmSync(path.join(out, "screens"), { recursive: true, force: true });
    fs.mkdirSync(path.join(out, "screens"), { recursive: true });
    const shots = ["light", "dark"].flatMap((scheme) => ["01-welcome", "02-today"].filter((n) => !(failDark && scheme === "dark" && n === "02-today"))
      .map((n) => ({ file: `screens/first-run-${n}-iphone-16-${scheme}.png`, flow: "first-run", shot: n, device: "iphone-16", scheme, route: "/", stubs: n === "02-today" ? ["skia"] : [] })));
    const problems = failDark ? [{ where: "first-run / iphone-16 / dark", kind: "flow-failed", message: "locator.click: Timeout 10000ms exceeded.", file: "screens/first-run-FAILED-iphone-16-dark.png", flow: "first-run", device: "iphone-16", scheme: "dark", step: 2, stepConfig: { tap: "Continue" }, lastGoodShot: "screens/first-run-01-welcome-iphone-16-dark.png", notReached: ["02-today"] }] : [];
    for (const f of [...shots, ...problems]) fs.writeFileSync(path.join(out, f.file), `png ${i} ${f.file}`);
    runs.push(recordRun(out, { root, config, manifest: { commit: `c0ffee${i}`, shots, problems }, startedAt: `2026-11-1${i}T09:00:00.000Z`, by: { name: "Claude Code", kind: "agent" }, env: {}, git: { branch: "feat/larger-targets", commit: `c0ffee${i}`, subject: `Larger targets (#${118 + i})` } }));
  }
  fs.mkdirSync(path.join(out, "captures"), { recursive: true });
  fs.writeFileSync(path.join(out, "captures", "today light.png"), "png-bytes"); // a space, so URLs are encoded
  fs.writeFileSync(path.join(out, "captures", "first-run.webm"), "webm-bytes");
  appendCapture(out, { kind: "screenshot", file: "captures/today light.png", route: "/today", device: "iphone-16", scheme: "light", by: { name: "Cursor", kind: "agent" }, standIns: [] });
  appendCapture(out, { kind: "video", file: "captures/first-run.webm", flow: "first-run", device: "iphone-16", scheme: "dark", by: { name: "Cursor", kind: "agent" }, seconds: 3.1 });
  appendActivity(out, { by: { name: "Claude Code", kind: "agent" }, tool: "imitor_screenshot", text: "took a screenshot of /today on iphone-16" });
  const failure = listProblems(out).find((p) => p.kind === "flow-failed");
  setSeen(out, failure.id, true);
  return { root, out, runs };
}

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imitor-site-")), name);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** Every string starting with /files/ in a JSON value. */
function fileUrls(value, found = []) {
  if (typeof value === "string") { if (value.startsWith("/files/")) found.push(value); }
  else if (value && typeof value === "object") Object.values(value).forEach((v) => fileUrls(v, found));
  return found;
}

/** Every path of a site's JSON responses, relative to the site. */
const jsonFiles = (dir) => fs.readdirSync(path.join(dir, "api"), { recursive: true }).filter((f) => f.endsWith(".json")).map((f) => "api/" + f.split(path.sep).join("/")).sort();

test("export writes the interface, every GET endpoint as .json, the referenced files and the static marker", (t) => {
  const f = fixture();
  const dir = tmp("site");
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const site = exportSite(f.root, { out: dir });
  assert.equal(site.dir, dir);
  assert.equal(site.runs, 2);
  assert.deepEqual(site.missing, []);

  for (const file of ["index.html", "404.html", "vercel.json", "app.js", "app.css", "api.js", "pages/runs.js", "assets/imitor-icon-32.svg"]) assert.ok(fs.existsSync(path.join(dir, file)), file);
  assert.deepEqual(jsonFiles(dir), ["api/agents.json", "api/captures.json", "api/problems.json", "api/project.json", ...f.runs.map((r) => `api/runs/${r.id}.json`).sort(), "api/runs.json"].sort());
  assert.ok(!fs.existsSync(path.join(dir, "files", "unreferenced.txt")), "only referenced files are copied");
  assert.ok(!fs.existsSync(path.join(dir, "files", "app")), "the web build is not part of the export");

  const index = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  assert.match(index, /<meta name="imitor-mode" content="static">/);
  assert.equal(fs.readFileSync(path.join(dir, "404.html"), "utf8"), index);
  assert.deepEqual(readJson(path.join(dir, "vercel.json")), { rewrites: [SPA_REWRITE] });
  assert.equal(readJson(path.join(dir, "api", "project.json")).previewUrl, null);

  // Seen state is part of the snapshot.
  assert.equal(readJson(path.join(dir, "api", "problems.json")).problems.find((p) => p.kind === "flow-failed").seen, true);
});

test("every /files/ URL in the exported JSON exists in the export", (t) => {
  const f = fixture();
  const dir = tmp("site");
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  exportSite(f.root, { out: dir });
  const urls = jsonFiles(dir).flatMap((file) => fileUrls(readJson(path.join(dir, file))));
  assert.ok(urls.length >= 9, `expected shots, failure shots and captures, got ${urls.length}`);
  assert.ok(urls.includes("/files/captures/today%20light.png"));
  for (const url of urls) assert.ok(fs.existsSync(path.join(dir, decodeURIComponent(url))), url);
  assert.equal(fs.readFileSync(path.join(dir, "files", "captures", "first-run.webm"), "utf8"), "webm-bytes");
});

test("each exported JSON equals what the live server returns for the same data", async (t) => {
  const f = fixture();
  const dir = tmp("site");
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const server = await startAppServer(f.root, { port: 0 });
  t.after(() => server.close());
  exportSite(f.root, { out: dir });
  for (const file of jsonFiles(dir)) {
    const route = "/" + file.replace(/\.json$/, "");
    const res = await fetch(server.url + route);
    assert.equal(res.status, 200, route);
    const live = await res.json();
    const exported = readJson(path.join(dir, file));
    if (route === "/api/project") {
      assert.equal(typeof live.previewUrl, "string");
      delete live.previewUrl;
      delete exported.previewUrl;
    }
    assert.deepEqual(exported, live, route);
  }
});

test("--preview-url and --demo set previewUrl and the demo marker; a foreign folder is never replaced", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const dir = tmp("site");
  exportSite(f.root, { out: dir, previewUrl: "https://preview.example.com/", demo: true });
  assert.equal(readJson(path.join(dir, "api", "project.json")).previewUrl, "https://preview.example.com");
  assert.match(fs.readFileSync(path.join(dir, "index.html"), "utf8"), /<meta name="imitor-mode" content="static demo">/);
  exportSite(f.root, { out: dir }); // an earlier export is replaced
  assert.match(fs.readFileSync(path.join(dir, "index.html"), "utf8"), /content="static">/);

  const foreign = tmp("mine");
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, "notes.txt"), "keep me");
  assert.throws(() => exportSite(f.root, { out: foreign }), /not empty/);
  assert.equal(fs.readFileSync(path.join(foreign, "notes.txt"), "utf8"), "keep me");
  assert.throws(() => exportSite(f.root, { out: f.root }), /refusing/);
  assert.throws(() => exportSite(f.root, { out: tmp("x"), previewUrl: "not a url" }), /--preview-url/);
});

test("imitor export: the command writes to <out>/site by default", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const stdout = execFileSync(process.execPath, [path.join(REPO, "bin", "imitor.mjs"), "export"], { cwd: f.root, encoding: "utf8" });
  assert.match(stdout, /Exported 2 runs and \d+ files .* to preview[/\\]site/);
  assert.match(stdout, /read-only/);
  assert.ok(fs.existsSync(path.join(f.out, "site", "api", "runs.json")));
});

test("demo/build.mjs builds a demo site with twelve fernwood runs, the newest minutes old", (t) => {
  const dir = tmp("demo-site");
  const now = Date.now();
  const site = buildDemo({ out: dir, now });
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  assert.deepEqual(site.missing, []);
  const { runs } = readJson(path.join(dir, "api", "runs.json"));
  assert.equal(runs.length, 12);
  assert.ok(now - Date.parse(runs[0].startedAt) < 10 * 60000, "the newest run is a few minutes old");
  assert.deepEqual([...new Set(runs.map((r) => r.status))].sort(), ["failed", "passed", "stand-ins"]);
  assert.deepEqual([...new Set(runs.map((r) => r.by.name))].sort(), ["Claude Code", "Codex", "Cursor", "GitHub Actions", "Jonas", "Maya"]);
  assert.equal(readJson(path.join(dir, "api", "project.json")).name, "fernwood");
  assert.match(fs.readFileSync(path.join(dir, "index.html"), "utf8"), /content="static demo"/);
  const captures = readJson(path.join(dir, "api", "captures.json")).captures;
  assert.ok(captures.some((c) => c.kind === "video"));
  for (const url of jsonFiles(dir).flatMap((file) => fileUrls(readJson(path.join(dir, file))))) assert.ok(fs.existsSync(path.join(dir, decodeURIComponent(url))), url);
});

test("vercel.json deploys the site, with the demo under /demo/ on the same single-page rewrite as an export", () => {
  // One Vercel project: the root vercel.json builds the site, and site/build.mjs exports the demo into /demo/.
  const v = readJson(path.join(REPO, "vercel.json"));
  // The site build, then the cloud's migrations (which do nothing outside a production build with a database).
  assert.equal(v.buildCommand, "node site/build.mjs && node cloud/scripts/pack-assets.mjs && node cloud/scripts/deploy-migrate.mjs");
  assert.equal(v.outputDirectory, "site/dist");
  assert.equal(v.framework, null);
  assert.deepEqual(v.rewrites.filter((r) => !r.has), [spaRewrite("/demo")]);
  // The same project serves Imitor Cloud, but only on its own host (cloud/src/vercel.mjs checks the host again).
  for (const r of [...v.rewrites, ...v.redirects].filter((x) => x.has)) assert.deepEqual(r.has, [{ type: "host", value: "app.imitor.dev" }]);
  // With trailingSlash the function answers at /api/cloud/; a rewrite to /api/cloud (no slash) finds nothing and the
  // site's 404 page answers instead.
  assert.ok(v.rewrites.filter((r) => r.has).every((r) => r.destination.startsWith("/api/cloud/?")));
  assert.ok(!fs.existsSync(path.join(REPO, "demo", "vercel.json")), "the demo has no Vercel project of its own");
  const re = new RegExp("^" + spaRewrite("/demo").source + "$");
  for (const p of ["/demo/", "/demo/runs", "/demo/runs/20261111T185759-7c77065", "/demo/problems/p_abc123", "/demo/captures"]) assert.ok(re.test(p), p);
  for (const p of ["/", "/how-to-use/", "/demo/app.js", "/demo/api/runs.json", "/demo/files/runs/x/screens/a.png", "/demo/assets/imitor-icon-32.svg", "/demo/api/runs/missing"]) assert.ok(!re.test(p), p);
  const root = new RegExp("^" + SPA_REWRITE.source + "$");
  for (const p of ["/", "/runs", "/runs/20261111T185759-7c77065"]) assert.ok(root.test(p), p);
  for (const p of ["/app.js", "/api/runs.json", "/files/runs/x/screens/a.png"]) assert.ok(!root.test(p), p);
});

test("--base: the export works under a sub-path", (t) => {
  assert.equal(normalizeBase("demo/"), "/demo");
  assert.equal(normalizeBase("/a/b"), "/a/b");
  assert.equal(normalizeBase("/"), "");
  assert.equal(normalizeBase(""), "");
  assert.equal(normalizeBase("//evil.example"), "/evil.example", "a host-looking value is only ever a path");
  for (const bad of ["/../x", "/a b", "/x?y"]) assert.throws(() => normalizeBase(bad), /--base needs a path/, bad);
  const dir = tmp("demo-base");
  const site = buildDemo({ out: dir, base: "/demo" });
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  assert.equal(site.base, "/demo");
  assert.deepEqual(site.missing, []);
  const index = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  assert.match(index, /<meta name="imitor-base" content="\/demo">/);
  assert.match(index, /href="\/demo\/app\.css"/);
  assert.match(index, /src="\/demo\/app\.js"/);
  assert.doesNotMatch(index, /(href|src)="\/(?!demo\/|\/)/, "no root path is left in index.html");
  const urls = jsonFiles(dir).flatMap((file) => [...JSON.stringify(readJson(path.join(dir, file))).matchAll(/"(\/[a-z]*\/?files\/[^"]+)"/g)].map((m) => m[1]));
  assert.ok(urls.length > 10);
  for (const url of urls) {
    assert.ok(url.startsWith("/demo/files/"), url);
    assert.ok(fs.existsSync(path.join(dir, decodeURIComponent(url.slice("/demo".length)))), url);
  }
  assert.deepEqual(readJson(path.join(dir, "vercel.json")).rewrites, [spaRewrite("/demo")]);
  assert.match(fs.readFileSync(path.join(dir, "_redirects"), "utf8"), /^\/demo\/\*  \/demo\/index\.html  200$/m);
});

test("the interface has no hard-coded root paths, so it works under a base", () => {
  // Every app link, image and history call goes through withBase (src/app/base.js); a literal "/..." would leave the base.
  const files = fs.readdirSync(path.join(REPO, "src", "app"), { recursive: true }).filter((f) => f.endsWith(".js"));
  for (const f of files) {
    const text = fs.readFileSync(path.join(REPO, "src", "app", f), "utf8");
    assert.doesNotMatch(text, /\b(href|src)="\/(?!\/)/, `${f} has a literal root href or src`);
    assert.doesNotMatch(text, /url\(\/(?!\/)/, `${f} has a literal root url()`);
    assert.doesNotMatch(text, /history\.(push|replace)State\([^,]*,\s*[^,]*,\s*["`]\//, `${f} pushes a literal root path`);
  }
});
