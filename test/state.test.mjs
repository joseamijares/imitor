import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { describe, recordVideo, runFlow, screenshot } from "../src/agent.mjs";
import { projectData, startAppServer } from "../src/appserver.mjs";
import { patchHtml } from "../src/build.mjs";
import { loadConfig } from "../src/config.mjs";
import { evaluate } from "../src/gate.mjs";
import { writeReport } from "../src/report.mjs";
import { serve } from "../src/serve.mjs";
import { shoot } from "../src/shoot.mjs";
import { flowChain } from "../src/state.mjs";
import { flowDetail, listCaptures, recordCaptures } from "../src/store.mjs";

const require = createRequire(import.meta.url);
let hasPlaywright = true;
try { require("playwright"); } catch { hasPlaywright = false; }
const browser = { skip: hasPlaywright ? false : "playwright is not installed" };

function project(config, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-state-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fernwood" }));
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify(config));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body);
  return root;
}

// ---------- config ----------

test("config: after, state, seed and clock come from the flow, else the top level; null opts out", () => {
  const root = project({
    shims: { "expo-sqlite": "sqljs" },
    after: "welcome",
    state: "signed-in",
    clock: "2026-03-14T09:30:00+02:00",
    seed: { storage: { "onboarding-done": "true" } },
    flows: [
      { name: "welcome", start: "/", steps: [{ shot: "a" }] },
      { name: "garden", steps: [{ shot: "b" }] },
      { name: "signed-out", state: null, seed: null, after: null, clock: null, steps: [{ shot: "c" }] },
      { name: "seeded", seed: { sql: "seed.sql", database: "garden.db" }, state: "guest", steps: [{ shot: "d" }] },
    ],
  }, { "seed.sql": "CREATE TABLE plants (name TEXT); INSERT INTO plants VALUES ('Fern');" });
  const c = loadConfig(root);
  const f = Object.fromEntries(c.flows.map((x) => [x.name, x]));
  assert.equal(f.welcome.after, null, "the top-level after does not apply to the flow it names");
  assert.equal(f.welcome.state, "signed-in");
  assert.equal(f.garden.after, "welcome");
  assert.equal(f.garden.clock, "2026-03-14T07:30:00.000Z");
  assert.deepEqual(f.garden.seed, { storage: { "onboarding-done": "true" }, sql: null, sqlFile: null, database: null });
  assert.deepEqual([f["signed-out"].after, f["signed-out"].state, f["signed-out"].seed, f["signed-out"].clock], [null, null, null, null]);
  assert.equal(f.seeded.seed.storage, null, "a flow's seed replaces the top-level seed whole");
  assert.deepEqual(f.seeded.seed.sql, ["CREATE TABLE plants (name TEXT); INSERT INTO plants VALUES ('Fern');"]);
  assert.equal(f.seeded.seed.sqlFile, "seed.sql");
  assert.equal(c.defaults.state, "signed-in");
});

test("config: unknown flows, cycles and bad values are errors when the config loads", () => {
  const base = { shims: {}, flows: [{ name: "a", steps: [] }, { name: "b", steps: [] }] };
  const load = (over) => () => loadConfig(project({ ...base, ...over }));
  assert.throws(load({ flows: [{ name: "a", after: "nope", steps: [] }] }), /flow "a" runs after "nope", which is not a flow/);
  assert.throws(load({ after: "nope" }), /"after": "nope" names no flow/);
  assert.throws(load({ flows: [{ name: "a", after: "b" }, { name: "b", after: "c" }, { name: "c", after: "a" }] }), /flows "a" -> "b" -> "c" -> "a" run after each other in a cycle/);
  assert.throws(load({ flows: [{ name: "a", after: "a" }] }), /cycle/);
  assert.throws(load({ clock: "next tuesday" }), /"clock" must be an ISO date-time/);
  assert.throws(load({ state: 3 }), /"state" must be a string/);
  assert.throws(load({ seed: { storage: { k: { a: 1 } } } }), /value for "k" must be a string/);
  assert.throws(load({ seed: { sql: ["SELECT 1"] } }), /"seed.sql" needs the sqljs stand-in/);
  assert.throws(load({ shims: { "expo-sqlite": "sqljs" }, seed: { sql: "missing.sql" } }), /missing.sql does not exist/);
  assert.throws(load({ seed: { rows: [] } }), /unknown key "seed.rows"/);
  // A top-level after with a chain under it: the flows of that chain do not inherit it (no cycle).
  const ok = loadConfig(project({ after: "b", flows: [{ name: "a", steps: [] }, { name: "b", after: "a", steps: [] }, { name: "c", steps: [] }] }));
  assert.deepEqual(ok.flows.map((f) => f.after), [null, "a", "b"]);
});

