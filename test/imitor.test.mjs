import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { MEDIA_OVERRIDE, patchHtml } from "../src/build.mjs";

const require = createRequire(import.meta.url);

test("patchHtml moves app scripts behind the boot loader, in order", () => {
  const html = `<html><body><div id="root"></div><script src="/_expo/static/js/web/a.js" defer></script><script src="/_expo/static/js/web/b.js" defer></script><script src="https://x/other.js"></script></body></html>`;
  const out = patchHtml(html);
  assert.ok(!out.includes('<script src="/_expo/static/js/web/a.js"'));
  assert.ok(out.includes('["/_expo/static/js/web/a.js","/_expo/static/js/web/b.js"]'));
  assert.ok(out.includes('<script src="https://x/other.js"></script>'));
  assert.ok(out.startsWith(MEDIA_OVERRIDE), "the scheme override runs before anything else");
  assert.equal(patchHtml(out), out, "patching twice changes nothing");
});

test("patchHtml adds the scheme override to every page, with or without the boot loader", () => {
  const html = `<html><head><title>x</title></head><body><script src="/_expo/a.js" defer></script></body></html>`;
  const out = patchHtml(html, { boot: false });
  assert.equal(out, html.replace("<head>", "<head>" + MEDIA_OVERRIDE), "app scripts stay where they were");
  assert.equal(patchHtml("<body></body>", { boot: false }), MEDIA_OVERRIDE + "<body></body>");
});

/** Run the override in a fake window with the given address and session storage. */
function runOverride(href, stored = {}) {
  const store = new Map(Object.entries(stored));
  const listeners = [];
  const realMql = (q) => ({ media: q, matches: q.includes("light"), addEventListener: (t, f) => listeners.push(f), addListener: (f) => listeners.push(f) });
  const win = {
    location: new URL(href),
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    matchMedia: realMql,
    history: { state: null, replaceState(_s, _t, url) { win.location = new URL(url, win.location.href); } },
  };
  const src = MEDIA_OVERRIDE.replace(/^<script>|<\/script>$/g, "");
  new Function("window", "location", "history", "URL", src.replace(/location\.href/g, "window.location.href"))(win, win.location, win.history, URL);
  return { win, store, listeners };
}

test("scheme override: ?imitor-scheme answers prefers-color-scheme and survives reloads; motion likewise", () => {
  const { win, store, listeners } = runOverride("http://127.0.0.1:5000/today?imitor-scheme=dark&imitor-motion=reduce&tab=2");
  assert.deepEqual(win.__imitorMedia, { version: 1, scheme: "dark", motion: "reduce" });
  assert.equal(win.location.href, "http://127.0.0.1:5000/today?tab=2", "the parameters leave the address before the app reads it");
  assert.equal(win.matchMedia("(prefers-color-scheme: dark)").matches, true);
  assert.equal(win.matchMedia("(prefers-color-scheme: light)").matches, false);
  assert.equal(win.matchMedia("(prefers-reduced-motion: reduce)").matches, true);
  assert.equal(win.matchMedia("(prefers-reduced-motion)").matches, true);
  const mql = win.matchMedia("(prefers-color-scheme: dark)");
  mql.addEventListener("change", () => {});
  mql.addListener(() => {});
  assert.equal(listeners.length, 0, "change listeners on an overridden query never reach the real one");
  assert.equal(win.matchMedia("(min-width: 400px)").media, "(min-width: 400px)", "other queries pass through");
  assert.equal(store.get("imitor-scheme"), "dark");

  const reload = runOverride("http://127.0.0.1:5000/", Object.fromEntries(store));
  assert.equal(reload.win.matchMedia("(prefers-color-scheme: dark)").matches, true, "a reload keeps the stored scheme");
  const cleared = runOverride("http://127.0.0.1:5000/?imitor-scheme=auto", Object.fromEntries(store));
  assert.equal(cleared.win.__imitorMedia.scheme, null);
  assert.equal(cleared.win.matchMedia("(prefers-color-scheme: light)").matches, true, "auto hands the question back to the system");
  const none = runOverride("http://127.0.0.1:5000/");
  assert.deepEqual(none.win.__imitorMedia, { version: 1, scheme: null, motion: null });
});

