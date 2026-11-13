// Vercel Blob storage (cloud/src/storage/blob.mjs) against a stand-in for @vercel/blob that keeps objects in memory
// and enforces what a presigned URL allows, then the whole register / upload / complete path through the API with it.
// Nothing here reaches Vercel: the first run against a real store is a deployment.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { handle } from "../src/api.mjs";
import { memoryDb } from "../src/db/memory.mjs";
import { depsFromEnv } from "../src/server.mjs";
import { BLOB_API_VERSION, blobStorage, storeIdOf } from "../src/storage/blob.mjs";
import { cloudFunction } from "../src/vercel.mjs";

const TOKEN = "vercel_blob_rw_AbC123store_secretsecretsecret";
const HOST = "https://abc123store.private.blob.vercel-storage.com";
const API = "https://vercel.com/api/blob";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

class BlobNotFoundError extends Error {}

/** @vercel/blob's functions the storage uses, over a Map, plus the fetch that answers its presigned URLs. */
function fakeBlob({ now = () => Date.now() } = {}) {
  const objects = new Map(); // pathname -> { body: Buffer, contentType }
  const calls = { issue: [], head: [], list: [], del: [] };
  const sdk = {
    BlobNotFoundError,
    async issueSignedToken(options) {
      calls.issue.push(options);
      assert.equal(options.token, TOKEN);
      return { delegationToken: `d${calls.issue.length}`, clientSigningToken: "k", validUntil: options.validUntil };
    },
    async presignUrl(signed, o) {
      assert.equal(o.access, "private");
      const q = new URLSearchParams({ delegation: signed.delegationToken, op: o.operation, until: String(o.validUntil) });
      if (o.operation === "get") {
        if (o.useCache === false) q.set("cache", "0");
        return { presignedUrl: `${HOST}/${o.pathname}?${q}` };
      }
      assert.equal(o.addRandomSuffix, false);
      assert.equal(o.allowOverwrite, true);
      q.set("pathname", o.pathname);
      q.set("types", o.allowedContentTypes.join(","));
      q.set("max", String(o.maximumSizeInBytes));
      return { presignedUrl: `${API}/?${q}` };
    },
    async head(pathname, { token }) {
      calls.head.push(pathname);
      assert.equal(token, TOKEN);
      const o = objects.get(pathname);
      if (!o) throw new BlobNotFoundError();
      return { pathname, size: o.body.length, contentType: o.contentType };
    },
    async list({ prefix, cursor, limit, token }) {
      calls.list.push({ prefix, cursor });
      assert.equal(token, TOKEN);
      const all = [...objects].filter(([k]) => k.startsWith(prefix)).map(([pathname, o]) => ({ pathname, size: o.body.length }));
      const page = 2; // small pages, so the cursor is followed
      const from = Number(cursor || 0);
      assert.equal(limit, 1000);
      return { blobs: all.slice(from, from + page), hasMore: from + page < all.length, cursor: String(from + page) };
    },
    async del(pathnames, { token }) {
      calls.del.push(pathnames);
      assert.equal(token, TOKEN);
      for (const p of pathnames) objects.delete(p);
    },
  };
  const fetch = async (url, { method = "GET", headers = {}, body } = {}) => {
    const u = new URL(url);
    const q = u.searchParams;
    if (Number(q.get("until")) < now()) return new Response("expired", { status: 403 });
    if (method === "GET" && u.origin === HOST && q.get("op") === "get") {
      const o = objects.get(decodeURIComponent(u.pathname.slice(1)));
      return o ? new Response(o.body, { status: 200, headers: { "content-type": o.contentType } }) : new Response("not found", { status: 404 });
    }
    if (method === "PUT" && `${u.origin}${u.pathname}` === `${API}/` && q.get("op") === "put") {
      const bytes = Buffer.from(body);
      if (headers["x-api-version"] !== BLOB_API_VERSION || headers["x-vercel-blob-access"] !== "private") return new Response("bad headers", { status: 400 });
      if (!q.get("types").split(",").includes(headers["x-content-type"])) return new Response("content type not allowed", { status: 400 });
      if (bytes.length > Number(q.get("max"))) return new Response("too large", { status: 400 });
      objects.set(q.get("pathname"), { body: bytes, contentType: headers["x-content-type"] });
      return new Response("{}", { status: 200 });
    }
    return new Response("unexpected request", { status: 500 });
  };
  return { sdk, fetch, objects, calls };
}

function setup() {
  let t = Date.parse("2026-11-12T10:00:00.000Z");
  const now = () => t;
  const fake = fakeBlob({ now });
  const storage = blobStorage({ token: TOKEN, sdk: fake.sdk, fetch: fake.fetch, now });
  return { ...fake, storage, now, advance: (ms) => { t += ms; } };
}

test("the store id comes from the read-write token, and names the origin files are served from", () => {
  assert.equal(storeIdOf(TOKEN), "AbC123store");
  assert.equal(blobStorage({ token: TOKEN, sdk: {} }).origin, HOST);
  assert.throws(() => blobStorage({ token: "", sdk: {} }), /needs BLOB_READ_WRITE_TOKEN/);
  assert.throws(() => blobStorage({ token: "not-a-blob-token", sdk: {} }), /not a Vercel Blob read-write token/);
});

