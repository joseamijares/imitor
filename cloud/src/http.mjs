// Small pieces every route uses: JSON, HTML and redirect responses, bounded body reading, cookies, constant-time
// comparison, and the security headers every answer leaves with.
import crypto from "node:crypto";

export const json = (status, value, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
export const fail = (status, error, extra = {}, headers = {}) => json(status, { error, ...extra }, headers);

/** An HTML page. `csp` is its Content-Security-Policy (secure() adds a strict default when none is given). */
export const page = (status, body, { csp = null, headers = {} } = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...(csp ? { "content-security-policy": csp } : {}), ...headers } });

/** A redirect with headers that can still be added to (Response.redirect's are immutable). */
export const redirect = (location, status = 302, headers = {}) => new Response(null, { status, headers: { location, "cache-control": "no-store", ...headers } });

/**
 * The body as text, read as a stream and abandoned past `limit` bytes, so a chunked body without a content-length (or
 * with a false one) cannot make the server hold more than that. Returns { text } or { tooLarge: true }.
 */
export async function readText(request, limit) {
  if (Number(request.headers.get("content-length")) > limit) return { tooLarge: true };
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { text: new TextDecoder().decode(bytes) };
}

/** A small form or JSON body as a plain object: { fields } or { error } (body too large, or not parseable). */
export async function readFields(request, limit = 16 * 1024) {
  const { text, tooLarge } = await readText(request, limit);
  if (tooLarge) return { error: "the body is too large" };
  const type = request.headers.get("content-type") || "";
  if (type.startsWith("application/x-www-form-urlencoded")) return { fields: Object.fromEntries(new URLSearchParams(text)), form: true };
  if (!text.trim()) return { fields: {} };
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? { fields: value } : { error: "the body must be a JSON object" };
  } catch {
    return { error: "the body must be JSON" };
  }
}

/** Cookies of a request as { name: value }. */
export function cookies(request) {
  const out = {};
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

/** A Set-Cookie value. opts: { maxAge (seconds; 0 deletes), secure, sameSite }. HttpOnly and Path=/ always. */
export const cookie = (name, value, { maxAge, secure = true, sameSite = "Lax" } = {}) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=${sameSite}${secure ? "; Secure" : ""}${maxAge != null ? `; Max-Age=${maxAge}` : ""}`;

/** Equal strings, compared in time that does not depend on where they differ. */
export function safeEqual(a, b) {
  const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
  return typeof a === "string" && typeof b === "string" && crypto.timingSafeEqual(digest(a), digest(b));
}

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

/** Escape text for HTML. */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

// What a page of ours may load: nothing unless listed. JSON, redirects and files get the default, which allows nothing.
export const CSP_NONE = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * Every answer: no sniffing, no referrer beyond this origin, never framed, and HTTPS only on an https PUBLIC_URL.
 * A response without its own Content-Security-Policy gets CSP_NONE.
 */
export function secure(response, { https = false } = {}) {
  const h = response.headers;
  if (!h.has("content-security-policy")) h.set("content-security-policy", CSP_NONE);
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "same-origin");
  h.set("x-frame-options", "DENY");
  h.set("cross-origin-opener-policy", "same-origin");
  if (https) h.set("strict-transport-security", "max-age=31536000");
  return response;
}
