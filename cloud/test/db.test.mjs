// The repository contract (src/db/CONTRACT.md), one suite for every implementation: memory always, and Postgres when
// DATABASE_URL is set. Postgres runs in a schema of its own, made by the migrations and dropped afterwards, so the
// suite never touches the database's other tables.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import { memoryDb } from "../src/db/memory.mjs";

/** A clock that moves one second per call, so rows have an order, and can be set. */
function clock() {
  let t = Date.parse("2026-11-12T10:00:00.000Z");
  const now = () => new Date((t += 1000));
  now.set = (iso) => { t = Date.parse(iso); };
  return now;
}

const IMPLEMENTATIONS = [["memory", async (now) => memoryDb({ now })]];
if (process.env.DATABASE_URL) IMPLEMENTATIONS.push(["postgres", postgres()]);

/** A factory for pg repositories in a fresh schema; the schema is dropped after the suite. */
function postgres() {
  const schema = `imitor_test_${crypto.randomBytes(4).toString("hex")}`;
  let admin;
  const made = [];
  const make = async (now) => {
    if (!admin) {
      const { default: pg } = await import("pg");
      admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
      await admin.query(`create schema ${schema}`);
      const { migrate, migrationFiles } = await import("../src/db/migrate.mjs");
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, options: `-c search_path=${schema}` });
      assert.deepEqual(await migrate(pool), migrationFiles(), "every migration, in order");
      assert.deepEqual(await migrate(pool), [], "a second run applies nothing");
      await pool.end();
    }
    // Each test starts from empty tables.
    const tables = (await admin.query("select tablename from pg_tables where schemaname = $1 and tablename <> 'schema_migrations'", [schema])).rows.map((r) => `${schema}.${r.tablename}`);
    await admin.query(`truncate ${tables.join(", ")} restart identity cascade`);
    const { pgDb } = await import("../src/db/pg.mjs");
    const db = pgDb({ connectionString: process.env.DATABASE_URL, schema, now });
    made.push(db);
    return db;
  };
  make.cleanup = async () => {
    for (const db of made) await db.close();
    if (admin) {
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    }
  };
  return make;
}

const runFields = (projectId, clientRunId, patch = {}) => ({
  projectId, clientRunId, schemaVersion: 1,
  run: { id: clientRunId, title: "Larger tap targets", flows: [] },
  manifest: { app: "fernwood", shots: [], problems: [] },
  files: [{ path: "screens/a.png", size: 5, sha256: "a".repeat(64), contentType: "image/png", key: `${projectId}/x/screens/a.png` }],
  keyId: null,
  ...patch,
});