test("an upload URL takes the declared type and at most the declared size; head reports the bytes really stored", async () => {
  const s = setup();
  const bytes = Buffer.from("png bytes");
  const up = await s.storage.presignPut("p1/r1/screens/a.png", { size: bytes.length, sha256: sha(bytes), contentType: "image/png", expiresIn: 900 });
  assert.equal(up.method, "PUT");
  assert.deepEqual(up.headers, { "content-length": String(bytes.length), "content-type": "image/png", "x-content-type": "image/png", "x-api-version": BLOB_API_VERSION, "x-vercel-blob-access": "private", "x-vercel-blob-store-id": "AbC123store" });
  assert.equal(Number(new URL(up.url).searchParams.get("until")), s.now() + 900_000);

  assert.equal(await s.storage.head("p1/r1/screens/a.png"), null, "nothing there yet");
  assert.equal((await s.fetch(up.url, { method: "PUT", headers: { ...up.headers, "x-content-type": "text/html" }, body: bytes })).status, 400, "another type");
  assert.equal((await s.fetch(up.url, { method: "PUT", headers: up.headers, body: Buffer.concat([bytes, bytes]) })).status, 400, "more bytes");
  assert.equal((await s.fetch(up.url, { method: "PUT", headers: up.headers, body: bytes })).status, 200);
  assert.deepEqual(await s.storage.head("p1/r1/screens/a.png"), { size: bytes.length, contentType: "image/png", sha256: sha(bytes) });

  // Fewer bytes than declared pass the store's cap; head shows them for what they are.
  const short = Buffer.from("png");
  assert.equal((await s.fetch(up.url, { method: "PUT", headers: up.headers, body: short })).status, 200);
  assert.deepEqual(await s.storage.head("p1/r1/screens/a.png"), { size: short.length, contentType: "image/png", sha256: sha(short) });

  s.objects.get("p1/r1/screens/a.png").contentType = "image/png; charset=binary";
  assert.equal((await s.storage.head("p1/r1/screens/a.png")).contentType, "image/png", "parameters are dropped");
});

test("a download URL lasts as long as asked and reads the object; the hash is read past the cache", async () => {
  const s = setup();
  s.objects.set("p1/r1/a.png", { body: Buffer.from("x"), contentType: "image/png" });
  const url = await s.storage.presignGet("p1/r1/a.png", { expiresIn: 300 });
  assert.ok(url.startsWith(`${HOST}/p1/r1/a.png?`));
  assert.equal(new URL(url).searchParams.get("cache"), null);
  assert.equal(await (await s.fetch(url)).text(), "x");
  s.advance(301_000);
  assert.equal((await s.fetch(url)).status, 403);

  const seen = [];
  const storage = blobStorage({ token: TOKEN, sdk: s.sdk, now: s.now, fetch: (u) => (seen.push(u), s.fetch(u)) });
  await storage.head("p1/r1/a.png");
  assert.equal(new URL(seen[0]).searchParams.get("cache"), "0");
});

test("one signed token serves many URLs and is issued again before it runs out; a failed issue is retried", async () => {
  const s = setup();
  await s.storage.presignGet("a.png");
  await s.storage.presignPut("b.png", { size: 1, sha256: sha("b"), contentType: "image/png" });
  assert.equal(s.calls.issue.length, 1);
  assert.deepEqual({ pathname: s.calls.issue[0].pathname, operations: s.calls.issue[0].operations }, { pathname: "*", operations: ["get", "put"] });
  s.advance(39 * 60_000);
  await s.storage.presignGet("a.png");
  assert.equal(s.calls.issue.length, 1, "21 minutes left: still longer than any URL");
  s.advance(2 * 60_000);
  assert.match(await s.storage.presignGet("a.png"), /delegation=d2/);
  assert.equal(s.calls.issue.length, 2);

  let fail = true;
  const sdk = { ...s.sdk, issueSignedToken: async (o) => { if (fail) throw new Error("blob is down"); return s.sdk.issueSignedToken(o); } };
  const storage = blobStorage({ token: TOKEN, sdk, fetch: s.fetch, now: s.now });
  await assert.rejects(storage.presignGet("a.png"), /blob is down/);
  fail = false;
  assert.ok(await storage.presignGet("a.png"));
});

test("list follows the cursor; delete goes out in batches and a missing key is not an error", async () => {
  const s = setup();
  for (const k of ["p1/r1/a.png", "p1/r1/b.png", "p1/r1/c.png", "p1/r2/a.png"]) s.objects.set(k, { body: Buffer.from(k), contentType: "image/png" });
  assert.deepEqual(await s.storage.list("p1/r1/"), ["a", "b", "c"].map((n) => ({ key: `p1/r1/${n}.png`, size: 11 })));
  assert.deepEqual(s.calls.list, [{ prefix: "p1/r1/", cursor: undefined }, { prefix: "p1/r1/", cursor: "2" }]);

  const many = Array.from({ length: 250 }, (_, i) => `p1/r9/${i}.png`);
  await s.storage.delete([...many, "p1/r1/a.png"]);
  assert.deepEqual(s.calls.del.map((b) => b.length).sort(), [100, 100, 51].sort());
  assert.deepEqual([...s.objects.keys()], ["p1/r1/b.png", "p1/r1/c.png", "p1/r2/a.png"]);
  await s.storage.delete([]);
});

