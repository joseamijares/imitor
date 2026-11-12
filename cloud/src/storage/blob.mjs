// Storage on a private Vercel Blob store, for a deployment that keeps everything in its Vercel project. The same
// contract as s3.mjs (see interface.mjs): uploads and downloads go through presigned URLs, so file bytes never pass
// through the function, and nothing in the store is public.
//
// Blob keeps no SHA-256 of an object, so head() reads the object and hashes it: complete still refuses bytes that are
// not the ones the run declared, at the cost of reading each file once when a run is completed.
//
// The signing protocol is Vercel's own, so this uses their SDK (@vercel/blob) rather than reimplementing it. A signed
// token is one call to Vercel's API; it is issued for any path and kept until shortly before it expires, and each URL
// is then signed locally, scoped to one path, one size limit and one content type.

import { createHash } from "node:crypto";
import { mapLimit } from "../limit.mjs";
import { encodeKey } from "./s3.mjs";

const TOKEN_MS = 60 * 60 * 1000; // a signed token lasts an hour
const MARGIN_MS = 60 * 1000; // and is replaced when less than a minute would be left after the longest URL it signs

/** The store id in a read-write token ("vercel_blob_rw_<storeId>_<secret>"), lowercased as in the store's host. */
export function storeIdOf(token) {
  const id = String(token || "").split("_")[3] || "";
  if (!/^[A-Za-z0-9]+$/.test(id)) throw new Error("BLOB_READ_WRITE_TOKEN is not a Vercel Blob read-write token");
  return id.toLowerCase();
}

/**
 * opts: { token (BLOB_READ_WRITE_TOKEN of a private store), sdk (the @vercel/blob functions, for tests), now }.
 */
export function blobStorage({ token, sdk = null, now = () => Date.now() }) {
  const storeId = storeIdOf(token);
  const origin = `https://${storeId}.private.blob.vercel-storage.com`;
  let loaded = sdk ? Promise.resolve(sdk) : null;
  const blob = () => (loaded ||= import("@vercel/blob"));
  const tokens = new Map(); // operation -> Promise<{ signed, until }>

  /** A signed token for `operation` that outlives a URL valid for `ms` more, issued once per hour or so. */
  async function signedToken(operation, ms) {
    const held = tokens.get(operation);
    if (held) {
      const t = await held.catch(() => null);
      if (t && t.until - now() > ms + MARGIN_MS) return t.signed;
      if (tokens.get(operation) !== held) return signedToken(operation, ms);
    }
    const until = now() + Math.max(TOKEN_MS, ms + 2 * MARGIN_MS);
    const issuing = blob().then((b) => b.issueSignedToken({ operations: [operation], validUntil: until, token })).then((signed) => ({ signed, until }));
    tokens.set(operation, issuing);
    issuing.catch(() => tokens.get(operation) === issuing && tokens.delete(operation));
    return (await issuing).signed;
  }

  return {
    /** Where files are served from, for the interface's Content-Security-Policy. */
    origin,
    async presignPut(key, { size, contentType, expiresIn = 900 }) {
      const ms = expiresIn * 1000;
      const b = await blob();
      const { presignedUrl } = await b.presignUrl(await signedToken("put", ms), {
        operation: "put",
        pathname: key,
        access: "private",
        validUntil: now() + ms,
        maximumSizeInBytes: size,
        allowedContentTypes: [contentType],
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      // The headers Vercel's own client sends with a presigned upload; the URL carries the signed limits.
      const headers = {
        "x-vercel-blob-access": "private",
        "x-content-type": contentType,
        "x-add-random-suffix": "0",
        "x-allow-overwrite": "1",
        "x-vercel-blob-store-id": storeId,
        "x-api-version": "13",
      };
      return { method: "PUT", url: presignedUrl, headers };
    },
    async presignGet(key, { expiresIn = 300 } = {}) {
      const ms = expiresIn * 1000;
      const b = await blob();
      const { presignedUrl } = await b.presignUrl(await signedToken("get", ms), { operation: "get", pathname: key, access: "private", validUntil: now() + ms });
      return presignedUrl;
    },
    async head(key) {
      const b = await blob();
      const found = await b.get(key, { access: "private", token, useCache: false });
      if (!found) return null;
      if (found.statusCode !== 200 || !found.stream) throw new Error(`storage GET ${key} answered ${found.statusCode}`);
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of found.stream) {
        size += chunk.byteLength;
        hash.update(chunk);
      }
      const contentType = (found.blob.contentType || "").split(";")[0].trim() || null;
      return { size, contentType, sha256: hash.digest("hex") };
    },
    async list(prefix) {
      const b = await blob();
      const objects = [];
      let cursor;
      do {
        const page = await b.list({ prefix, cursor, limit: 1000, token });
        for (const o of page.blobs) objects.push({ key: o.pathname, size: o.size });
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return objects;
    },
    async delete(keys) {
      if (!keys.length) return;
      const b = await blob();
      const batches = [];
      for (let i = 0; i < keys.length; i += 100) batches.push(keys.slice(i, i + 100));
      // Deleting a URL that has no object is not an error for Blob.
      await mapLimit(batches, (batch) => b.del(batch.map((key) => `${origin}/${encodeKey(key)}`), { token }), 4);
    },
  };
}

/** Blob storage from BLOB_READ_WRITE_TOKEN (set by Vercel when a Blob store is connected); null without it. */
export function blobFromEnv(env = process.env) {
  return env.BLOB_READ_WRITE_TOKEN ? blobStorage({ token: env.BLOB_READ_WRITE_TOKEN }) : null;
}
