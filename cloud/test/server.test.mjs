// server.mjs over a real socket: what a fetch-built Request in api.test.mjs cannot show.
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { MAX_BODY_BYTES } from "../src/api.mjs";
import { memoryDb } from "../src/db/memory.mjs";
import { startServer } from "../src/server.mjs";
import { memoryStorage } from "../src/storage/memory.mjs";

/**
 * POST `total` bytes to `url` with Transfer-Encoding: chunked (no content-length), 64 KB at a time, over a raw socket,
 * and resolve with the answer and how much was written before it came. A raw socket keeps reading after its own writes
 * fail: once the server answers 413 and closes, the client's next write gets EPIPE or ECONNRESET, which is expected
 * (an http.request would report that error and could lose the answer it already received).
 */
function postChunked(url, headers, total) {
  const { hostname, port, pathname } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname);
    const received = [];
    let written = 0;
    let answeredAt = null;
    socket.on("data", (c) => {
      received.push(c);
      if (answeredAt == null) answeredAt = written;
    });
    socket.on("error", (error) => {
      if (!["EPIPE", "ECONNRESET"].includes(error.code)) reject(error);
    });
    socket.on("close", () => {
      try {
        resolve({ ...parseResponse(Buffer.concat(received)), written: answeredAt ?? written });
      } catch (error) {
        reject(error);
      }
    });
    const head = [`POST ${pathname} HTTP/1.1`, `host: ${hostname}:${port}`, "transfer-encoding: chunked", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n");
    socket.write(head);
    const piece = (data) => Buffer.concat([Buffer.from(`${data.length.toString(16)}\r\n`), data, Buffer.from("\r\n")]);
    const chunk = piece(Buffer.alloc(64 * 1024, " "));
    socket.write(piece(Buffer.from("{"))); // the start of a JSON body that never ends in time
    const pump = () => {
      while (answeredAt == null && !socket.destroyed && written < total) {
        written += 64 * 1024;
        if (!socket.write(chunk)) return socket.once("drain", pump);
      }
      if (answeredAt == null && !socket.destroyed && written >= total) socket.end("0\r\n\r\n");
    };
    pump();
  });
}

/** Status, lower-cased headers and the JSON body of a raw HTTP/1.1 response (content-length or chunked). */
function parseResponse(raw) {
  const split = raw.indexOf("\r\n\r\n");
  if (split < 0) throw new Error(`no complete HTTP response in ${raw.length} bytes`);
  const [statusLine, ...lines] = raw.subarray(0, split).toString().split("\r\n");
  const headers = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(":")).trim().toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
  let body = raw.subarray(split + 4);
  if (/chunked/i.test(headers["transfer-encoding"] || "")) {
    const parts = [];
    for (let i = 0; ;) {
      const eol = body.indexOf("\r\n", i);
      const size = parseInt(body.subarray(i, eol).toString(), 16);
      if (!size) break;
      parts.push(body.subarray(eol + 2, eol + 2 + size));
      i = eol + 2 + size + 2;
    }
    body = Buffer.concat(parts);
  } else if (headers["content-length"]) body = body.subarray(0, Number(headers["content-length"]));
  return { status: Number(statusLine.split(" ")[1]), headers, body: JSON.parse(body.toString() || "null") };
}

test("a chunked body without a content-length is cut off at 4 MB with 413, through server.mjs", async (t) => {
  const deps = { db: memoryDb(), storage: memoryStorage(), log: () => {} };
  const server = await startServer({ port: 0, deps });
  t.after(() => server.close());
  const project = await deps.db.createProject({ name: "fernwood" });
  const key = await deps.db.createAccessKey(project.id);
  const auth = { authorization: `Bearer ${key.secret}`, "content-type": "application/json" };

  const res = await postChunked(`${server.url}/v1/runs`, auth, 64 * 1024 * 1024);
  assert.equal(res.status, 413);
  assert.match(res.body.error, /the body is larger than 4 MB/);
  assert.ok(res.written < 3 * MAX_BODY_BYTES, `the server answered after ${res.written} bytes, not at the end of 64 MB`);
  assert.equal(res.headers.connection, "close", "the rest of the body is not read");
  assert.deepEqual(await deps.db.listRuns(project.id), []);

  // Under the limit, chunked is fine: a body of spaces is just not JSON.
  const small = await postChunked(`${server.url}/v1/runs`, auth, 1024 * 1024);
  assert.equal(small.status, 400);
  assert.equal(small.body.error, "the body must be JSON");
});