for (const [name, factory] of IMPLEMENTATIONS) {
  describe(`repository contract: ${name}`, () => {
    let now;
    let db;
    const fresh = async () => {
      now = clock();
      db = await factory(now);
      return db;
    };
    if (factory.cleanup) after(factory.cleanup);
    before(fresh);

    test("users: one per address whatever its case; identities bind (provider, subject) to one user", async () => {
      await fresh();
      const ada = await db.createUser({ email: "Ada@Example.com", name: "Ada" });
      assert.match(ada.id, /^usr_[0-9a-f]{20}$/);
      assert.deepEqual({ ...ada, id: null, createdAt: null }, { id: null, email: "Ada@Example.com", name: "Ada", allowed: false, invitedAt: null, createdAt: null });
      assert.deepEqual(await db.findUserByEmail("ada@example.com"), ada);
      assert.deepEqual(await db.getUser(ada.id), ada);
      assert.equal(await db.getUser("usr_none"), null);
      await assert.rejects(db.createUser({ email: "ADA@example.com" }), (e) => e.code === "conflict");
      assert.deepEqual(await db.updateUser(ada.id, { allowed: true }), { ...ada, allowed: true });
      assert.deepEqual(await db.updateUser(ada.id, { name: "Ada L." }), { ...ada, allowed: true, name: "Ada L." });

      const google = await db.addIdentity("google", "1234567890", ada.id);
      assert.deepEqual({ ...google, createdAt: null }, { provider: "google", subject: "1234567890", userId: ada.id, createdAt: null });
      assert.deepEqual(await db.findIdentity("google", "1234567890"), google);
      assert.equal(await db.findIdentity("google", "other"), null);
      const bob = await db.createUser({ email: "bob@example.com" });
      await assert.rejects(db.addIdentity("google", "1234567890", bob.id), (e) => e.code === "conflict");
      const cy = await db.createUser({ email: "cy@example.com", allowed: true, invited: true });
      assert.ok(cy.invitedAt && cy.invitedAt === cy.createdAt, "an invitation is marked when it is made");
      assert.equal((await db.findUserByEmail("CY@example.com")).invitedAt, cy.invitedAt);
      assert.deepEqual(await db.listIdentities(ada.id), [google]);
    });

    test("sessions: create, read, extend, delete one, delete a user's, delete the expired", async () => {
      await fresh();
      const ada = await db.createUser({ email: "ada@example.com" });
      const bob = await db.createUser({ email: "bob@example.com" });
      const s1 = await db.createSession({ idHash: "h1", userId: ada.id, expiresAt: "2026-12-12T10:00:00.000Z" });
      assert.deepEqual({ ...s1, createdAt: null }, { idHash: "h1", userId: ada.id, createdAt: null, expiresAt: "2026-12-12T10:00:00.000Z" });
      await db.createSession({ idHash: "h2", userId: ada.id, expiresAt: "2026-11-12T09:00:00.000Z" });
      await db.createSession({ idHash: "h3", userId: bob.id, expiresAt: "2026-12-12T10:00:00.000Z" });
      assert.deepEqual(await db.getSession("h1"), s1);
      await db.updateSession("h1", { expiresAt: "2026-12-13T10:00:00.000Z" });
      assert.equal((await db.getSession("h1")).expiresAt, "2026-12-13T10:00:00.000Z");
      assert.equal(await db.deleteExpiredSessions("2026-11-12T10:00:00.000Z"), 1);
      assert.equal(await db.getSession("h2"), null);
      await db.deleteUserSessions(ada.id);
      assert.equal(await db.getSession("h1"), null);
      assert.ok(await db.getSession("h3"));
      await db.deleteSession("h3");
      assert.equal(await db.getSession("h3"), null);
    });

    test("projects: unique slugs, an owner made with the project, membership and the user's projects", async () => {
      await fresh();
      const ada = await db.createUser({ email: "ada@example.com" });
      const bob = await db.createUser({ email: "bob@example.com" });
      const p1 = await db.createProject({ name: "Fernwood", ownerId: ada.id });
      const p2 = await db.createProject({ name: "fernwood!" }); // sorts after "Ferns" in any collation
      const p3 = await db.createProject({ name: "Ferns", slug: "fernwood" });
      assert.deepEqual([p1.slug, p2.slug, p3.slug], ["fernwood", "fernwood-2", "fernwood-3"]);
      assert.match(p1.id, /^prj_/);
      assert.deepEqual(await db.getProject(p1.id), p1);
      assert.deepEqual(await db.getProjectBySlug("fernwood-2"), p2);
      assert.equal(await db.getProjectBySlug("nope"), null);
      assert.deepEqual((await db.listProjects()).map((p) => p.id), [p1.id, p2.id, p3.id]);

      assert.equal((await db.getMember(p1.id, ada.id)).role, "owner");
      assert.equal(await db.getMember(p1.id, bob.id), null);
      assert.equal((await db.addMember(p3.id, bob.id)).role, "member");
      assert.equal((await db.addMember(p3.id, bob.id, "owner")).role, "owner", "adding again changes the role");
      await db.addMember(p2.id, bob.id);
      assert.deepEqual((await db.listUserProjects(bob.id)).map((p) => [p.slug, p.role]), [["fernwood-3", "owner"], ["fernwood-2", "member"]], "by name: Ferns, fernwood!");
      assert.deepEqual(await db.listUserProjects(ada.id), [{ ...p1, role: "owner" }]);

      const cy = await db.createUser({ email: "Cy@example.com", name: "Cy" });
      await db.addMember(p1.id, cy.id);
      await db.addMember(p1.id, bob.id);
      assert.deepEqual((await db.listMembers(p1.id)).map((m) => [m.email, m.role]), [["ada@example.com", "owner"], ["bob@example.com", "member"], ["Cy@example.com", "member"]], "owners first, then by address");
      assert.equal((await db.listMembers(p1.id))[2].name, "Cy");
      assert.equal(await db.removeMember(p1.id, bob.id), true);
      assert.equal(await db.removeMember(p1.id, bob.id), false);
      assert.equal(await db.getMember(p1.id, bob.id), null);
      assert.deepEqual(await db.listMembers("prj_none"), []);

      // A project keeps an owner, even when its two owners leave at the same moment.
      const p4 = await db.createProject({ name: "Kept", ownerId: ada.id });
      await assert.rejects(db.removeMember(p4.id, ada.id), (e) => e.code === "last-owner");
      await assert.rejects(db.addMember(p4.id, ada.id, "member"), (e) => e.code === "last-owner");
      await db.addMember(p4.id, bob.id, "owner");
      const both = await Promise.allSettled([db.removeMember(p4.id, ada.id), db.removeMember(p4.id, bob.id)]);
      assert.deepEqual(both.map((r) => r.status).sort(), ["fulfilled", "rejected"], "one goes, the other is refused");
      assert.equal(both.find((r) => r.status === "rejected").reason.code, "last-owner");
      assert.equal((await db.listMembers(p4.id)).filter((m) => m.role === "owner").length, 1);
      await db.addMember(p4.id, cy.id, "owner");
      const demotions = await Promise.allSettled((await db.listMembers(p4.id)).filter((m) => m.role === "owner").map((m) => db.addMember(p4.id, m.userId, "member")));
      assert.equal(demotions.filter((r) => r.status === "fulfilled").length, 1, "two owners stepping down at once: one stays");
    });

    test("access keys: the secret once, only its SHA-256 kept, found while live, listed, revoked", async () => {
      await fresh();
      const p = await db.createProject({ name: "fernwood" });
      const key = await db.createAccessKey(p.id, { name: "ci" });
      assert.match(key.secret, /^imk_[A-Za-z0-9_-]{43}$/);
      assert.equal(key.prefix, key.secret.slice(0, 12));
      assert.equal(key.secretSha256, crypto.createHash("sha256").update(key.secret).digest("hex"));
      assert.deepEqual({ ...key, id: null, secret: null, prefix: null, secretSha256: null, createdAt: null }, { id: null, projectId: p.id, name: "ci", prefix: null, secretSha256: null, secret: null, createdAt: null, lastUsedAt: null, revokedAt: null, expiresAt: null });
      await assert.rejects(db.createAccessKey("prj_none"));

      const found = await db.findAccessKey(key.secret);
      assert.equal(found.id, key.id);
      assert.ok(found.lastUsedAt, "sets lastUsedAt");
      assert.equal("secret" in found, false);
      assert.equal(await db.findAccessKey("imk_unknown"), null);
      assert.equal(await db.findAccessKey(key.secret.replace("imk_", "xyz_")), null);
      assert.equal((await db.getAccessKey(key.id)).lastUsedAt, found.lastUsedAt);

      const old = await db.createAccessKey(p.id, { expiresAt: "2026-11-12T09:00:00.000Z" });
      assert.equal(await db.findAccessKey(old.secret), null, "expired");
      assert.deepEqual((await db.listAccessKeys(p.id)).map((k) => k.id), [old.id, key.id]);
      await db.revokeAccessKey(key.id);
      const revoked = await db.getAccessKey(key.id);
      assert.ok(revoked.revokedAt);
      assert.equal(await db.findAccessKey(key.secret), null);
      await db.revokeAccessKey(key.id);
      assert.equal((await db.getAccessKey(key.id)).revokedAt, revoked.revokedAt, "revoking again keeps the first time");
      assert.equal(await db.getAccessKey("key_none"), null);
    });

    test("runs: created once per (project, client run id) with their lines, in one step; listed newest first", async () => {
      await fresh();
      const p = await db.createProject({ name: "fernwood" });
      const other = await db.createProject({ name: "other" });
      const lines = { captures: [{ id: "c1", file: "captures/a.png" }, { id: "c2", file: "captures/b.png" }], activity: [{ at: "2026-11-12T10:00:00.000Z", tool: "imitor_run" }] };
      const a = await db.createRun({ id: "run_a", ...runFields(p.id, "20261112T100000-aaa"), lines });
      assert.equal(a.created, true);
      assert.deepEqual({ ...a.run, createdAt: null }, { id: "run_a", ...runFields(p.id, "20261112T100000-aaa"), status: "uploading", createdAt: null, completedAt: null });
      const again = await db.createRun({ id: "run_other", ...runFields(p.id, "20261112T100000-aaa"), lines });
      assert.deepEqual(again, { run: a.run, created: false });
      assert.deepEqual(await db.listLines("captures", "run_a"), lines.captures, "lines are not added twice");
      assert.deepEqual(await db.listLines("activity", "run_a"), lines.activity);
      await assert.rejects(db.listLines("secrets", "run_a"));

      const both = await Promise.all([db.createRun({ id: "run_r1", ...runFields(p.id, "race") }), db.createRun({ id: "run_r2", ...runFields(p.id, "race") })]);
      assert.deepEqual(both.map((r) => r.created).sort(), [false, true], "two pushes of one run make one row");

      await db.createRun({ id: "run_b", ...runFields(p.id, "20261112T100001-bbb") });
      await db.createRun({ id: "run_c", ...runFields(other.id, "20261112T100000-aaa") });
      assert.deepEqual(await db.findRun(p.id, "20261112T100000-aaa"), a.run);
      assert.equal(await db.findRun(p.id, "none"), null);
      assert.equal(await db.getRun("run_none"), null);

      const done = await db.updateRun("run_a", { status: "ready", completedAt: "2026-11-12T11:00:00.000Z" });
      assert.deepEqual(done, { ...a.run, status: "ready", completedAt: "2026-11-12T11:00:00.000Z" });
      assert.equal(await db.updateRun("run_none", { status: "ready" }), null);
      const raceId = both.find((r) => r.created).run.id;
      assert.deepEqual((await db.listRuns(p.id)).map((r) => r.id), ["run_a", "run_b", raceId], "by completedAt, else createdAt, newest first");
      assert.deepEqual((await db.listRuns(p.id, { status: "ready" })).map((r) => r.id), ["run_a"]);
      assert.deepEqual((await db.listRuns(p.id, { status: "uploading" })).map((r) => r.id), ["run_b", raceId]);

      const copy = await db.getRun("run_a");
      copy.manifest.shots.push("changed");
      assert.deepEqual((await db.getRun("run_a")).manifest.shots, [], "results are copies");
    });

    test("deleting a run deletes its lines and seen rows; pending deletions are kept once per key", async () => {
      await fresh();
      const ada = await db.createUser({ email: "ada@example.com" });
      const p = await db.createProject({ name: "fernwood", ownerId: ada.id });
      await db.createRun({ id: "run_a", ...runFields(p.id, "a"), lines: { activity: [{ at: "2026-11-12T10:00:00.000Z" }] } });
      await db.createRun({ id: "run_b", ...runFields(p.id, "b") });
      await db.addLines("captures", p.id, "run_a", [{ id: "c1" }]);
      await db.setSeen({ projectId: p.id, runId: "run_a", userId: ada.id, problemId: "p_1", seen: true });
      await db.setSeen({ projectId: p.id, runId: "run_b", userId: ada.id, problemId: "p_2", seen: false });
      await db.setSeen({ projectId: p.id, runId: "run_b", userId: ada.id, problemId: "p_2", seen: true });
      assert.deepEqual((await db.listSeen(p.id, ada.id)).map(({ problemId, runId, seen }) => ({ problemId, runId, seen })), [
        { problemId: "p_1", runId: "run_a", seen: true },
        { problemId: "p_2", runId: "run_b", seen: true },
      ]);
      await db.deleteRun("run_a");
      assert.equal(await db.getRun("run_a"), null);
      assert.deepEqual(await db.listLines("captures", "run_a"), []);
      assert.deepEqual(await db.listLines("activity", "run_a"), []);
      assert.deepEqual((await db.listSeen(p.id, ada.id)).map((s) => s.problemId), ["p_2"]);

      await db.addPendingDeletions(p.id, ["k1", "k2"]);
      await db.addPendingDeletions(p.id, ["k2", "k3"]);
      assert.deepEqual((await db.listPendingDeletions(p.id)).sort(), ["k1", "k2", "k3"]);
      assert.deepEqual(await db.listPendingDeletions("prj_other"), []);
      await db.removePendingDeletions(["k1", "k3"]);
      assert.deepEqual(await db.listPendingDeletions(p.id), ["k2"]);
      await db.addPendingDeletions(p.id, []);
      await db.removePendingDeletions([]);
    });

    test("audit: entries in order, with who in the columns and what in detail", async () => {
      await fresh();
      const ada = await db.createUser({ email: "ada@example.com" });
      const p = await db.createProject({ name: "fernwood" });
      const key = await db.createAccessKey(p.id);
      await db.addAudit({ projectId: p.id, keyId: key.id, action: "run.create", detail: { runId: "run_a", clientRunId: "a" } });
      await db.addAudit({ projectId: p.id, userId: ada.id, action: "key.create", detail: { keyId: key.id } });
      await db.addAudit({ action: "user.signin" });
      const entries = await db.listAudit();
      assert.deepEqual(entries.map(({ id, at, ...e }) => e), [
        { projectId: p.id, userId: null, keyId: key.id, action: "run.create", detail: { runId: "run_a", clientRunId: "a" } },
        { projectId: p.id, userId: ada.id, keyId: null, action: "key.create", detail: { keyId: key.id } },
        { projectId: null, userId: null, keyId: null, action: "user.signin", detail: {} },
      ]);
      assert.ok(entries[0].id < entries[1].id && entries[1].id < entries[2].id);
      assert.ok(entries.every((e) => typeof e.id === "number" && !Number.isNaN(Date.parse(e.at))));
    });

    test("waitlist: one row per address whatever its case, oldest first", async () => {
      await fresh();
      assert.deepEqual(await db.addWaitlist("Ada@Example.com"), { added: true });
      assert.deepEqual(await db.addWaitlist("grace@example.com"), { added: true });
      assert.deepEqual(await db.addWaitlist("ada@example.COM"), { added: false });
      const list = await db.listWaitlist();
      assert.deepEqual(list.map((e) => e.email), ["ada@example.com", "grace@example.com"]);
      assert.ok(list.every((e) => !Number.isNaN(Date.parse(e.createdAt))));
      assert.equal(await db.findUserByEmail("ada@example.com"), null, "the waitlist makes no user");
    });
  });
}
