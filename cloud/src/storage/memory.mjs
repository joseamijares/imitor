// Storage in memory, for tests and local runs. Its upload URLs point at the server itself (/__storage/<key>), which
// hands those requests to `handle`, and it checks them the way S3 would: an HMAC-signed, expiring URL that only
// accepts the declared size, content type and SHA-256. Never use it for real data: it is gone on restart.
import crypto from "node:crypto";
import { encodeKey, hexToBase64 } from "./s3.mjs";

export const STORAGE_PATH = "/__storage/";

const plain = (status, text) => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** opts: { baseUrl: where the server is reachable (can be set later, once it listens), now }. */
export function memoryStorage({ baseUrl = null, now = () => Date.now() } = {}) {
  const secret = crypto.randomBytes(32);
  const objects = new Map(); // key -> { body: Buffer, contentType }
  const sign = (fields) => crypto.createHmac("sha256", secret).update(JSON.stringify(fields)).digest("hex");
  const url = (method, key, params) => {
    if (!storage.baseUrl) throw new Error("memory storage has no baseUrl yet");
    const query = new URLSearchParams({ ...params, sig: sign([method, key, params]) });
    return `${storage.baseUrl.replace(/\/+$/, "")}${STORAGE_PATH}${encodeKey(key)}?${query}`;
  };

  const storage = {
    baseUrl,
    objects,
    async presignPut(key, { size, sha256, contentType, expiresIn = 900 }) {
      const params = { expires: String(now() + expiresIn * 1000), size: String(size), sha256, type: contentType };
      return { method: "PUT", url: url("PUT", key, params), headers: { "content-length": String(size), "content-type": contentType, "x-amz-checksum-sha256": hexToBase64(sha256) } };
    },
    async presignGet(key, { expiresIn = 300 } = {}) {
      return url("GET", key, { expires: String(now() + expiresIn * 1000) });
    },
    async head(key) {
      const o = objects.get(key);
      return o ? { size: o.body.length, contentType: o.contentType, sha256: crypto.createHash("sha256").update(o.body).digest("hex") } : null;
    },
    async list(prefix) {
      return [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, o]) => ({ key, size: o.body.length }));
    },
    async delete(keys) {
      for (const key of keys) objects.delete(key);
    },
    /** Answer a request to a URL from presignPut or presignGet. */
    async handle(request) {
      const u = new URL(request.url);
      let key;
      try {
        key = decodeURIComponent(u.pathname.slice(STORAGE_PATH.length));
      } catch {
        return plain(400, "bad key");
      }
      const params = Object.fromEntries(u.searchParams);
      const { sig, ...signed } = params;
      if (!["PUT", "GET"].includes(request.method)) return plain(405, "method not allowed");
      if (!sig || sig.length !== 64 || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign([request.method, key, signed])))) return plain(403, "SignatureDoesNotMatch");
      if (Number(signed.expires) < now()) return plain(403, "Request has expired");
      if (request.method === "GET") {
        const o = objects.get(key);
        return o ? new Response(o.body, { status: 200, headers: { "content-type": o.contentType } }) : plain(404, "NoSuchKey");
      }
      if (request.headers.get("content-type") !== signed.type) return plain(403, "SignatureDoesNotMatch: content-type");
      if (request.headers.get("x-amz-checksum-sha256") !== hexToBase64(signed.sha256)) return plain(403, "SignatureDoesNotMatch: x-amz-checksum-sha256");
      const body = Buffer.from(await request.arrayBuffer());
      if (body.length !== Number(signed.size)) return plain(400, `IncompleteBody: expected ${signed.size} bytes, got ${body.length}`);
      if (crypto.createHash("sha256").update(body).digest("hex") !== signed.sha256) return plain(400, "BadDigest");
      objects.set(key, { body, contentType: signed.type });
      return new Response(null, { status: 200 });
    },
  };
  return storage;
}
