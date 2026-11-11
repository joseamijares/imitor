import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { patchHtml } from "../src/build.mjs";

const require = createRequire(import.meta.url);

test("patchHtml moves app scripts behind the boot loader, in order", () => {
  const html = `<html><body><div id="root"></div><script src="/_expo/static/js/web/a.js" defer></script><script src="/_expo/static/js/web/b.js" defer></script><script src="https://x/other.js"></script></body></html>`;
  const out = patchHtml(html);
  assert.ok(!out.includes('<script src="/_expo/static/js/web/a.js"'));
  assert.ok(out.includes('["/_expo/static/js/web/a.js","/_expo/static/js/web/b.js"]'));
  assert.ok(out.includes('<script src="https://x/other.js"></script>'));
  assert.equal(patchHtml("<html><body></body></html>"), "<html><body></body></html>");
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
