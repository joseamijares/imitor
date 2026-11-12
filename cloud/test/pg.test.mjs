// The Postgres repository when the database cannot answer: a request gets a plain 503 in seconds instead of hanging,
// and the pool is made with its timeouts and an error listener. No Postgres is needed: a closed port, a socket that
// never answers, and a fake pool stand in for it.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import test from "node:test";
import { handle, UNAVAILABLE } from "../src/api.mjs";
import { isPooled, isUnavailable, pgDb, TIMEOUTS } from "../src/db/pg.mjs";
import { cronFunction } from "../src/vercel.mjs";
import { cloud, HTML, PUBLIC_URL } from "./helpers.mjs";

let pg = null;
try {
  pg = (await import("pg")).default;
} catch {} // cloud/ dependencies not installed: the tests that need the driver are skipped
const needsPg = { skip: !pg && "pg is not installed (npm ci --prefix cloud)" };

/** A port nothing listens on. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A server that accepts connections and never says a word, like a database behind a dead pooler. */
async function silentServer(t) {
  const sockets = new Set();
  const server = net.createServer((socket) => { sockets.add(socket); socket.on("error", () => {}); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(resolve); }));
  return server.address().port;
}

const refused = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
/** A pg Pool look-alike whose database is gone. */
const deadPool = () => ({ query: async () => { throw refused(); }, connect: async () => { throw refused(); }, end: async () => {} });

test("which errors mean the database cannot answer", () => {
  for (const e of [refused(), { code: "ETIMEDOUT" }, { code: "ENOTFOUND" }, { code: "08006" }, { code: "57P01" }, { code: "53300" }, { code: "57014" }, new Error("timeout exceeded when trying to connect"), new Error("Connection terminated unexpectedly"), new AggregateError([refused()], "")]) assert.equal(isUnavailable(e), true, String(e.code || e.message));
  for (const e of [{ code: "23505" }, { code: "42P01" }, new Error("syntax error at or near x"), null]) assert.equal(isUnavailable(e), false, String(e?.code || e?.message));
});

test("an unreachable database answers 503 with a plain message, as JSON or as a page", async () => {
  const c = cloud({ adminToken: crypto.randomBytes(32).toString("base64url") });
  c.deps.db = pgDb({ pool: deadPool() });
  const cookie = { cookie: "__Host-imitor_session=abc" };
  const api = await handle(new Request(`${PUBLIC_URL}/projects`, { headers: cookie }), c.deps);
  assert.equal(api.status, 503);
  assert.deepEqual(await api.json(), { error: UNAVAILABLE });
  assert.equal(api.headers.get("retry-after"), "30");
  assert.equal(api.headers.get("x-content-type-options"), "nosniff");
  const page = await handle(new Request(`${PUBLIC_URL}/projects`, { headers: { ...cookie, ...HTML } }), c.deps);
  assert.equal(page.status, 503);
  assert.match(await page.text(), /Imitor Cloud is unavailable/);
  const push = await handle(new Request(`${PUBLIC_URL}/v1/runs`, { method: "POST", headers: { authorization: "Bearer imk_x" }, body: "{}" }), c.deps);
  assert.equal(push.status, 503, "an upload hears to retry, not that its key is wrong");
  await assert.rejects(c.deps.db.transaction(async () => {}), { code: "unavailable" });
  // A wrong query is still a 500, not a 503.
  c.deps.db = pgDb({ pool: { query: async () => { throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); } } });
  assert.equal((await handle(new Request(`${PUBLIC_URL}/projects`, { headers: cookie }), c.deps)).status, 500);
});

test("the Vercel cron function answers 503 too when the database is unreachable", async () => {
  const secret = crypto.randomBytes(32).toString("base64url");
  const c = cloud();
  c.deps.db = pgDb({ pool: deadPool() });
  const res = await cronFunction({ VERCEL_ENV: "production", CRON_SECRET: secret }, { deps: c.deps }).fetch(new Request("https://x/api/cron-retention/", { headers: { authorization: `Bearer ${secret}` } }));
  assert.equal(res.status, 503);
});

test("the pool: connect, idle and statement timeouts, and an error listener for idle connections", needsPg, async (t) => {
  const logged = [];
  const db = pgDb({ connectionString: "postgres://u:p@127.0.0.1:1/x", log: (e) => logged.push(e) });
  t.after(() => db.close());
  const pool = await db.pool();
  assert.deepEqual(TIMEOUTS, { connect: 5000, idle: 10000, statement: 10000 });
  assert.equal(pool.options.connectionTimeoutMillis, 5000);
  assert.equal(pool.options.idleTimeoutMillis, 10000);
  assert.equal(pool.options.statement_timeout, 10000);
  assert.ok(pool.options.query_timeout > 10000);
  assert.equal(pool.listenerCount("error"), 1);
  pool.emit("error", new Error("terminating connection due to administrator command"));
  assert.equal(logged.length, 1, "an idle connection's error is logged, and does not crash the process");
});

test("a closed port fails fast as unavailable", needsPg, async (t) => {
  const db = pgDb({ connectionString: `postgres://u:p@127.0.0.1:${await closedPort()}/x`, max: 1 });
  t.after(() => db.close());
  const started = Date.now();
  await assert.rejects(db.getUser("usr_x"), { code: "unavailable" });
  assert.ok(Date.now() - started < 3000);
});

test("a database that never answers fails after the connect timeout, not when the platform gives up", needsPg, async (t) => {
  const db = pgDb({ connectionString: `postgres://u:p@127.0.0.1:${await silentServer(t)}/x`, max: 1, timeouts: { connect: 300 } });
  t.after(() => db.close());
  const started = Date.now();
  await assert.rejects(db.getUser("usr_x"), { code: "unavailable" });
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  const c = cloud();
  c.deps.db = db;
  const res = await handle(new Request(`${PUBLIC_URL}/projects`, { headers: { cookie: "__Host-imitor_session=abc" } }), c.deps);
  assert.equal(res.status, 503);
});

test("through a pooler the statement timeout is not sent as a startup parameter, which PgBouncer would refuse", needsPg, async (t) => {
  assert.equal(isPooled("postgres://u:p@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/db?sslmode=require"), true);
  assert.equal(isPooled("postgres://u:p@db.example.com:6432/db?pgbouncer=true"), true);
  assert.equal(isPooled("postgres://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/db?sslmode=require"), false);
  assert.equal(isPooled("not a url"), false);
  const db = pgDb({ connectionString: "postgres://u:p@ep-x-pooler.example.neon.tech/x" });
  t.after(() => db.close());
  const pool = await db.pool();
  assert.equal(pool.options.statement_timeout, undefined);
  assert.ok(pool.options.query_timeout > TIMEOUTS.statement, "the client still stops waiting");
});
