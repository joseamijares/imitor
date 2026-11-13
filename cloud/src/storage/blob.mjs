// Object storage on a private Vercel Blob store, through @vercel/blob (loaded only when this storage is used). The
// client uploads to a presigned PUT URL and the interface shows files through presigned GET URLs, as with S3; HEAD,
// list and delete are the server's own calls with the store's read-write token. See interface.mjs for the contract.
//
// What differs from S3:
// - Blob keeps no SHA-256 of an object and a presigned upload only caps the size, so `head` reads the object back and
//   hashes it. The API then compares size, content type and SHA-256 with what the run declared, exactly as with S3;
//   the cost is one download of every file of a run when it is completed.
// - One signed token for the whole store (get and put) is issued by Blob's API and reused until it is close to
//   expiry; each URL is then signed locally for one pathname, one operation and a shorter life.
import crypto from "node:crypto";
import { mapLimit } from "../limit.mjs";

/** The version of Blob's API the upload request names, as @vercel/blob does (its BLOB_API_VERSION). */
export const BLOB_API_VERSION = "13";
const TOKEN_MS = 60 * 60 * 1000; // a signed token's life (Blob's default)
const TOKEN_MARGIN_MS = 20 * 60 * 1000; // re-issue when less than this is left: longer than any URL signed with it
const DELETE_BATCH = 100;

/** The store id inside a read-write token ("vercel_blob_rw_<storeId>_<secret>"), or "". */
export const storeIdOf = (token) => String(token || "").split("_")[3] || "";

/**
 * opts: { token: the store's BLOB_READ_WRITE_TOKEN, sdk: @vercel/blob or a stand-in (tests), fetch, now: () => ms }.
 */
export function blobStorage({ token, sdk = null, fetch = globalThis.fetch, now = () => Date.now() }) {
  if (!token) throw new Error("Vercel Blob storage needs BLOB_READ_WRITE_TOKEN");
  const storeId = storeIdOf(token);
  if (!storeId) throw new Error("BLOB_READ_WRITE_TOKEN is not a Vercel Blob read-write token (vercel_blob_rw_<store>_...)");
  let loading = null;
  const blob = () => (loading ||= sdk ? Promise.resolve(sdk) : import("@vercel/blob"));

  let issued = null; // { promise, validUntil }
  /** The store-wide signed token, re-issued when it is close to expiry. A failed issue is not kept. */
  const signedToken = () => {
    if (!issued || issued.validUntil - now() < TOKEN_MARGIN_MS) {
      const validUntil = now() + TOKEN_MS;
      const promise = blob().then((b) => b.issueSignedToken({ pathname: "*", operations: ["get", "put"], validUntil, token }));
      const mine = (issued = { promise, validUntil });
      promise.catch(() => {
        if (issued === mine) issued = null;
      });
    }
    return issued.promise;
  };
  const sign = async (options) => (await (await blob()).presignUrl(await signedToken(), { access: "private", ...options })).presignedUrl;
  const getUrl = (key, { expiresIn, useCache }) => sign({ operation: "get", pathname: key, validUntil: now() + expiresIn * 1000, ...(useCache === false ? { useCache: false } : {}) });

  /** The SHA-256 (hex) and length of the object's bytes, read back from the store past its cache. */
  async function digest(key) {
    const res = await fetch(await getUrl(key, { expiresIn: 60, useCache: false }));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`storage GET ${key} answered ${res.status}`);
    const hash = crypto.createHash("sha256");
    let size = 0;
    for await (const chunk of res.body) {
      hash.update(chunk);
      size += chunk.length;
    }
    return { sha256: hash.digest("hex"), size };
  }

  return {
    /** Where files are served from, for the interface's Content-Security-Policy. */
    origin: `https://${storeId.toLowerCase()}.private.blob.vercel-storage.com`,
    async presignPut(key, { size, contentType, expiresIn = 900 }) {
      const url = await sign({ operation: "put", pathname: key, validUntil: now() + expiresIn * 1000, allowedContentTypes: [contentType], maximumSizeInBytes: size, addRandomSuffix: false, allowOverwrite: true });
      // The headers @vercel/blob sends with a presigned upload. x-content-type is the type Blob stores and checks
      // against allowedContentTypes; without it Blob would go by the pathname's extension.
      return { method: "PUT", url, headers: { "content-length": String(size), "content-type": contentType, "x-content-type": contentType, "x-api-version": BLOB_API_VERSION, "x-vercel-blob-access": "private", "x-vercel-blob-store-id": storeId } };
    },
    async presignGet(key, { expiresIn = 300 } = {}) {
      return getUrl(key, { expiresIn });
    },
    async head(key) {
      const b = await blob();
      let meta;
      try {
        meta = await b.head(key, { token });
      } catch (error) {
        if (error instanceof b.BlobNotFoundError) return null;
        throw error;
      }
      const read = await digest(key);
      if (!read) return null;
      // The size is the number of bytes read, so a listing that lags behind an overwrite cannot vouch for them.
      return { size: read.size, contentType: meta.contentType ? String(meta.contentType).split(";")[0].trim() : null, sha256: read.sha256 };
    },
    async list(prefix) {
      const b = await blob();
      const objects = [];
      let cursor;
      do {
        const page = await b.list({ prefix, limit: 1000, cursor, token });
        for (const o of page.blobs) objects.push({ key: o.pathname, size: o.size });
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return objects;
    },
    async delete(keys) {
      const b = await blob();
      const batches = [];
      for (let i = 0; i < keys.length; i += DELETE_BATCH) batches.push(keys.slice(i, i + DELETE_BATCH));
      await mapLimit(batches, (batch) => b.del(batch, { token }));
    },
  };
}

/** Blob storage from BLOB_READ_WRITE_TOKEN; null without it. S3_BUCKET, when set, wins (see server.mjs). */
export function blobFromEnv(env = process.env) {
  return env.BLOB_READ_WRITE_TOKEN ? blobStorage({ token: env.BLOB_READ_WRITE_TOKEN }) : null;
}
