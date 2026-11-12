// server.mjs over a real socket: what a fetch-built Request in api.test.mjs cannot show.
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { MAX_BODY_BYTES } from "../src/api.mjs";
import { memoryDb } from "../src/db/memory.mjs";
import { LINGER_MS, startServer } from "../src/server.mjs";
import { memoryStorage } from "../src/storage/memory.mjs";

/**
 * POST a chunked body (Transfer-Encoding: chunked, no content-length) to /v1/runs over a raw socket, 64 KB at a time,
 * and resolve once the connection closes with { raw, status, headers, body, written, closedAfterMs }. opts: { total
 * (bytes to send, then the closing chunk; Infinity for no end), readAfterMs (read nothing that long), stopOnAnswer
 * (stop writing once the answer arrives; false keeps sending regardless) }. A raw socket keeps reading after its own
 * writes fail: once the server answers 413 and closes, a further write gets EPIPE or ECONNRESET, which is expected
 * (an http.request would report that error and could lose the answer it already received).
 */
function rawChunked(server, headers, { total = Infinity, readAfterMs = 0, stopOnAnswer = true } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const socket = net.connect(server.port, "127.0.0.1");
    const received = [];
    let written = 0;
    let answeredAt = null;
    socket.pause();
    socket.on("data", (c) => {
      received.push(c);
      if (answeredAt == null) answeredAt = written;
    });
    socket.on("error", (error) => {
      if (!["EPIPE", "ECONNRESET"].includes(error.code)) reject(error);
    });
    socket.on("close", () => {
      const raw = Buffer.concat(received);
      let parsed = {};
      try {
        parsed = parseResponse(raw);
      } catch {} // a test asserts on raw when no complete answer came
      resolve({ raw: raw.toString(), ...parsed, written: answeredAt ?? written, closedAfterMs: Date.now() - started });
    });
    const head = ["POST /v1/runs HTTP/1.1", "host: 127.0.0.1", "transfer-encoding: chunked", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n");
    socket.write(head);
    const piece = (data) => Buffer.concat([Buffer.from(`${data.length.toString(16)}\r\n`), data, Buffer.from("\r\n")]);
    const chunk = piece(Buffer.alloc(64 * 1024, " "));
    socket.write(piece(Buffer.from("{"))); // the start of a JSON body that never ends in time
    const pump = () => {
      while (!(stopOnAnswer && answeredAt != null) && !socket.destroyed && !socket.writableEnded && written < total) {
        written += 64 * 1024;
        if (!socket.write(chunk)) return socket.once("drain", pump);
      }
      if (answeredAt == null && !socket.destroyed && !socket.writableEnded && written >= total) socket.end("0\r\n\r\n");
    };
    pump();
    setTimeout(() => socket.resume(), readAfterMs);
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

  const res = await rawChunked(server, auth, { total: 64 * 1024 * 1024 });
  assert.equal(res.status, 413);
  assert.match(res.body.error, /the body is larger than 4 MB/);
  assert.ok(res.written < 3 * MAX_BODY_BYTES, `the server answered after ${res.written} bytes, not at the end of 64 MB`);
  assert.equal(res.headers.connection, "close", "the rest of the body is not read");
  assert.deepEqual(await deps.db.listRuns(project.id), []);

  // Under the limit, chunked is fine: a body of spaces is just not JSON.
  const small = await rawChunked(server, auth, { total: 1024 * 1024 });
  assert.equal(small.status, 400);
  assert.equal(small.body.error, "the body must be JSON");
});

test("a client still sending an oversized body gets the 413, even when it reads the answer late", async (t) => {
  const deps = { db: memoryDb(), storage: memoryStorage(), log: () => {} };
  const server = await startServer({ port: 0, deps });
  t.after(() => server.close());
  const project = await deps.db.createProject({ name: "fernwood" });
  const key = await deps.db.createAccessKey(project.id);
  const auth = { authorization: `Bearer ${key.secret}`, "content-type": "application/json" };

  // Closing at once reset the connection while the body was still arriving, and the reset made the client's kernel
  // discard the unread 413: the client saw only ECONNRESET or EPIPE.
  for (let i = 0; i < 3; i++) {
    const res = await rawChunked(server, auth, { total: 32 * 1024 * 1024, readAfterMs: 300, stopOnAnswer: false });
    assert.equal(res.status, 413, `attempt ${i + 1}: no 413 was received (${JSON.stringify(res.raw.slice(0, 80))})`);
    assert.match(res.body.error, /the body is larger than 4 MB/);
  }
  assert.deepEqual(await deps.db.listRuns(project.id), []);
});

test("a client that never stops sending is dropped soon after the linger time", async (t) => {
  const deps = { db: memoryDb(), storage: memoryStorage(), log: () => {} };
  const server = await startServer({ port: 0, deps });
  t.after(() => server.close());
  const project = await deps.db.createProject({ name: "fernwood" });
  const key = await deps.db.createAccessKey(project.id);
  const auth = { authorization: `Bearer ${key.secret}`, "content-type": "application/json" };

  const res = await rawChunked(server, auth, { stopOnAnswer: false });
  assert.equal(res.status, 413);
  assert.ok(res.closedAfterMs < LINGER_MS + 3000, `the connection stayed open ${res.closedAfterMs} ms`);
});
