// Runs cloud/migrations/*.sql in name order, each in its own transaction, and records each in schema_migrations so it
// runs once. An advisory lock keeps two servers starting at once from running the same file twice.
//   DATABASE_URL=postgres://... node cloud/src/db/migrate.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));
const LOCK = 7301946; // any constant; the same one for every server

/** The .sql files of `dir`, in the order they run. */
export const migrationFiles = (dir = MIGRATIONS_DIR) => fs.readdirSync(dir).filter((f) => /^\d+_[\w-]+\.sql$/.test(f)).sort();

/** Apply what has not run yet on `pool` (a pg Pool). Returns the names it applied. */
export async function migrate(pool, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK]);
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const done = new Set((await client.query("select name from schema_migrations")).rows.map((r) => r.name));
    for (const name of migrationFiles(dir)) {
      if (done.has(name)) continue;
      try {
        await client.query("begin");
        await client.query(fs.readFileSync(path.join(dir, name), "utf8"));
        await client.query("insert into schema_migrations (name) values ($1)", [name]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw new Error(`migration ${name} failed: ${error.message}`);
      }
      applied.push(name);
      log(`applied ${name}`);
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK]).catch(() => {});
    client.release();
  }
  return applied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) {
    console.error("Set DATABASE_URL to the Postgres database to migrate.");
    process.exit(1);
  }
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const applied = await migrate(pool, { log: (line) => console.log(line) });
    console.log(applied.length ? `${applied.length} migration(s) applied.` : "Nothing to apply: the database is up to date.");
  } finally {
    await pool.end();
  }
}
