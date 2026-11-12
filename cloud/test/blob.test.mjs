// The Vercel Blob adapter against a fake of the @vercel/blob functions it uses: what it asks Vercel to sign, what it
// hands the client, and that head() hashes the stored bytes so complete can still check them.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { blobFromEnv, blobStorage, storeIdOf } from "../src/storage/blob.mjs";

const TOKEN = "vercel_blob_rw_AbC123xyz_s3cr3t";

function fakeSdk(objects = new Map()) {
  const calls = { issued: [], presigned: [], got: [], listed: [], deleted: [] };
  const sdk = {
    async issueSignedToken(opts) {
      calls.issued.push(opts);
      return { delegationToken: `d${calls.issued.length}`, clientSigningToken: `c${calls.issued.length}`, validUntil: opts.validUntil };
    },
    async presignUrl(signed, opts) {
      calls.presigned.push({ signed, opts });
      return { presignedUrl: `https://signed.example/${opts.operation}/${opts.pathname}?by=${signed.delegationToken}` };
    },
    async get(pathname, opts) {
      calls.got.push({ pathname, opts });
      const o = objects.get(pathname);
      if (!o) return null;
      const stream = (async function* () {
        for (let i = 0; i < o.bytes.length; i += 3) yield o.bytes.subarray(i, i + 3);
      })();
      return { statusCode: 200, stream, blob: { contentType: o.contentType } };
    },
    async list(opts) {
      calls.listed.push(opts);
      const all = [...objects.keys()].filter((k) => k.startsWith(opts.prefix)).sort();
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const page = all.slice(start, start + 2);
      const next = start + 2;
      return { blobs: page.map((k) => ({ pathname: k, size: objects.get(k).bytes.length })), hasMore: next < all.length, cursor: String(next) };
    },
    async del(urls, opts) {
      calls.deleted.push({ urls, opts });
    },
  };
  return { sdk, calls };
}

test("the store id comes from the read-write token, and anything else is refused", () => {
  assert.equal(storeIdOf(TOKEN), "abc123xyz");
  assert.throws(() => storeIdOf("not-a-token"), /not a Vercel Blob read-write token/);
  assert.equal(blobStorage({ token: TOKEN, sdk: fakeSdk().sdk }).origin, "https://abc123xyz.private.blob.vercel-storage.com");
  assert.equal(blobFromEnv({}), null);
  assert.ok(blobFromEnv({ BLOB_READ_WRITE_TOKEN: TOKEN }));
});

test("uploads: one signed token for many files, each URL limited to one path, its size and its content type", async () => {
  let clock = 1_000_000;
  const { sdk, calls } = fakeSdk();
  const storage = blobStorage({ token: TOKEN, sdk, now: () => clock });
  const a = await storage.presignPut("prj/run/shots/a.png", { size: 10, sha256: "0".repeat(64), contentType: "image/png" });
  await storage.presignPut("prj/run/manifest.json", { size: 20, sha256: "1".repeat(64), contentType: "application/json" });
  assert.equal(calls.issued.length, 1, "the token is reused");
  assert.deepEqual(calls.issued[0].operations, ["put"]);
  assert.equal(calls.issued[0].token, TOKEN);
  assert.ok(calls.issued[0].validUntil >= clock + 900_000 + 60_000);
  assert.equal(a.method, "PUT");
  assert.equal(a.url, "https://signed.example/put/prj/run/shots/a.png?by=d1");
  assert.equal(a.headers["x-content-type"], "image/png");
  assert.equal(a.headers["x-vercel-blob-access"], "private");
  const signed = calls.presigned[0].opts;
  assert.deepEqual({ ...signed, validUntil: undefined }, { operation: "put", pathname: "prj/run/shots/a.png", access: "private", validUntil: undefined, maximumSizeInBytes: 10, allowedContentTypes: ["image/png"], addRandomSuffix: false, allowOverwrite: true });
  assert.equal(signed.validUntil, clock + 900_000);
  // Near the token's end, a new one is issued rather than signing a URL that would outlive it.
  clock += 55 * 60 * 1000;
  await storage.presignPut("prj/run/shots/b.png", { size: 5, sha256: "2".repeat(64), contentType: "image/png" });
  assert.equal(calls.issued.length, 2);
});

test("downloads: a short-lived URL signed with a get-only token", async () => {
  const { sdk, calls } = fakeSdk();
  const storage = blobStorage({ token: TOKEN, sdk, now: () => 5000 });
  const url = await storage.presignGet("prj/run/shots/a.png", { expiresIn: 300 });
  assert.equal(url, "https://signed.example/get/prj/run/shots/a.png?by=d1");
  assert.deepEqual(calls.issued[0].operations, ["get"]);
  assert.deepEqual(calls.presigned[0].opts, { operation: "get", pathname: "prj/run/shots/a.png", access: "private", validUntil: 5000 + 300_000 });
});

test("head reads the object and hashes it, so complete can compare the SHA-256; a missing object is null", async () => {
  const bytes = Buffer.from("the bytes of a screenshot");
  const { sdk, calls } = fakeSdk(new Map([["prj/run/a.png", { bytes, contentType: "image/png" }], ["prj/run/m.json", { bytes, contentType: "application/json; charset=utf-8" }]]));
  const storage = blobStorage({ token: TOKEN, sdk });
  assert.deepEqual(await storage.head("prj/run/a.png"), { size: bytes.length, contentType: "image/png", sha256: createHash("sha256").update(bytes).digest("hex") });
  assert.equal((await storage.head("prj/run/m.json")).contentType, "application/json");
  assert.equal(await storage.head("prj/run/none.png"), null);
  assert.deepEqual(calls.got[0].opts, { access: "private", token: TOKEN, useCache: false });
});

test("list pages through every object under a prefix; delete sends the store's URLs in batches", async () => {
  const objects = new Map(["p/r/a", "p/r/b", "p/r/c", "p/other/d"].map((k) => [k, { bytes: Buffer.from(k), contentType: "image/png" }]));
  const { sdk, calls } = fakeSdk(objects);
  const storage = blobStorage({ token: TOKEN, sdk });
  assert.deepEqual(await storage.list("p/r/"), [{ key: "p/r/a", size: 5 }, { key: "p/r/b", size: 5 }, { key: "p/r/c", size: 5 }]);
  assert.equal(calls.listed.length, 2);
  await storage.delete([]);
  assert.equal(calls.deleted.length, 0);
  const keys = Array.from({ length: 150 }, (_, i) => `p/r/shot ${i}.png`);
  await storage.delete(keys);
  assert.deepEqual(calls.deleted.map((d) => d.urls.length).sort((x, y) => x - y), [50, 100]);
  assert.ok(calls.deleted.flatMap((d) => d.urls).includes("https://abc123xyz.private.blob.vercel-storage.com/p/r/shot%200.png"));
  assert.equal(calls.deleted[0].opts.token, TOKEN);
});

test("a failed token request is not kept: the next call asks again", async () => {
  const { sdk, calls } = fakeSdk();
  let fail = true;
  const issue = sdk.issueSignedToken;
  sdk.issueSignedToken = async (opts) => {
    if (fail) {
      fail = false;
      throw new Error("Vercel is down");
    }
    return issue(opts);
  };
  const storage = blobStorage({ token: TOKEN, sdk });
  await assert.rejects(storage.presignGet("k"), /Vercel is down/);
  assert.match(await storage.presignGet("k"), /by=d1/);
  assert.equal(calls.issued.length, 1);
});
