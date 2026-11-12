// The migration runner and the migrations themselves. The locking is checked on a fake connection everywhere; with
// DATABASE_URL, two runners race on a real Postgres, and the slug migrations are checked on week-1 style data, each
// in a schema of its own that is dropped afterwards.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { migrate, migrationFiles, MIGRATIONS_DIR } from "../src/db/migrate.mjs";

const SLUG = /^[a-z0-9-]{1,64}$/; // what web.mjs routes accept under /p/

/** A pg Pool look-alike that records every query; `applied` names count as already in schema_migrations. */
function fakePool(applied = []) {
  const queries = [];
  const client = {
    async query(text, values = []) {
      queries.push(values.length ? `${text} ${JSON.stringify(values)}` : text);
      if (/^select 1 from schema_migrations/.test(text)) return { rows: applied.includes(values[0]) ? [{ "?column?": 1 }] : [] };
      return { rows: [] };
    },
    release() { queries.push("release"); },
  };
  return { queries, async connect() { return client; } };
}

test("each migration runs in a transaction of its own that takes a transaction-level lock, then checks it was not applied", async () => {
  const files = migrationFiles();
  const pool = fakePool([files[0]]);
  assert.deepEqual(await migrate(pool), files.slice(1));
  const q = pool.queries;
  assert.ok(!q.some((x) => /pg_advisory_lock|pg_advisory_unlock/.test(x)), "no session-level lock, which a transaction-mode pooler would leak");
  assert.equal(q.at(-1), "release");
  // Every transaction: begin, no statement timeout (the role's 10 s is for requests), the lock, the work, commit.
  const transactions = q.join("\n").split("begin\n").slice(1).map((t) => t.split("\n").slice(1).join("\n"));
  assert.equal(transactions.length, files.length + 1, "one for schema_migrations, one per file");
  for (const t of q.join("\n").split("begin\n").slice(1)) assert.equal(t.split("\n")[0], "set local statement_timeout = 0");
  for (const t of transactions) {
    const lines = t.split("\n");
    assert.match(lines[0], /^select pg_advisory_xact_lock\(\$1\)/);
    assert.ok(lines.includes("commit"));
  }
  for (const [i, name] of files.entries()) {
    const t = transactions[i + 1].split("\n");
    assert.match(t[1], new RegExp(`^select 1 from schema_migrations where name = \\$1 \\["${name}"\\]`), "checked under the lock");
    assert.equal(t.some((x) => x.startsWith("insert into schema_migrations")), i > 0, `${name} applied only when not yet`);
  }
});

test("a failing migration is rolled back and named", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-migrations-"));
  fs.writeFileSync(path.join(dir, "001_bad.sql"), "select 1;");
  const pool = fakePool();
  const client = await pool.connect();
  const query = client.query;
  client.query = async (text, values) => (text === "select 1;" ? Promise.reject(new Error("boom")) : query(text, values));
  pool.connect = async () => client;
  await assert.rejects(migrate(pool, { dir }), /migration 001_bad\.sql failed: boom/);
  assert.equal(pool.queries.at(-2), "rollback");
  assert.equal(pool.queries.at(-1), "release");
  fs.rmSync(dir, { recursive: true, force: true });
});

const PG = process.env.DATABASE_URL;
const needsPg = { skip: !PG && "set DATABASE_URL to run against Postgres" };

