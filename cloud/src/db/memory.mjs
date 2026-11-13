// The repository kept in memory, for tests and local runs. pg.mjs is the same repository on Postgres
// (cloud/migrations/), and the fields here are its columns in camelCase (secretSha256 is secret_sha256). CONTRACT.md
// lists every method; test/db.test.mjs runs one suite against both. Access key secrets are never stored: only their
// SHA-256.
import { hashSecret, KEY_PREFIX, newId, newSecret, slugAttempt, slugify } from "../ids.mjs";

/**
 * @typedef {object} RunRecord             a row of runs
 * @property {string} id                 minted by the server
 * @property {string} projectId
 * @property {string} clientRunId        the run folder name on the machine that pushed it
 * @property {number} schemaVersion
 * @property {"uploading" | "ready"} status
 * @property {object} run                run.json (redacted)
 * @property {object} manifest           manifest.json (redacted)
 * @property {{ path: string, size: number, sha256: string, contentType: string, key: string }[]} files
 * @property {string | null} keyId       the key that pushed it
 * @property {string} createdAt
 * @property {string | null} completedAt
 */

export const LINE_KINDS = ["captures", "activity"];

/** opts: { now: () => Date }. */
const lastOwner = () => Object.assign(new Error("a project needs an owner: make someone else an owner first"), { code: "last-owner" });

