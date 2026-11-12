// The repository on Postgres (cloud/migrations/), with the same methods and results as memory.mjs: CONTRACT.md lists
// them and test/db.test.mjs runs one suite against both. Every query is parameterised. Times come from `now` (the
// server's clock, like memory.mjs), not from the database, so retention behaves the same on either.
// `pg` is loaded only when this is used, so the memory adapters and their tests need no install.
import { hashSecret, KEY_PREFIX, newId, newSecret, slugAttempt, slugify } from "../ids.mjs";
import { LINE_KINDS } from "./memory.mjs";

const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const json = (v) => JSON.stringify(v);

const user = (r) => r && { id: r.id, email: r.email, name: r.name, allowed: r.allowed, createdAt: iso(r.created_at) };
const identity = (r) => r && { provider: r.provider, subject: r.subject, userId: r.user_id, createdAt: iso(r.created_at) };
const session = (r) => r && { idHash: r.id_hash, userId: r.user_id, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at) };
const project = (r) => r && { id: r.id, name: r.name, slug: r.slug, createdAt: iso(r.created_at) };
const member = (r) => r && { projectId: r.project_id, userId: r.user_id, role: r.role, createdAt: iso(r.created_at) };
const accessKey = (r) => r && {
  id: r.id, projectId: r.project_id, name: r.name, prefix: r.prefix, secretSha256: r.secret_sha256, createdAt: iso(r.created_at),
  lastUsedAt: iso(r.last_used_at), revokedAt: iso(r.revoked_at), expiresAt: iso(r.expires_at),
};
const run = (r) => r && {
  id: r.id, projectId: r.project_id, clientRunId: r.client_run_id, schemaVersion: r.schema_version, status: r.status, run: r.run,
  manifest: r.manifest, files: r.files, keyId: r.key_id, createdAt: iso(r.created_at), completedAt: iso(r.completed_at),
};
const RUN_COLUMNS = { status: "status", completedAt: "completed_at", run: "run", manifest: "manifest", files: "files" };
const JSON_COLUMNS = new Set(["run", "manifest", "files"]);

/**
 * Limits on every connection, so an unreachable or stuck database fails a request in seconds instead of holding it until
 * the platform kills it: connecting gives up after `connect` ms, an idle connection is closed after `idle` ms, and the
 * server cancels a statement after `statement` ms (statement_timeout, sent when the connection starts, except through a pooler: see
 * isPooled; `query_timeout` a little later is the client's own backstop).
 */
export const TIMEOUTS = { connect: 5000, idle: 10000, statement: 10000 };

/**
 * Whether `connectionString` points at a connection pooler (PgBouncer, as Neon's `-pooler` hosts are), which refuses
 * startup parameters it does not track, `statement_timeout` among them. Through a pooler the server-side limit comes
 * from the role instead (`ALTER ROLE <role> SET statement_timeout = '10s'`, see cloud/README.md), and `query_timeout`
 * still stops the client waiting.
 */
export function isPooled(connectionString) {
  try {
    const url = new URL(connectionString);
    return /-pooler(\.|$)/.test(url.hostname) || url.searchParams.get("pgbouncer") === "true";
  } catch {
    return false;
  }
}

const UNREACHABLE = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]);

/**
 * Whether `error` means the database cannot answer now, rather than that a query was wrong: no connection (refused,
 * reset, unknown host, timed out), a connection exception (SQLSTATE class 08), the server shutting down (57P01-57P03),
 * too many connections (53300), or a statement cancelled by statement_timeout (57014).
 */
export function isUnavailable(error) {
  const code = String(error?.code || "");
  if (UNREACHABLE.has(code) || /^08/.test(code) || /^57P0[123]$/.test(code) || code === "53300" || code === "57014") return true;
  if (error instanceof AggregateError && error.errors?.some(isUnavailable)) return true;
  return !/^[0-9A-Z]{5}$/.test(code) && /timeout exceeded when trying to connect|Connection terminated|Query read timeout|connection timeout/i.test(String(error?.message || ""));
}

/** An unavailable database as an error of its own (code "unavailable"), which handlers answer with 503. */
const unavailable = (error) => (isUnavailable(error) ? Object.assign(new Error(`the database cannot be reached: ${error.message || error.code}`), { code: "unavailable", cause: error }) : error);

