// The repository the API is written against, kept in memory, for tests and local runs. A Postgres version with the
// same methods comes in week 2 (cloud/migrations/001_init.sql is its schema). Every method is async so the two can
// be swapped. Access key secrets are never stored: only their SHA-256.
import { hashSecret, KEY_PREFIX, newId, newSecret } from "../ids.mjs";

/**
 * @typedef {object} RunRecord
 * @property {string} id                 minted by the server
 * @property {string} projectId
 * @property {string} clientRunId        the run folder name on the machine that pushed it
 * @property {number} schemaVersion
 * @property {"uploading" | "ready"} status
 * @property {object} run                run.json (redacted)
 * @property {object} manifest           manifest.json (redacted)
 * @property {{ path: string, size: number, sha256: string, contentType: string, key: string }[]} files
 * @property {string} createdAt
 * @property {string | null} completedAt
 */

/** opts: { now: () => Date }. */
export function memoryDb({ now = () => new Date() } = {}) {
  const projects = new Map();
  const keys = new Map(); // hash -> key record
  const runs = new Map();
  const lines = { captures: [], activity: [] };
  const audit = [];
  let seq = 0;
  const stamp = () => now().toISOString();
  const copy = (v) => (v == null ? v : structuredClone(v));

  return {
    async createProject({ name }) {
      const project = { id: newId("prj"), name, createdAt: stamp() };
      projects.set(project.id, project);
      return copy(project);
    },
    async getProject(id) {
      return copy(projects.get(id) ?? null);
    },

    /** A new write-only key for a project. The secret is returned once and not kept. */
    async createAccessKey(projectId, { name = "default" } = {}) {
      if (!projects.has(projectId)) throw new Error(`no project ${projectId}`);
      const secret = newSecret();
      const key = { id: newId("key"), projectId, name, prefix: secret.slice(0, 12), hash: hashSecret(secret), createdAt: stamp(), lastUsedAt: null, revokedAt: null };
      keys.set(key.hash, key);
      return { ...copy(key), secret };
    },
    /** The live key for a secret, or null. */
    async findAccessKey(secret) {
      if (typeof secret !== "string" || !secret.startsWith(KEY_PREFIX)) return null;
      const key = keys.get(hashSecret(secret));
      if (!key || key.revokedAt) return null;
      key.lastUsedAt = stamp();
      return copy(key);
    },
    async revokeAccessKey(id) {
      for (const key of keys.values()) if (key.id === id) key.revokedAt = stamp();
    },

    /** Insert a run unless (projectId, clientRunId) exists. Returns { run, created }. */
    async createRun(fields) {
      const existing = [...runs.values()].find((r) => r.projectId === fields.projectId && r.clientRunId === fields.clientRunId);
      if (existing) return { run: copy(existing), created: false };
      const run = { ...copy(fields), id: fields.id || newId("run"), status: "uploading", createdAt: stamp(), completedAt: null, seq: ++seq };
      runs.set(run.id, run);
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
    /** Runs of a project, newest first (completed time, then created time). opts: { status }. */
    async listRuns(projectId, { status = null } = {}) {
      const order = (r) => r.completedAt || r.createdAt;
      return [...runs.values()]
        .filter((r) => r.projectId === projectId && (!status || r.status === status))
        .sort((a, b) => order(b).localeCompare(order(a)) || b.seq - a.seq)
        .map(copy);
    },
    async deleteRun(id) {
      runs.delete(id);
      for (const kind of Object.keys(lines)) lines[kind] = lines[kind].filter((l) => l.runId !== id);
    },

    /** Store captures or activity lines that came with a run. */
    async addLines(kind, projectId, runId, values) {
      if (!lines[kind]) throw new Error(`unknown line kind ${kind}`);
      for (const value of values) lines[kind].push({ projectId, runId, value: copy(value) });
    },
    async listLines(kind, runId) {
      return lines[kind].filter((l) => l.runId === runId).map((l) => copy(l.value));
    },

    async addAudit(entry) {
      audit.push({ at: stamp(), ...copy(entry) });
    },
    async listAudit() {
      return audit.map(copy);
    },
  };
}