test("flowChain: the outermost flow's start, then each flow's steps without its shots, then the flow's own start", () => {
  const config = loadConfig(project({ flows: [
    { name: "welcome", start: "/welcome", steps: [{ shot: "w" }, { tap: "Continue" }] },
    { name: "name", after: "welcome", steps: [{ fill: { placeholder: "Name", value: "Ada" } }, { shot: "n" }, { tap: "Next" }] },
    { name: "settings", after: "name", start: "/settings", steps: [{ shot: "s" }] },
  ] }));
  const [welcome, name, settings] = config.flows;
  assert.deepEqual(flowChain(config, welcome), { start: "/welcome", before: [] });
  assert.deepEqual(flowChain(config, name), { start: "/welcome", before: [{ flow: "welcome", index: 2, step: { tap: "Continue" } }] });
  assert.deepEqual(flowChain(config, settings).before.map((b) => [b.flow, b.index, Object.keys(b.step)[0]]), [["welcome", 2, "tap"], ["name", 1, "fill"], ["name", 3, "tap"], ["settings", 0, "goto"]]);
  const d = describe(project({ flows: [{ name: "a", state: "signed-in", seed: { storage: { k: "v" } }, steps: [] }, { name: "b", after: "a", steps: [] }] }));
  assert.deepEqual(d.flows.map((f) => [f.name, f.start, f.after, f.state, f.seeded]), [["a", "/", null, "signed-in", true], ["b", null, "a", null, false]]);
});

// ---------- in a browser, with the real sqljs stand-in ----------

/**
 * A tiny built app: the real boot loader loads sql.js, then the real src/shims/expo-sqlite.js, then the app, which opens
 * garden.db, creates its table if missing, and shows its rows, the state its stand-in was handed, a stored value and
 * today's date. A button adds a row.
 */
