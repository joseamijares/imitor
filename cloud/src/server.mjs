// A node:http adapter for api.mjs, for self-hosting, local runs and tests: it turns each IncomingMessage into a web
// Request, calls handle, and writes the Response back. Without DATABASE_URL and S3_BUCKET it keeps everything in
// memory. With DATABASE_URL it applies cloud/migrations first.
//   node cloud/src/server.mjs        (environment: see cloud/README.md)
import http from "node:http";
import { pathToFileURL } from "node:url";
import { handle } from "./api.mjs";
import { oidcClient } from "./auth/oidc.mjs";
import { isLocalHttp } from "./auth/session.mjs";
import { memoryDb } from "./db/memory.mjs";
import { pgDb } from "./db/pg.mjs";
import { fail, randomToken, secure } from "./http.mjs";
import { memoryStorage, STORAGE_PATH } from "./storage/memory.mjs";
import { blobFromEnv } from "./storage/blob.mjs";
import { s3FromEnv } from "./storage/s3.mjs";

export const MIN_SECRET_LENGTH = 32;

/**
 * A web stream of a request's body, read only as fast as the handler reads it. Cancelling it (api.mjs does, past
 * MAX_BODY_BYTES) stops reading but leaves the socket open, so the 413 can still be sent; Readable.toWeb would destroy it.
 */
function bodyStream(req) {
  return new ReadableStream({
    start(controller) {
      req.on("data", (chunk) => {
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if (controller.desiredSize <= 0) req.pause();
      });
      req.once("end", () => controller.close());
      req.once("error", (error) => controller.error(error));
      req.pause();
    },
    pull() {
      req.resume();
    },
    cancel() {
      req.pause();
      req.removeAllListeners("data");
    },
  }, { highWaterMark: 4 });
}

/** A web Request for a node IncomingMessage. */
export function toRequest(req, origin) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    for (const v of [].concat(value)) headers.append(name, v);
  }
  // Without a proxy in front, the client's address is the socket's (the admin token form counts failures by address).
  if (!headers.has("x-forwarded-for") && req.socket?.remoteAddress) headers.set("x-forwarded-for", req.socket.remoteAddress);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : bodyStream(req);
  return new Request(new URL(req.url, origin), { method: req.method, headers, body, duplex: "half" });
}

/** How long a connection keeps reading, and discarding, a body it answered early before it is dropped. */
export const LINGER_MS = 2000;

/**
 * Close a connection whose request body was not read to the end without losing the answer. node closes it with
 * socket.destroySoon(), which drops the socket at once; the client's unsent body is still arriving, so the kernel answers
 * it with a reset, and a reset makes the client's kernel discard what it had received but not yet read: the 413 itself.
 * Instead: send the answer and a FIN, keep reading and discarding what the client still sends, and drop the socket once
 * the client closes its side or after LINGER_MS, whichever comes first (the usual "lingering close").
 */
function lingerOnClose(socket) {
  if (!socket || socket.imitorLinger) return;
  socket.imitorLinger = true;
  socket.destroySoon = function lingeringClose() {
    this.end();
    this.resume();
    const timer = setTimeout(() => this.destroy(), LINGER_MS);
    timer.unref();
    this.once("close", () => clearTimeout(timer));
  };
}

/** Write a web Response to a node ServerResponse. */
export async function send(res, response, req = null) {
  const body = Buffer.from(await response.arrayBuffer());
  const headers = Object.fromEntries(response.headers);
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length) headers["set-cookie"] = setCookies; // one header each, not joined with commas
  // A body the handler did not read to the end (refused, or over the limit) is not drained: the connection closes,
  // after a short linger so the client can read the answer while it is still sending.
  if (req && !req.complete) {
    headers.connection = "close";
    lingerOnClose(req.socket);
  }
  res.writeHead(response.status, headers);
  res.end(body);
}