/** A fresh schema and pools on it (search_path); everything is dropped after the test. */
async function schemaOf(t) {
  const { default: pg } = await import("pg");
  const schema = `imitor_migrate_${crypto.randomBytes(4).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: PG, max: 1 });
  await admin.query(`create schema ${schema}`);
  const pools = [];
  const pool = (max = 1) => {
    const p = new pg.Pool({ connectionString: PG, max, options: `-c search_path=${schema}` });
    pools.push(p);
    return p;
  };
  t.after(async () => {
    for (const p of pools) await p.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });
  return { schema, pool };
}

/** A folder with the first `n` migrations only. */
function firstMigrations(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-migrations-"));
  for (const f of migrationFiles().slice(0, n)) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  return dir;
}

test("Postgres: two runners at once apply each migration exactly once, and leave no lock behind", needsPg, async (t) => {
  const { pool } = await schemaOf(t);
  const a = pool();
  const b = pool();
  const [one, two] = await Promise.all([migrate(a), migrate(b)]);
  assert.deepEqual([...one, ...two].sort(), migrationFiles(), "every file once, between them");
  assert.deepEqual((await a.query("select name from schema_migrations order by name")).rows.map((r) => r.name), migrationFiles());
  for (const p of [a, b]) {
    const held = await p.query("select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()");
    assert.equal(held.rows[0].n, 0, "the lock ended with its transaction");
  }
  assert.deepEqual(await migrate(a), []);
});

test("Postgres: week-1 projects get a slug the routes accept", needsPg, async (t) => {
  const { pool } = await schemaOf(t);
  const p = pool();
  const dir = firstMigrations(1);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await migrate(p, { dir }), ["001_init.sql"]);
  await p.query("insert into projects (id, name) values ('prj_0a1b2c3d4e5f60718293', 'fernwood')");
  await migrate(p);
  const { rows } = await p.query("select slug from projects");
  assert.deepEqual(rows, [{ slug: "prj-0a1b2c3d4e5f60718293" }]);
  assert.match(rows[0].slug, SLUG);
});

test("Postgres: 003 repairs slugs an earlier 002 left as ids, and from then on only valid slugs are stored", needsPg, async (t) => {
  const { pool } = await schemaOf(t);
  const p = pool();
  const dir = firstMigrations(1);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await migrate(p, { dir });
  await p.query("insert into projects (id, name) values ('prj_aaaa', 'one'), ('prj_bbbb', 'two'), ('prj_cccc', 'prj cccc')");
  // 002 as it first was: the id as the slug.
  await p.query("alter table projects add column slug text; update projects set slug = id where slug is null; alter table projects alter column slug set not null; create unique index projects_slug on projects (slug)");
  await p.query("insert into schema_migrations (name) values ('002_project_slugs.sql')");
  // A project someone named so that its slug is what prj_cccc would become.
  await p.query("update projects set slug = 'prj-cccc' where id = 'prj_cccc'");
  await p.query("insert into projects (id, name, slug) values ('prj_dddd', 'x', 'prj_cccc')");
  assert.deepEqual(await migrate(p), migrationFiles().filter((f) => f >= "003"));
  const slugs = Object.fromEntries((await p.query("select id, slug from projects")).rows.map((r) => [r.id, r.slug]));
  assert.equal(slugs.prj_aaaa, "prj-aaaa");
  assert.equal(slugs.prj_bbbb, "prj-bbbb");
  assert.equal(slugs.prj_cccc, "prj-cccc", "a valid slug is left alone");
  assert.equal(slugs.prj_dddd, "prj-dddd");
  for (const s of Object.values(slugs)) assert.match(s, SLUG);
  await assert.rejects(p.query("insert into projects (id, name, slug) values ('prj_eeee', 'x', 'Not_Valid')"), { code: "23514" });
});

test("Postgres: when the repaired slug is taken, 003 adds a hash of the id", needsPg, async (t) => {
  const { pool } = await schemaOf(t);
  const p = pool();
  const dir = firstMigrations(2);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await migrate(p, { dir });
  await p.query("insert into projects (id, name, slug) values ('prj_ffff', 'x', 'prj_ffff'), ('prj_9999', 'y', 'prj-ffff')");
  await migrate(p);
  const { rows } = await p.query("select slug, md5('prj_ffff') as h from projects where id = 'prj_ffff'");
  assert.equal(rows[0].slug, `prj-ffff-${rows[0].h.slice(0, 8)}`);
});

test("the Vercel build migrates only a production build with a database, over the direct URL when there is one", async () => {
  const { migrationTarget, ROLE_TIMEOUT_SQL } = await import("../scripts/deploy-migrate.mjs");
  assert.equal(migrationTarget({ VERCEL_ENV: "preview", DATABASE_URL: "postgres://pooled" }).url, null);
  assert.equal(migrationTarget({ DATABASE_URL: "postgres://pooled" }).url, null);
  assert.match(migrationTarget({ VERCEL_ENV: "production" }).why, /no database/);
  assert.equal(migrationTarget({ VERCEL_ENV: "production", DATABASE_URL: "postgres://pooled" }).url, "postgres://pooled");
  assert.equal(migrationTarget({ VERCEL_ENV: "production", DATABASE_URL: "postgres://pooled", DATABASE_URL_UNPOOLED: "postgres://direct" }).url, "postgres://direct");
  assert.equal(ROLE_TIMEOUT_SQL, "alter role current_user set statement_timeout = '10s'");
});

test("the build step does nothing and succeeds outside production", () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/deploy-migrate.mjs", import.meta.url))], { env: { VERCEL_ENV: "preview", DATABASE_URL: "postgres://u:p@127.0.0.1:1/x" }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /skipped: not a production build/);
});
