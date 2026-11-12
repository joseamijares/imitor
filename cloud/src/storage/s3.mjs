// Object storage on anything that speaks the S3 API (AWS S3, Cloudflare R2, MinIO, ...), with a hand-written AWS
// Signature Version 4 query-string presigner on node:crypto, so there is no SDK to install. Every call is a presigned
// URL: PUT for the client to upload to, GET for the interface to show, HEAD and DELETE for the server itself.
// See interface.mjs for the Storage contract.
import crypto from "node:crypto";

const hmac = (key, data) => crypto.createHmac("sha256", key).update(data, "utf8").digest();
const sha256Hex = (data) => crypto.createHash("sha256").update(data, "utf8").digest("hex");

/** RFC 3986 encoding as SigV4 wants it: everything but A-Z a-z 0-9 - . _ ~ escaped. */
export const uriEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** An object key as a URL path: each segment encoded, the slashes kept. */
export const encodeKey = (key) => key.split("/").map(uriEncode).join("/");

/** 20130524T000000Z */
export const amzDate = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** The SigV4 signing key for a day (YYYYMMDD), region and service. */
export function signingKey(secretAccessKey, day, region, service = "s3") {
  return hmac(hmac(hmac(hmac("AWS4" + secretAccessKey, day), region), service), "aws4_request");
}

/**
 * A SigV4 presigned URL for `method` on `url` (a full object URL with its path already encoded, no query).
 * `headers` are signed in addition to host, so the request must carry them with exactly these values.
 * Returns { url, canonicalRequest, stringToSign, signature } (the last three for tests and debugging).
 */
export function presign({ method, url, headers = {}, region, accessKeyId, secretAccessKey, sessionToken = null, expiresIn = 900, date = new Date(), service = "s3" }) {
  const u = new URL(url);
  const time = amzDate(date);
  const scope = `${time.slice(0, 8)}/${region}/${service}/aws4_request`;
  const signed = { host: u.host };
  for (const [k, v] of Object.entries(headers)) signed[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  const names = Object.keys(signed).sort();
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": time,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": names.join(";"),
  };
  if (sessionToken) query["X-Amz-Security-Token"] = sessionToken;
  const canonicalQuery = Object.keys(query).map((k) => [uriEncode(k), uriEncode(query[k])]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonicalRequest = [method, u.pathname, canonicalQuery, names.map((n) => `${n}:${signed[n]}\n`).join(""), names.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", time, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(secretAccessKey, time.slice(0, 8), region, service), stringToSign).toString("hex");
  return { url: `${u.origin}${u.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`, canonicalRequest, stringToSign, signature };
}

/** sha256 as 64 hex digits to the base64 form S3's x-amz-checksum-sha256 takes. */
export const hexToBase64 = (hex) => Buffer.from(hex, "hex").toString("base64");

/**
 * opts: { bucket, region, accessKeyId, secretAccessKey, endpoint (default AWS for the region), pathStyle (default
 * true when an endpoint is given: R2 and MinIO want it), checksums (default true: sign x-amz-checksum-sha256 into
 * uploads so the store refuses bytes that do not match), fetch, now }.
 */
export function s3Storage({ bucket, region, accessKeyId, secretAccessKey, sessionToken = null, endpoint = null, pathStyle = endpoint != null, checksums = true, fetch = globalThis.fetch, now = () => new Date() }) {
  for (const [name, value] of Object.entries({ bucket, region, accessKeyId, secretAccessKey })) if (!value) throw new Error(`S3 storage needs ${name}`);
  const base = new URL(endpoint || `https://s3.${region}.amazonaws.com`);
  const objectUrl = (key) => (pathStyle ? `${base.origin}/${uriEncode(bucket)}/${encodeKey(key)}` : `${base.protocol}//${bucket}.${base.host}/${encodeKey(key)}`);
  const sign = (method, key, { headers = {}, expiresIn = 900 } = {}) => presign({ method, url: objectUrl(key), headers, region, accessKeyId, secretAccessKey, sessionToken, expiresIn, date: now() }).url;

  return {
    async presignPut(key, { size, sha256, contentType, expiresIn = 900 }) {
      const headers = { "content-length": String(size), "content-type": contentType };
      if (checksums && sha256) headers["x-amz-checksum-sha256"] = hexToBase64(sha256);
      return { method: "PUT", url: sign("PUT", key, { headers, expiresIn }), headers };
    },
    async presignGet(key, { expiresIn = 300 } = {}) {
      return sign("GET", key, { expiresIn });
    },
    async head(key) {
      const res = await fetch(sign("HEAD", key, { expiresIn: 60 }), { method: "HEAD" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`storage HEAD ${key} answered ${res.status}`);
      return { size: Number(res.headers.get("content-length")), contentType: res.headers.get("content-type") };
    },
    async delete(keys) {
      for (const key of keys) {
        const res = await fetch(sign("DELETE", key, { expiresIn: 60 }), { method: "DELETE" });
        if (!res.ok && res.status !== 404) throw new Error(`storage DELETE ${key} answered ${res.status}`);
      }
    },
  };
}

/** S3 storage from S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY; null without S3_BUCKET. */
export function s3FromEnv(env = process.env) {
  if (!env.S3_BUCKET) return null;
  return s3Storage({
    bucket: env.S3_BUCKET,
    region: env.S3_REGION || "auto",
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    endpoint: env.S3_ENDPOINT || null,
    checksums: env.S3_CHECKSUMS !== "off",
  });
}
