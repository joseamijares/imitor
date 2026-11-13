#!/usr/bin/env node
// Runs in the Vercel build, after the site is built: on a production build with a database connected, it applies
// cloud/migrations/ (see src/db/migrate.mjs: each file once, under an advisory lock) and sets the role's statement
// timeout, which pooled connections cannot send themselves (see src/db/pg.mjs). A failure fails the build, so a
// deployment never goes live on a schema it does not expect. Anywhere else it does nothing.
//
// It prefers the direct connection (DATABASE_URL_UNPOOLED, which Vercel's Neon integration sets) over the pooled one.
import { pathToFileURL } from "node:url";
import { migrate } from "../src/db/migrate.mjs";
import { TIMEOUTS } from "../src/db/pg.mjs";

/** The database to migrate on this build, or null with the reason it is skipped. */
export function migrationTarget(env = process.env) {
  if (env.VERCEL_ENV !== "production") return { url: null, why: `not a production build (VERCEL_ENV=${env.VERCEL_ENV || "unset"})` };
  const url = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
  if (!url) return { url: null, why: "no database is connected (DATABASE_URL is not set)" };
  return { url, why: null };
}

/** The statement that caps every statement of the connected role, in seconds as TIMEOUTS.statement says. */
export const ROLE_TIMEOUT_SQL = `alter role current_user set statement_timeout = '${TIMEOUTS.statement / 1000}s'`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url, why } = migrationTarget();
  if (!url) {
    console.log(`Imitor Cloud migrations skipped: ${why}.`);
  } else {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15000 });
    try {
      const applied = await migrate(pool, { log: (line) => console.log(`Imitor Cloud: ${line}`) });
      await pool.query(ROLE_TIMEOUT_SQL);
      console.log(`Imitor Cloud: ${applied.length ? `${applied.length} migration(s) applied` : "the database is up to date"}; statement timeout set on the role.`);
    } finally {
      await pool.end();
    }
  }
}