/**
 * opts: { connectionString, pool (an existing pg Pool instead), schema (search_path, for tests), now, max, timeouts
 * (over TIMEOUTS), log (for errors of idle connections) }. Returns the repository plus `close()` and `pool()`. The pool
 * is made on first use, so this is synchronous.
 */
export function pgDb({ connectionString, pool = null, schema = null, now = () => new Date(), max = 5, timeouts = {}, log = (error) => console.error(error) } = {}) {
  const t = { ...TIMEOUTS, ...timeouts };
  let ready = pool ? Promise.resolve(pool) : null;
  const getPool = () => (ready ||= import("pg").then(({ default: pg }) => {
    const made = new pg.Pool({
      connectionString,
      max,
      connectionTimeoutMillis: t.connect,
      idleTimeoutMillis: t.idle,
      ...(isPooled(connectionString) ? {} : { statement_timeout: t.statement }),
      query_timeout: t.statement + 2000,
      ...(schema ? { options: `-c search_path=${schema}` } : {}),
    });
    // An idle connection that breaks (the server restarted, a pooler closed it) is reported here, not by a query;
    // without a listener it would crash the process. The pool replaces it on the next query.
    made.on("error", (error) => log(error));
    return made;
  }));
  const stamp = () => now().toISOString();
  const q = async (text, values = []) => {
    try {
      return (await (await getPool()).query(text, values)).rows;
    } catch (error) {
      throw unavailable(error);
    }
  };
  const one = async (text, values) => (await q(text, values))[0] ?? null;
  /** fn(query) inside one transaction, rolled back if it throws. */
  async function transaction(fn) {
    let client;
    try {
      client = await (await getPool()).connect();
    } catch (error) {
      throw unavailable(error);
    }
    let broken = null;
    try {
      await client.query("begin");
      const result = await fn(async (text, values = []) => (await client.query(text, values)).rows);
      await client.query("commit");
      return result;
    } catch (error) {
      if (isUnavailable(error)) broken = error;
      await client.query("rollback").catch(() => {});
      throw unavailable(error);
    } finally {
      client.release(broken || undefined); // a broken connection is destroyed, not handed out again
    }
  }
  const conflict = (error, message) => (error.code === "23505" ? Object.assign(new Error(message), { code: "conflict" }) : error);
  const insertLines = (query, kind, projectId, runId, values) => {
    if (!LINE_KINDS.includes(kind)) throw new Error(`unknown line kind ${kind}`);
    if (!values.length) return null;
    // One statement for all lines; ordinality keeps their order in the identity column.
    return query(`insert into ${kind} (project_id, run_id, line, created_at) select $1, $2, l.value, $4 from jsonb_array_elements($3::jsonb) with ordinality as l(value, n) order by l.n`, [projectId, runId, json(values), stamp()]);
  };

  const db = {
    transaction,
    /** The pg Pool (made on first use). */
    pool: getPool,
    async close() {
      if (ready) await (await ready).end();
    },

    // ---------- people ----------
    async createUser({ email, name = null, allowed = false }) {
      try {
        return user(await one("insert into users (id, email, name, allowed, created_at) values ($1, $2, $3, $4, $5) returning *", [newId("usr"), email, name, allowed, stamp()]));
      } catch (error) {
        throw conflict(error, `a user with the address ${email} exists`);
      }
    },
    async getUser(id) {
      return user(await one("select * from users where id = $1", [id]));
    },
    async findUserByEmail(email) {
      return user(await one("select * from users where lower(email) = lower($1)", [email]));
    },
    async updateUser(id, patch) {
      const row = await one("update users set name = case when $2 then $3 else name end, allowed = case when $4 then $5 else allowed end where id = $1 returning *", [id, "name" in patch, patch.name ?? null, "allowed" in patch, patch.allowed ?? false]);
      return user(row);
    },
    async findIdentity(provider, subject) {
      return identity(await one("select * from identities where provider = $1 and subject = $2", [provider, subject]));
    },
    async addIdentity(provider, subject, userId) {
      try {
        return identity(await one("insert into identities (provider, subject, user_id, created_at) values ($1, $2, $3, $4) returning *", [provider, subject, userId, stamp()]));
      } catch (error) {
        throw conflict(error, `the ${provider} identity ${subject} is bound to a user`);
      }
    },
    async listIdentities(userId) {
      return (await q("select * from identities where user_id = $1 order by created_at, provider, subject", [userId])).map(identity);
    },

    // ---------- sessions ----------
    async createSession({ idHash, userId, expiresAt }) {
      return session(await one("insert into sessions (id_hash, user_id, created_at, expires_at) values ($1, $2, $3, $4) returning *", [idHash, userId, stamp(), expiresAt]));
    },
    async getSession(idHash) {
      return session(await one("select * from sessions where id_hash = $1", [idHash]));
    },
    async updateSession(idHash, { expiresAt }) {
      await q("update sessions set expires_at = $2 where id_hash = $1", [idHash, expiresAt]);
    },
    async deleteSession(idHash) {
      await q("delete from sessions where id_hash = $1", [idHash]);
    },
    async deleteUserSessions(userId) {
      await q("delete from sessions where user_id = $1", [userId]);
    },
    async deleteExpiredSessions(before) {
      return (await q("delete from sessions where expires_at <= $1 returning id_hash", [before])).length;
    },

    // ---------- projects ----------
    async createProject({ name, slug = null, ownerId = null }) {
      const base = slugify(slug || name);
      return transaction(async (query) => {
        // Taken slugs are skipped by trying the next one; the unique index decides a race.
        for (let n = 0; ; n++) {
          const [row] = await query("insert into projects (id, name, slug, created_at) values ($1, $2, $3, $4) on conflict (slug) do nothing returning *", [newId("prj"), name, slugAttempt(base, n), stamp()]);
          if (!row) continue;
          if (ownerId) await query("insert into project_members (project_id, user_id, role, created_at) values ($1, $2, 'owner', $3)", [row.id, ownerId, stamp()]);
          return project(row);
        }
      });
    },
    async getProject(id) {
      return project(await one("select * from projects where id = $1", [id]));
    },
    async getProjectBySlug(slug) {
      return project(await one("select * from projects where slug = $1", [slug]));
    },
    async listProjects() {
      return (await q("select * from projects order by created_at, id")).map(project);
    },
    async addMember(projectId, userId, role = "member") {
      return member(await one("insert into project_members (project_id, user_id, role, created_at) values ($1, $2, $3, $4) on conflict (project_id, user_id) do update set role = excluded.role returning *", [projectId, userId, role, stamp()]));
    },
    async getMember(projectId, userId) {
      return member(await one("select * from project_members where project_id = $1 and user_id = $2", [projectId, userId]));
    },
    async listUserProjects(userId) {
      const rows = await q("select p.*, m.role from projects p join project_members m on m.project_id = p.id where m.user_id = $1 order by p.name, p.slug", [userId]);
      return rows.map((r) => ({ ...project(r), role: r.role }));
    },

    // ---------- keys ----------
    async createAccessKey(projectId, { name = "default", expiresAt = null } = {}) {
      const secret = newSecret();
      const row = await one("insert into access_keys (id, project_id, name, prefix, secret_sha256, created_at, expires_at) select $1, id, $3, $4, $5, $6, $7 from projects where id = $2 returning *", [newId("key"), projectId, name, secret.slice(0, 12), hashSecret(secret), stamp(), expiresAt]);
      if (!row) throw new Error(`no project ${projectId}`);
      return { ...accessKey(row), secret };
    },
    async findAccessKey(secret) {
      if (typeof secret !== "string" || !secret.startsWith(KEY_PREFIX)) return null;
      const t = stamp();
      return accessKey(await one("update access_keys set last_used_at = $2 where secret_sha256 = $1 and revoked_at is null and (expires_at is null or expires_at > $2) returning *", [hashSecret(secret), t]));
    },
    async getAccessKey(id) {
      return accessKey(await one("select * from access_keys where id = $1", [id]));
    },
    async listAccessKeys(projectId) {
      return (await q("select * from access_keys where project_id = $1 order by created_at desc, id desc", [projectId])).map(accessKey);
    },
    async revokeAccessKey(id) {
      await q("update access_keys set revoked_at = $2 where id = $1 and revoked_at is null", [id, stamp()]);
    },

    // ---------- runs ----------
    async createRun({ lines = {}, ...f }) {
      return transaction(async (query) => {
        const [row] = await query(
          "insert into runs (id, project_id, client_run_id, schema_version, status, run, manifest, files, key_id, created_at) values ($1, $2, $3, $4, 'uploading', $5, $6, $7, $8, $9) on conflict (project_id, client_run_id) do nothing returning *",
          [f.id || newId("run"), f.projectId, f.clientRunId, f.schemaVersion ?? 1, json(f.run), json(f.manifest), json(f.files ?? []), f.keyId ?? null, stamp()],
        );
        if (!row) return { run: run((await query("select * from runs where project_id = $1 and client_run_id = $2", [f.projectId, f.clientRunId]))[0]), created: false };
        for (const kind of LINE_KINDS) if (lines[kind]?.length) await insertLines(query, kind, row.project_id, row.id, lines[kind]);
        return { run: run(row), created: true };
      });
    },
    async getRun(id) {
      return run(await one("select * from runs where id = $1", [id]));
    },
    async findRun(projectId, clientRunId) {
      return run(await one("select * from runs where project_id = $1 and client_run_id = $2", [projectId, clientRunId]));
    },
    async updateRun(id, patch) {
      const sets = [];
      const values = [id];
      for (const [k, v] of Object.entries(patch)) {
        const column = RUN_COLUMNS[k];
        if (!column) throw new Error(`updateRun cannot change ${k}`);
        values.push(JSON_COLUMNS.has(k) ? json(v) : v);
        sets.push(`${column} = $${values.length}`);
      }
      if (!sets.length) return db.getRun(id);
      return run(await one(`update runs set ${sets.join(", ")} where id = $1 returning *`, values));
    },
    async listRuns(projectId, { status = null } = {}) {
      const rows = await q("select * from runs where project_id = $1 and ($2::text is null or status = $2) order by coalesce(completed_at, created_at) desc, id desc", [projectId, status]);
      return rows.map(run);
    },
    async deleteRun(id) {
      await q("delete from runs where id = $1", [id]);
    },

    async addLines(kind, projectId, runId, values) {
      await insertLines(q, kind, projectId, runId, values);
    },
    async listLines(kind, runId) {
      if (!LINE_KINDS.includes(kind)) throw new Error(`unknown line kind ${kind}`);
      return (await q(`select line from ${kind} where run_id = $1 order by id`, [runId])).map((r) => r.line);
    },

    // ---------- seen ----------
    async setSeen({ projectId, runId, userId, problemId, seen }) {
      await q("insert into seen (project_id, run_id, user_id, problem_id, seen, updated_at) values ($1, $2, $3, $4, $5, $6) on conflict (project_id, user_id, problem_id) do update set seen = excluded.seen, run_id = excluded.run_id, updated_at = excluded.updated_at", [projectId, runId, userId, problemId, seen, stamp()]);
    },
    async listSeen(projectId, userId) {
      const rows = await q("select problem_id, run_id, seen, updated_at from seen where project_id = $1 and user_id = $2 order by problem_id", [projectId, userId]);
      return rows.map((r) => ({ problemId: r.problem_id, runId: r.run_id, seen: r.seen, updatedAt: iso(r.updated_at) }));
    },

    // ---------- storage keys waiting to be deleted ----------
    async addPendingDeletions(projectId, keys) {
      if (keys.length) await q("insert into pending_deletions (key, project_id, created_at) select k, $2, $3 from unnest($1::text[]) as k on conflict (key) do nothing", [keys, projectId, stamp()]);
    },
    async listPendingDeletions(projectId) {
      return (await q("select key from pending_deletions where project_id = $1 order by created_at, key", [projectId])).map((r) => r.key);
    },
    async removePendingDeletions(keys) {
      if (keys.length) await q("delete from pending_deletions where key = any($1::text[])", [keys]);
    },

    // ---------- audit ----------
    async addAudit({ projectId = null, userId = null, keyId = null, action, detail = {} }) {
      await q("insert into audit_log (at, project_id, user_id, key_id, action, detail) values ($1, $2, $3, $4, $5, $6)", [stamp(), projectId, userId, keyId, action, json(detail)]);
    },
    async listAudit() {
      const rows = await q("select * from audit_log order by id");
      return rows.map((r) => ({ id: Number(r.id), at: iso(r.at), projectId: r.project_id, userId: r.user_id, keyId: r.key_id, action: r.action, detail: r.detail }));
    },
  };
  return db;
}