function sqlApp(config) {
  const root = project({ shims: { "expo-sqlite": "sqljs" }, ...config });
  const app = path.join(root, "preview", "app");
  fs.mkdirSync(path.join(app, "_expo"), { recursive: true });
  fs.mkdirSync(path.join(app, "_imitor"), { recursive: true });
  const dist = path.dirname(require.resolve("sql.js/dist/sql-wasm.js"));
  for (const f of ["sql-wasm.js", "sql-wasm.wasm"]) fs.copyFileSync(path.join(dist, f), path.join(app, "_imitor", f));
  fs.writeFileSync(path.join(app, "_expo", "0-module.js"), "var module = { exports: {} };");
  fs.writeFileSync(path.join(app, "_expo", "1-shim.js"), fs.readFileSync(new URL("../src/shims/expo-sqlite.js", import.meta.url), "utf8") + "\nwindow.SQLite = module.exports;");
  fs.writeFileSync(path.join(app, "_expo", "2-app.js"), `
    var db = SQLite.openDatabaseSync("garden.db");
    db.execSync("CREATE TABLE IF NOT EXISTS plants (name TEXT)");
    function render() {
      var names = db.getAllSync("SELECT name FROM plants ORDER BY rowid").map(function (r) { return r.name; });
      document.getElementById("out").innerHTML = "<p>plants: " + names.join(",") + "</p><p>state: " + globalThis.__imitor.state + "</p><p>stored: " + localStorage.getItem("greeting") + "</p><p>today: " + new Date().toISOString().slice(0, 10) + "</p>";
    }
    document.getElementById("add").onclick = function () { db.runSync("INSERT INTO plants (name) VALUES (?)", "Rose"); render(); };
    render();`);
  const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><button id="add">Add plant</button><div id="out"></div>${["0-module", "1-shim", "2-app"].map((n) => `<script src="/_expo/${n}.js" defer></script>`).join("")}</body></html>`;
  fs.writeFileSync(path.join(app, "index.html"), patchHtml(page));
  return root;
}

const GARDEN = {
  flows: [
    { name: "setup", start: "/", steps: [{ shot: "empty" }, { tap: "Add plant" }, { waitFor: { text: "Rose", exact: false } }] },
    {
      name: "garden",
      after: "setup",
      state: "signed-in",
      clock: "2026-03-14T09:30:00Z",
      seed: { storage: { greeting: "hello" }, sql: ["CREATE TABLE plants (name TEXT); INSERT INTO plants VALUES ('Fern');"] },
      steps: [{ waitFor: "plants: Fern,Rose" }, { waitFor: "state: signed-in" }, { waitFor: "stored: hello" }, { waitFor: "today: 2026-03-14" }, { shot: "garden" }, { goto: "/" }, { waitFor: "plants: Fern,Rose" }, { shot: "reloaded" }],
    },
    { name: "bad-seed", seed: { sql: ["CREATE TABLE plants (name TEXT)", "INSERT INTO plants VALUES ('Fern'); INSERT INTO nowhere VALUES (1); INSERT INTO plants VALUES ('Moss')", "INSER plants", "INSERT INTO plants VALUES ('Ivy')"] }, steps: [{ waitFor: "plants: Fern,Ivy" }, { shot: "bad" }] },
    { name: "wrong-db", seed: { sql: ["SELECT 1"], database: "other.db" }, steps: [{ shot: "x" }] },
  ],
};
// "setup" inherits nothing, so it starts empty; garden's seed is applied once, at the first open of garden.db, before
// the app's CREATE TABLE IF NOT EXISTS, and not again on the reload ("Fern" stays single).

test("seed.sql, seed.storage, state, clock and after on the real sqljs stand-in (imitor flow)", browser, async () => {
  const root = sqlApp(GARDEN);
  const garden = await runFlow(root, { flow: "garden" });
  assert.equal(garden.passed, true, JSON.stringify(garden.steps.filter((s) => !s.ok)));
  assert.deepEqual(garden.steps.filter((s) => s.after).map((s) => [s.after, s.index, s.action]), [["setup", 2, "tap"], ["setup", 3, "waitFor"]]);
  assert.deepEqual(garden.shots.map((s) => s.shot), ["garden", "reloaded"]);
  assert.deepEqual([garden.after, garden.state, garden.seeded, garden.clock], ["setup", "signed-in", true, "2026-03-14T09:30:00.000Z"]);
  assert.deepEqual(garden.seedErrors, []);

  const bad = await runFlow(root, { flow: "bad-seed" });
  assert.equal(bad.failedAt, null, "a failed statement stops the rest of its entry only: later entries ran ('Ivy', not 'Moss')");
  assert.equal(bad.passed, false, "but a failed seed statement fails the flow");
  assert.equal(bad.seedErrors.length, 2);
  assert.match(bad.seedErrors[0], /^seed statement failed: INSERT INTO nowhere VALUES \(1\);: no such table: nowhere \(the statements after it in the same entry did not run\)$/);
  assert.match(bad.seedErrors[1], /^seed statement failed: INSER plants: near "INSER": syntax error$/);

  const wrong = await runFlow(root, { flow: "wrong-db" });
  assert.equal(wrong.passed, false);
  assert.match(wrong.seedErrors[0], /never opened the database "other.db"/);

  const shot = await screenshot(root, { flow: "garden", name: "garden-shot" });
  assert.equal(shot.failedAt, null);
  assert.equal(shot.state, "signed-in");
  const asGuest = await screenshot(root, { route: "/", state: "guest", name: "guest" });
  assert.equal(asGuest.state, "guest");
  const video = await recordVideo(root, { flow: "garden", holdMs: 50 });
  assert.equal(video.passed, true);
  assert.equal(video.seeded, true);
  const out = path.join(root, "preview");
  recordCaptures(out, root, "flow", garden, { name: "Test", kind: "person" });
  assert.deepEqual(listCaptures(out).map((c) => [c.state, c.seeded]), [["signed-in", true], ["signed-in", true]]);
});

test("a failing step in a flow it runs after is reported against that flow", browser, async () => {
  const root = sqlApp({ flows: [{ name: "setup", steps: [{ tap: "No such button" }] }, { name: "garden", after: "setup", steps: [{ shot: "g" }] }] });
  const r = await runFlow(root, { flow: "garden" });
  assert.equal(r.passed, false);
  assert.deepEqual([r.failedAt, r.failedIn], [1, "setup"]);
  assert.deepEqual(r.shots, []);
});

test("full run: shots and manifest record each flow's state, seed problems are problems, the gate blocks on them", browser, async () => {
  const root = sqlApp(GARDEN);
  const config = { ...loadConfig(root), devices: [loadConfig(root).devices[0]], schemes: ["light"] };
  const server = await serve(path.join(root, "preview", "app"));
  let result;
  try {
    result = await shoot(root, config, server.url);
  } finally {
    await server.close();
  }
  const byShot = Object.fromEntries(result.shots.map((s) => [`${s.flow}/${s.shot}`, s]));
  assert.deepEqual(Object.keys(byShot).sort(), ["bad-seed/bad", "garden/garden", "garden/reloaded", "setup/empty", "wrong-db/x"]);
  assert.deepEqual([byShot["garden/garden"].state, byShot["garden/garden"].seeded, byShot["garden/garden"].clock], ["signed-in", true, "2026-03-14T09:30:00.000Z"]);
  assert.deepEqual([byShot["setup/empty"].state, byShot["setup/empty"].seeded], [null, false]);
  assert.equal(result.problems.filter((p) => p.kind === "flow-failed").length, 0, JSON.stringify(result.problems));
  const seed = result.problems.filter((p) => p.kind === "seed-failed");
  assert.deepEqual(seed.map((p) => p.flow), ["bad-seed", "bad-seed", "wrong-db"]);
  const manifest = writeReport(root, config, result);
  assert.deepEqual(manifest.flows.find((f) => f.name === "garden"), { name: "garden", after: "setup", state: "signed-in", seeded: true, clock: "2026-03-14T09:30:00.000Z" });
  const verdict = evaluate(manifest);
  assert.equal(verdict.passed, false);
  assert.match(verdict.reasons.join(), /3 seed problems/);
  const detail = flowDetail(config, manifest);
  const g = detail.find((f) => f.name === "garden");
  assert.deepEqual([g.state, g.seeded, g.steps[0].state, g.steps[0].seeded], ["signed-in", true, "signed-in", true]);
  // An older manifest (no flows, shots without state) still reads.
  const old = flowDetail(config, { shots: result.shots.map(({ state, seeded, clock, ...s }) => s), problems: [] });
  assert.equal(old.find((f) => f.name === "garden").steps[0].seeded, false);
});

test("live preview: ?imitor-flow= starts the page with the flow's state, seed and clock, once per session", browser, async (t) => {
  const root = sqlApp(GARDEN);
  const p = projectData(root);
  const garden = p.flows.find((f) => f.name === "garden");
  assert.deepEqual([garden.after, garden.state, garden.seeded, garden.clock, garden.start], ["setup", "signed-in", true, "2026-03-14T09:30:00.000Z", null]);
  assert.deepEqual([garden.chain.start, garden.chain.before.map((b) => `${b.flow}:${b.index}:${b.label}`)], ["/", ["setup:2:Add plant", "setup:3:Rose"]]);
  const server = await startAppServer(root, { port: 0 });
  t.after(() => server.close());
  const { chromium } = require("playwright");
  const b = await chromium.launch();
  t.after(() => b.close());
  const page = await b.newPage();
  await page.goto(server.previewUrl + "/?imitor-flow=garden");
  const text = () => page.locator("#out").innerText();
  await page.waitForFunction(() => /plants:/.test(document.body.innerText));
  assert.equal(new URL(page.url()).search, "", "the parameter leaves the address before the app reads it");
  assert.match(await text(), /plants: Fern\n.*state: signed-in\n.*stored: hello\n.*today: 2026-03-14/s);
  await page.click("text=Add plant");
  await page.waitForTimeout(50);
  await page.reload();
  await page.waitForFunction(() => /plants:/.test(document.body.innerText));
  assert.match(await text(), /plants: Fern,Rose\n.*state: signed-in/s, "a reload keeps the flow and does not seed again");
  await page.goto(server.previewUrl + "/?imitor-flow=");
  await page.waitForFunction(() => /plants:/.test(document.body.innerText));
  assert.match(await text(), /state: null/);
});

test("prelude: state survives a boot loader that replaces globalThis.__imitor (builds from before this version)", browser, async (t) => {
  const { preludeSource } = await import("../src/state.mjs");
  const { chromium } = require("playwright");
  const b = await chromium.launch();
  t.after(() => b.close());
  const page = await b.newPage();
  await page.addInitScript({ content: preludeSource({ a: { state: "signed-in", storage: { k: "v" }, sql: null, database: null, clock: null } }, { pick: "a" }) });
  await page.goto("data:text/html,<p>x</p>").catch(() => {});
  const server = await serve(fs.mkdtempSync(path.join(os.tmpdir(), "imitor-prelude-")));
  t.after(() => server.close());
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: "<script>globalThis.__imitor = { SQL: 1 }; document.title = [globalThis.__imitor.state, globalThis.__imitor.SQL, localStorage.getItem('k')].join()</script>" }));
  await page.goto(server.url + "/");
  assert.equal(await page.title(), "signed-in,1,v");
});
