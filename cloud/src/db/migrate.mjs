// Runs cloud/migrations/*.sql in name order, each in its own transaction, and records each in schema_migrations so it
// runs once. Two servers starting at once cannot run the same file twice: each transaction first takes a
// transaction-level advisory lock (pg_advisory_xact_lock) and only then checks whether its file was applied. The lock
// ends with its transaction, so it works through a pooler in transaction mode (PgBouncer, Supavisor, Neon's pooled
// URL) as well as on a direct connection; a session-level lock would stay on whatever server connection the pooler
// happened to use.
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
  /** fn() in a transaction of its own that first takes the lock (held until commit or rollback); returns its result. */
  const locked = async (fn) => {
    try {
      await client.query("begin");
      // No statement timeout for a migration or its wait for the lock: the role's own (10 s on Vercel, set by
      // cloud/scripts/deploy-migrate.mjs) is for requests. "set local" ends with the transaction, so it is safe
      // through a pooler too.
      await client.query("set local statement_timeout = 0");
      await client.query("select pg_advisory_xact_lock($1)", [LOCK]);
      const done = await fn();
      await client.query("commit");
      return done;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  };
  try {
    await locked(() => client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())"));
    for (const name of migrationFiles(dir)) {
      const ran = await locked(async () => {
        // Checked under the lock: another server may have applied it since this one listed the files.
        if ((await client.query("select 1 from schema_migrations where name = $1", [name])).rows.length) return false;
        await client.query(fs.readFileSync(path.join(dir, name), "utf8"));
        await client.query("insert into schema_migrations (name) values ($1)", [name]);
        return true;
      }).catch((error) => {
        throw new Error(`migration ${name} failed: ${error.message}`);
      });
      if (!ran) continue;
      applied.push(name);
      log(`applied ${name}`);
    }
  } finally {
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