export function memoryDb({ now = () => new Date() } = {}) {
  const users = new Map();
  const identities = new Map(); // "provider\0subject" -> identity
  const sessions = new Map(); // idHash -> session
  const projects = new Map();
  const members = new Map(); // "projectId\0userId" -> member
  const keys = new Map(); // secretSha256 -> access_keys row
  const runs = new Map();
  const lines = { captures: [], activity: [] };
  const seen = new Map(); // "projectId\0userId\0problemId" -> seen row
  const audit = [];
  const pending = new Map(); // object key -> pending_deletions row
  let serial = 0; // the identity columns of captures, activity and audit_log
  const stamp = () => now().toISOString();
  const copy = (v) => (v == null ? v : structuredClone(v));
  const lower = (s) => String(s).toLowerCase();
  const conflict = (message) => Object.assign(new Error(message), { code: "conflict" });
  const owners = (projectId) => [...members.values()].filter((m) => m.projectId === projectId && m.role === "owner").length;

  const db = {
    // ---------- people ----------
    async createUser({ email, name = null, allowed = false, invited = false }) {
      if ([...users.values()].some((u) => lower(u.email) === lower(email))) throw conflict(`a user with the address ${email} exists`);
      const now = stamp();
      const user = { id: newId("usr"), email, name, allowed, invitedAt: invited ? now : null, createdAt: now };
      users.set(user.id, user);
      return copy(user);
    },
    async getUser(id) {
      return copy(users.get(id) ?? null);
    },
    async findUserByEmail(email) {
      return copy([...users.values()].find((u) => lower(u.email) === lower(email)) ?? null);
    },
    async updateUser(id, patch) {
      const user = users.get(id);
      if (!user) return null;
      for (const k of ["name", "allowed"]) if (k in patch) user[k] = patch[k];
      return copy(user);
    },
    async findIdentity(provider, subject) {
      return copy(identities.get(`${provider}\0${subject}`) ?? null);
    },
    async addIdentity(provider, subject, userId) {
      const k = `${provider}\0${subject}`;
      if (identities.has(k)) throw conflict(`the ${provider} identity ${subject} is bound to a user`);
      if (!users.has(userId)) throw new Error(`no user ${userId}`);
      const identity = { provider, subject, userId, createdAt: stamp() };
      identities.set(k, identity);
      return copy(identity);
    },
    async listIdentities(userId) {
      return [...identities.values()].filter((i) => i.userId === userId).map(copy);
    },

    // ---------- sessions ----------
    async createSession({ idHash, userId, expiresAt }) {
      const session = { idHash, userId, createdAt: stamp(), expiresAt };
      sessions.set(idHash, session);
      return copy(session);
    },
    async getSession(idHash) {
      return copy(sessions.get(idHash) ?? null);
    },
    async updateSession(idHash, { expiresAt }) {
      const s = sessions.get(idHash);
      if (s) s.expiresAt = expiresAt;
    },
    async deleteSession(idHash) {
      sessions.delete(idHash);
    },
    async deleteUserSessions(userId) {
      for (const [k, s] of sessions) if (s.userId === userId) sessions.delete(k);
    },
    async deleteExpiredSessions(before) {
      let n = 0;
      for (const [k, s] of sessions) if (s.expiresAt <= before) (sessions.delete(k), n++);
      return n;
    },

    // ---------- projects ----------
    /** A project with a slug of its own; with ownerId, that user is its owner (in the same step). */
    async createProject({ name, slug = null, ownerId = null }) {
      const base = slugify(slug || name);
      const taken = new Set([...projects.values()].map((p) => p.slug));
      let n = 0;
      while (taken.has(slugAttempt(base, n))) n++;
      if (ownerId && !users.has(ownerId)) throw new Error(`no user ${ownerId}`);
      const project = { id: newId("prj"), name, slug: slugAttempt(base, n), createdAt: stamp() };
      projects.set(project.id, project);
      if (ownerId) members.set(`${project.id}\0${ownerId}`, { projectId: project.id, userId: ownerId, role: "owner", createdAt: stamp() });
      return copy(project);
    },
    async getProject(id) {
      return copy(projects.get(id) ?? null);
    },
    async getProjectBySlug(slug) {
      return copy([...projects.values()].find((p) => p.slug === slug) ?? null);
    },
    async listProjects() {
      return [...projects.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(copy);
    },
    async addMember(projectId, userId, role = "member") {
      if (!projects.has(projectId) || !users.has(userId)) throw new Error(`no project ${projectId} or user ${userId}`);
      const k = `${projectId}\0${userId}`;
      // Checked and changed in one step (nothing awaits in between), so two requests cannot both pass the check.
      if (role !== "owner" && members.get(k)?.role === "owner" && owners(projectId) === 1) throw lastOwner();
      const member = { ...(members.get(k) || { projectId, userId, createdAt: stamp() }), role };
      members.set(k, member);
      return copy(member);
    },
    async getMember(projectId, userId) {
      return copy(members.get(`${projectId}\0${userId}`) ?? null);
    },
    /** The project's members with their address and name, owners first, then by address. */
    async listMembers(projectId) {
      return [...members.values()].filter((m) => m.projectId === projectId && users.has(m.userId))
        .map((m) => ({ ...copy(m), email: users.get(m.userId).email, name: users.get(m.userId).name }))
        .sort((a, b) => (a.role === b.role ? 0 : a.role === "owner" ? -1 : 1) || a.email.localeCompare(b.email));
    },
    async removeMember(projectId, userId) {
      const k = `${projectId}\0${userId}`;
      if (members.get(k)?.role === "owner" && owners(projectId) === 1) throw lastOwner();
      return members.delete(k);
    },
    /** The user's projects, each with their `role`, by name. */
    async listUserProjects(userId) {
      return [...members.values()].filter((m) => m.userId === userId && projects.has(m.projectId))
        .map((m) => ({ ...copy(projects.get(m.projectId)), role: m.role }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
    },

    // ---------- keys ----------
    /** A new write-only key for a project. The secret is returned once and not kept. */
    async createAccessKey(projectId, { name = "default", expiresAt = null } = {}) {
      if (!projects.has(projectId)) throw new Error(`no project ${projectId}`);
      const secret = newSecret();
      const key = { id: newId("key"), projectId, name, prefix: secret.slice(0, 12), secretSha256: hashSecret(secret), createdAt: stamp(), lastUsedAt: null, revokedAt: null, expiresAt };
      keys.set(key.secretSha256, key);
      return { ...copy(key), secret };
    },
    /** The live key for a secret (not revoked, not expired), or null. */
    async findAccessKey(secret) {
      if (typeof secret !== "string" || !secret.startsWith(KEY_PREFIX)) return null;
      const key = keys.get(hashSecret(secret));
      if (!key || key.revokedAt || (key.expiresAt && key.expiresAt <= stamp())) return null;
      key.lastUsedAt = stamp();
      return copy(key);
    },
    async getAccessKey(id) {
      return copy([...keys.values()].find((k) => k.id === id) ?? null);
    },
    /** A project's keys, revoked ones included, newest first. */
    async listAccessKeys(projectId) {
      return [...keys.values()].filter((k) => k.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(copy);
    },
    async revokeAccessKey(id) {
      for (const key of keys.values()) if (key.id === id && !key.revokedAt) key.revokedAt = stamp();
    },

    // ---------- runs ----------
    /** Insert a run (and its captures and activity lines) unless (projectId, clientRunId) exists. Returns { run, created }. */
    async createRun({ lines: runLines = {}, ...fields }) {
      const existing = [...runs.values()].find((r) => r.projectId === fields.projectId && r.clientRunId === fields.clientRunId);
      if (existing) return { run: copy(existing), created: false };
      const run = { keyId: null, ...copy(fields), id: fields.id || newId("run"), status: "uploading", createdAt: stamp(), completedAt: null };
      runs.set(run.id, run);
      for (const kind of LINE_KINDS) if (runLines[kind]?.length) await db.addLines(kind, run.projectId, run.id, runLines[kind]);
      return { run: copy(run), created: true };
    },
    async getRun(id) {
      return copy(runs.get(id) ?? null);
    },
    async findRun(projectId, clientRunId) {
      return copy([...runs.values()].find((r) => r.projectId === projectId && r.clientRunId === clientRunId) ?? null);
    },
    async updateRun(id, patch) {
      const run = runs.get(id);
      if (!run) return null;
      Object.assign(run, copy(patch));
      return copy(run);
    },
    /** Runs of a project, newest first: by completedAt (createdAt while uploading), then id. opts: { status }. */
    async listRuns(projectId, { status = null } = {}) {
      const order = (r) => r.completedAt || r.createdAt;
      return [...runs.values()]
        .filter((r) => r.projectId === projectId && (!status || r.status === status))
        .sort((a, b) => order(b).localeCompare(order(a)) || b.id.localeCompare(a.id))
        .map(copy);
    },
    /** Deletes the run and, as the schema's cascades do, its captures, activity and seen rows. */
    async deleteRun(id) {
      runs.delete(id);
      for (const kind of LINE_KINDS) lines[kind] = lines[kind].filter((l) => l.runId !== id);
      for (const [k, s] of seen) if (s.runId === id) seen.delete(k);
    },

    /** Store captures or activity lines that came with a run. */
    async addLines(kind, projectId, runId, values) {
      if (!lines[kind]) throw new Error(`unknown line kind ${kind}`);
      for (const line of values) lines[kind].push({ id: ++serial, projectId, runId, line: copy(line), createdAt: stamp() });
    },
    async listLines(kind, runId) {
      if (!lines[kind]) throw new Error(`unknown line kind ${kind}`);
      return lines[kind].filter((l) => l.runId === runId).map((l) => copy(l.line));
    },

    // ---------- seen ----------
    async setSeen({ projectId, runId, userId, problemId, seen: value }) {
      seen.set(`${projectId}\0${userId}\0${problemId}`, { projectId, runId, userId, problemId, seen: value, updatedAt: stamp() });
    },
    async listSeen(projectId, userId) {
      return [...seen.values()].filter((s) => s.projectId === projectId && s.userId === userId)
        .map(({ problemId, runId, seen: value, updatedAt }) => ({ problemId, runId, seen: value, updatedAt }))
        .sort((a, b) => a.problemId.localeCompare(b.problemId));
    },

    /** Object keys of deleted runs, kept until storage confirms they are gone. */
    async addPendingDeletions(projectId, objectKeys) {
      for (const key of objectKeys) if (!pending.has(key)) pending.set(key, { key, projectId, createdAt: stamp() });
    },
    async listPendingDeletions(projectId) {
      return [...pending.values()].filter((p) => p.projectId === projectId).map((p) => p.key);
    },
    async removePendingDeletions(objectKeys) {
      for (const key of objectKeys) pending.delete(key);
    },

    /** entry: { projectId, userId, keyId, action, detail: an object (jsonb) }. */
    async addAudit({ projectId = null, userId = null, keyId = null, action, detail = {} }) {
      audit.push({ id: ++serial, at: stamp(), projectId, userId, keyId, action, detail: copy(detail) });
    },
    async listAudit() {
      return audit.map(copy);
    },
    async countAudit({ action, since, userId = null, detail = {} }) {
      const from = Date.parse(since);
      for (const field of Object.keys(detail)) if (!/^[A-Za-z]+$/.test(field)) throw new Error(`countAudit cannot match the detail field ${JSON.stringify(field)}`); // as pg.mjs
      const matches = (e) => Object.entries(detail).every(([k, v]) => e.detail?.[k] != null && String(e.detail[k]) === String(v));
      return audit.filter((e) => e.action === action && Date.parse(e.at) >= from && (userId == null || e.userId === userId) && matches(e)).length;
    },
    async close() {},
  };
  return db;
}