test("a store that answers an error is an error, not a missing file", async () => {
  const s = setup();
  s.objects.set("a.png", { body: Buffer.from("x"), contentType: "image/png" });
  const broken = blobStorage({ token: TOKEN, sdk: s.sdk, now: s.now, fetch: async () => new Response("no", { status: 500 }) });
  await assert.rejects(broken.head("a.png"), /storage GET a\.png answered 500/);
  const down = blobStorage({ token: TOKEN, sdk: { ...s.sdk, head: async () => { throw new Error("rate limited"); } }, now: s.now, fetch: s.fetch });
  await assert.rejects(down.head("a.png"), /rate limited/);
});

test("through the API: a run uploads to Blob and completes only when the stored bytes are the declared ones", async () => {
  const s = setup();
  let clock = Date.parse("2026-11-12T10:00:00.000Z");
  const db = memoryDb({ now: () => new Date((clock += 1000)) });
  const deps = { db, storage: s.storage, publicUrl: "https://cloud.example/", now: () => new Date(clock) };
  const project = await db.createProject({ name: "fernwood" });
  const key = await db.createAccessKey(project.id);
  const call = async (method, route, body) => {
    const res = await handle(new Request(`https://cloud.example${route}`, { method, headers: { authorization: `Bearer ${key.secret}`, "user-agent": "imitor/0.1.0", "content-type": "application/json" }, body: body && JSON.stringify(body) }), deps);
    return { status: res.status, body: await res.json() };
  };
  const files = { "screens/a.png": "png-a", "screens/b.png": "png-b" };
  const id = "20261112T100000-abc1234";
  const created = await call("POST", "/v1/runs", {
    clientRunId: id, schemaVersion: 1,
    run: { schemaVersion: 1, id, status: "passed", title: "t", startedAt: "2026-11-12T10:00:00.000Z", finishedAt: "2026-11-12T10:01:00.000Z", flows: [] },
    manifest: { app: "fernwood", shots: [], problems: [] },
    files: Object.entries(files).map(([path, bytes]) => ({ path, size: Buffer.byteLength(bytes), sha256: sha(bytes), contentType: "image/png" })),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const put = (u, bytes) => s.fetch(u.url, { method: "PUT", headers: u.headers, body: Buffer.from(bytes) });
  const [a, b] = ["screens/a.png", "screens/b.png"].map((p) => created.body.uploads.find((u) => u.path === p));
  assert.equal((await put(a, files[a.path])).status, 200);
  assert.equal((await put(b, "PNG-B")).status, 200, "same size, other bytes: the store takes them");

  const refused = await call("POST", `/v1/runs/${created.body.id}/complete`, {});
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body.missing, ["screens/b.png"]);
  assert.equal(s.objects.size, 1, "the file that did not match is deleted");

  assert.equal((await put(b, files[b.path])).status, 200);
  const done = await call("POST", `/v1/runs/${created.body.id}/complete`, {});
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, "ready");
});

test("the environment picks the store: S3_BUCKET first, then BLOB_READ_WRITE_TOKEN, else memory; Vercel needs one of them", async () => {
  assert.equal(depsFromEnv({ BLOB_READ_WRITE_TOKEN: TOKEN }).storage.origin, HOST);
  const s3 = { S3_BUCKET: "runs", S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE", S3_SECRET_ACCESS_KEY: "secret", S3_ENDPOINT: "http://127.0.0.1:9000" };
  assert.equal(depsFromEnv({ ...s3, BLOB_READ_WRITE_TOKEN: TOKEN }).storage.origin, "http://127.0.0.1:9000");
  assert.ok(depsFromEnv({}).storage.handle, "memory");

  const request = new Request("https://app.imitor.dev/api/cloud?__imitor_path=%2Flogin", { headers: { "x-forwarded-host": "app.imitor.dev" } });
  const base = { VERCEL_ENV: "production", PUBLIC_URL: "https://app.imitor.dev", DATABASE_URL: "postgres://unused" };
  const errors = [];
  const error = console.error;
  console.error = (e) => errors.push(e.message);
  try {
    assert.equal((await cloudFunction(base).fetch(request)).status, 500);
    assert.equal((await cloudFunction({ ...base, BLOB_READ_WRITE_TOKEN: TOKEN }).fetch(request)).status, 200);
  } finally {
    console.error = error;
  }
  assert.deepEqual(errors, ["Imitor Cloud on Vercel needs S3_BUCKET or BLOB_READ_WRITE_TOKEN"]);
});

test("the installed @vercel/blob has what the storage calls", async () => {
  const sdk = await import("@vercel/blob");
  for (const name of ["issueSignedToken", "presignUrl", "head", "list", "del", "BlobNotFoundError"]) assert.equal(typeof sdk[name], "function", name);
});