const list = (value) => String(value || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/** deps from the environment: memory adapters unless DATABASE_URL / S3_BUCKET / BLOB_READ_WRITE_TOKEN say otherwise. See cloud/README.md.
 * opts: { poolMax: Postgres connections per instance (1 in a serverless function) }. */
export function depsFromEnv(env = process.env, { poolMax = 5 } = {}) {
  const allowUnverified = env.IMITOR_ALLOW_UNVERIFIED_UPLOADS === "1";
  if (env.S3_BUCKET && env.S3_CHECKSUMS === "off" && !allowUnverified) {
    throw new Error("S3_CHECKSUMS=off means storage keeps no SHA-256 of uploads, so complete cannot check a file's bytes against what the run declared. Turn checksums back on, or set IMITOR_ALLOW_UNVERIFIED_UPLOADS=1 to accept unverified files (unsafe).");
  }
  const publicUrl = env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : null;
  if (publicUrl && !publicUrl.startsWith("https:") && !isLocalHttp(publicUrl)) {
    throw new Error(`PUBLIC_URL must start with https:// (plain http:// only for localhost, 127.0.0.1 or [::1]), got "${env.PUBLIC_URL}"`);
  }
  let oidc = null;
  if (env.GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_SECRET) {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error("Google sign-in needs both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
    if (!publicUrl) throw new Error("Google sign-in needs PUBLIC_URL: the redirect URI registered with Google is PUBLIC_URL/auth/google/callback.");
    oidc = oidcClient({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: `${publicUrl}/auth/google/callback` });
  }
  for (const name of ["IMITOR_ADMIN_TOKEN", "CRON_SECRET"]) {
    if (env[name] && env[name].length < MIN_SECRET_LENGTH) throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters (for example: openssl rand -base64 32).`);
  }
  return {
    db: env.DATABASE_URL ? pgDb({ connectionString: env.DATABASE_URL, max: poolMax }) : memoryDb(),
    storage: s3FromEnv(env) || blobFromEnv(env) || memoryStorage(),
    publicUrl,
    minCliVersion: env.MIN_CLI_VERSION || null,
    allowUnverified,
    oidc,
    allowedEmails: new Set(list(env.IMITOR_ALLOWED_EMAILS)),
    adminToken: env.IMITOR_ADMIN_TOKEN || null,
    adminEmail: env.IMITOR_ADMIN_EMAIL || null,
    cronSecret: env.CRON_SECRET || null,
    log: (error) => console.error(error),
  };
}

/** Listen on `port` (0 for any free port). Returns { url, port, deps, close }. */
export async function startServer({ port = 0, host = "127.0.0.1", deps = depsFromEnv() } = {}) {
  let origin = null;
  const server = http.createServer(async (req, res) => {
    try {
      const request = toRequest(req, origin);
      const local = deps.storage.handle && new URL(request.url).pathname.startsWith(STORAGE_PATH);
      await send(res, local ? await deps.storage.handle(request) : await handle(request, deps), req);
    } catch (error) {
      deps.log?.(error);
      if (res.headersSent) return res.destroy();
      // The same headers as every other answer: no sniffing, never framed, the strict CSP.
      const failed = secure(fail(500, "the server failed to handle this request"), { https: String(deps.publicUrl || "").startsWith("https:") });
      await send(res, failed, req).catch(() => res.destroy());
    }
  });
  const actual = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
  origin = `http://${host}:${actual}`;
  if ("baseUrl" in deps.storage && !deps.storage.baseUrl) deps.storage.baseUrl = origin;
  if (!deps.publicUrl) deps.publicUrl = origin;
  const close = () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); });
  return { url: origin, port: actual, deps, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = { ...process.env };
  const inMemory = !env.DATABASE_URL;
  // In memory nothing outlives the process, so a local run gets an admin token of its own to sign in with.
  if (inMemory && !env.IMITOR_ADMIN_TOKEN) env.IMITOR_ADMIN_TOKEN = randomToken(32);
  const deps = depsFromEnv(env);
  if (env.DATABASE_URL) {
    const { migrate } = await import("./db/migrate.mjs");
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
    try {
      await migrate(pool, { log: (line) => console.log(`migrations: ${line}`) });
    } finally {
      await pool.end();
    }
  }
  const server = await startServer({ port: Number(env.PORT || 8787), host: env.HOST || "127.0.0.1", deps });
  console.log(`Imitor Cloud at ${server.url}${inMemory ? " (in memory: nothing is kept after it stops)" : ""}`);
  if (inMemory) {
    const admin = await deps.db.createUser({ email: deps.adminEmail || "admin", name: "Admin", allowed: true });
    const project = await deps.db.createProject({ name: "local", ownerId: admin.id });
    const key = await deps.db.createAccessKey(project.id, { name: "local" });
    console.log(`Sign in at ${deps.publicUrl}/login/token with the admin token:\n  ${env.IMITOR_ADMIN_TOKEN}`);
    console.log(`Push to the project "local" with:\n  IMITOR_CLOUD_URL=${server.url} IMITOR_TOKEN=${key.secret} npx imitor push`);
  }
}