test("inert stand-in: any export is callable, components render nothing", () => {
  const stub = require("../src/shims/inert.js");
  assert.equal(stub.Anything(), null);
  assert.doesNotThrow(() => stub.Skia.Path.Make().moveTo(1, 2).close());
  assert.doesNotThrow(() => stub.useSharedValue(0).value);
  assert.equal(`${stub.configure({ a: 1 })}`, "");
  assert.equal(stub.somePromiseLike.then, undefined);
});

test("expo-sqlite stand-in: sync API, params, transactions, reload persistence", async () => {
  const store = new Map();
  globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const SQL = await require("sql.js/dist/sql-wasm.js")();
  globalThis.__imitor = { SQL };
  const SQLite = require("../src/shims/expo-sqlite.js");

  const db = SQLite.openDatabaseSync("t.db");
  db.execSync("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; CREATE TABLE a (id INTEGER PRIMARY KEY, name TEXT, on_ INTEGER);");
  const r = db.runSync("INSERT INTO a (name, on_) VALUES (?, ?)", "x", true);
  assert.deepEqual(r, { changes: 1, lastInsertRowId: 1 });
  db.runSync("INSERT INTO a (name, on_) VALUES (?, ?)", ["y", undefined]);
  db.runSync("INSERT INTO a (name) VALUES ($n)", { $n: "z" });
  assert.equal(db.getAllSync("SELECT * FROM a").length, 3);
  assert.deepEqual(db.getFirstSync("SELECT name, on_ FROM a WHERE id = ?", 1), { name: "x", on_: 1 });
  assert.equal(db.getFirstSync("SELECT * FROM a WHERE id = 99"), null);
  assert.equal(db.getAllSync("PRAGMA table_info(a)").length, 3);

  assert.throws(() =>
    db.withTransactionSync(() => {
      db.runSync("DELETE FROM a");
      throw new Error("boom");
    })
  );
  assert.equal(db.getAllSync("SELECT * FROM a").length, 3);

  await new Promise((done) => setTimeout(done, 10)); // let the mirror flush
  const again = SQLite.openDatabaseSync("t.db");
  assert.equal(again.getAllSync("SELECT * FROM a").length, 3);
  assert.equal((await again.getFirstAsync("SELECT count(*) AS n FROM a")).n, 3);
});

test("metro: stand-ins replace a module on web only, and a stand-in that imports what it replaces gets the real module", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-metro-"));
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify({ shims: { "some-sdk": "./stand-ins/some-sdk.js", "native-thing": "inert" } }));
  const before = process.env.IMITOR;
  process.env.IMITOR = "1";
  try {
    const { withImitor } = require("../src/metro.cjs");
    const real = (context, moduleName) => ({ type: "sourceFile", filePath: `/real/${moduleName}` });
    const { resolver } = withImitor({ projectRoot: root, resolver: { resolveRequest: real } });
    const from = (originModulePath) => ({ originModulePath });
    const own = path.join(root, "stand-ins", "some-sdk.js");
    assert.equal(resolver.resolveRequest(from(path.join(root, "app.js")), "some-sdk", "web").filePath, own);
    assert.equal(resolver.resolveRequest(from(path.join(root, "app.js")), "some-sdk/sub", "web").filePath, own);
    assert.equal(resolver.resolveRequest(from(path.join(root, "app.js")), "some-sdk", "ios").filePath, "/real/some-sdk");
    assert.equal(resolver.resolveRequest(from(own), "some-sdk", "web").filePath, "/real/some-sdk");
    assert.match(resolver.resolveRequest(from(own), "native-thing", "web").filePath, /shims[\\/]inert\.js$/);
  } finally {
    if (before === undefined) delete process.env.IMITOR;
    else process.env.IMITOR = before;
  }
});
