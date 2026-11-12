// A node:http adapter for api.mjs, for local runs and tests: it turns each IncomingMessage into a web Request, calls
// handle, and writes the Response back. Without DATABASE_URL and S3_BUCKET it keeps everything in memory.
//   node cloud/src/server.mjs        (PORT, HOST, PUBLIC_URL, MIN_CLI_VERSION, S3_*; prints a project key when in memory)
import http from "node:http";
import { pathToFileURL } from "node:url";
import { handle } from "./api.mjs";
import { memoryDb } from "./db/memory.mjs";
import { memoryStorage, STORAGE_PATH } from "./storage/memory.mjs";
import { s3FromEnv } from "./storage/s3.mjs";

/**
 * A web stream of a request's body, read only as fast as the handler reads it. Cancelling it (api.mjs does, past
 * 8 MB) stops reading but leaves the socket open, so the 413 can still be sent; Readable.toWeb would destroy it.
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
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : bodyStream(req);
  return new Request(new URL(req.url, origin), { method: req.method, headers, body, duplex: "half" });
}

/** Write a web Response to a node ServerResponse. */
export async function send(res, response, req = null) {
  const body = Buffer.from(await response.arrayBuffer());
  const headers = Object.fromEntries(response.headers);
  // A body the handler did not read to the end (refused, or over the limit) is not drained: the connection closes.
  if (req && !req.complete) headers.connection = "close";
  res.writeHead(response.status, headers);
  res.end(body);
}

/** deps from the environment: memory adapters unless DATABASE_URL / S3_BUCKET say otherwise. */
export function depsFromEnv(env = process.env) {
  if (env.DATABASE_URL) throw new Error("DATABASE_URL is set, but the Postgres adapter is not written yet (week 2). Unset it to run in memory.");
  const allowUnverified = env.IMITOR_ALLOW_UNVERIFIED_UPLOADS === "1";
  if (env.S3_BUCKET && env.S3_CHECKSUMS === "off" && !allowUnverified) {
    throw new Error("S3_CHECKSUMS=off means storage keeps no SHA-256 of uploads, so complete cannot check a file's bytes against what the run declared. Turn checksums back on, or set IMITOR_ALLOW_UNVERIFIED_UPLOADS=1 to accept unverified files (unsafe).");
  }
  return {
    db: memoryDb(),
    storage: s3FromEnv(env) || memoryStorage(),
    publicUrl: env.PUBLIC_URL || null,
    minCliVersion: env.MIN_CLI_VERSION || null,
    allowUnverified,
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
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "the server failed to handle this request" }));
      else res.destroy();
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
  const deps = depsFromEnv();
  const server = await startServer({ port: Number(process.env.PORT || 8787), host: process.env.HOST || "127.0.0.1", deps });
  const project = await deps.db.createProject({ name: "local" });
  const key = await deps.db.createAccessKey(project.id, { name: "local" });
  console.log(`Imitor Cloud (in memory: nothing is kept after it stops) at ${server.url}`);
  console.log(`Push to it with:\n  IMITOR_CLOUD_URL=${server.url} IMITOR_TOKEN=${key.secret} npx imitor push`);
}
