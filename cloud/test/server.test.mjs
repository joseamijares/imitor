// server.mjs over a real socket: what a fetch-built Request in api.test.mjs cannot show.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { MAX_BODY_BYTES } from "../src/api.mjs";
import { memoryDb } from "../src/db/memory.mjs";
import { LINGER_MS, startServer } from "../src/server.mjs";
import { memoryStorage } from "../src/storage/memory.mjs";

/**
 * POST `total` bytes to `url` with Transfer-Encoding: chunked (no content-length), 64 KB at a time, and resolve with
 * the answer and how much was written before it came. Writing stops once the answer is in or the socket is gone.
 */
function postChunked(url, headers, total) {
  return new Promise((resolve, reject) => {
    let written = 0;
    let answered = false;
    const req = http.request(url, { method: "POST", headers: { ...headers, "transfer-encoding": "chunked" } }, (res) => {
      answered = true;
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(parts).toString() || "null"), written }));
    });
    req.on("error", (error) => !answered && reject(error));
    const chunk = Buffer.alloc(64 * 1024, " ");
    const pump = () => {
      while (!answered && !req.destroyed && written < total) {
        written += chunk.length;
        if (!req.write(chunk)) return req.once("drain", pump);
      }
      if (written >= total && !req.writableEnded) req.end();
    };
    req.write("{"); // the start of a JSON body that never ends in time
    pump();
  });
}

test("a chunked body without a content-length is cut off at 8 MB with 413, through server.mjs", async (t) => {
  const deps = { db: memoryDb(), storage: memoryStorage(), log: () => {} };
  const server = await startServer({ port: 0, deps });
  t.after(() => server.close());
  const project = await deps.db.createProject({ name: "fernwood" });
  const key = await deps.db.createAccessKey(project.id);
  const auth = { authorization: `Bearer ${key.secret}`, "content-type": "application/json" };

  const res = await postChunked(`${server.url}/v1/runs`, auth, 64 * 1024 * 1024);
  assert.equal(res.status, 413);
  assert.match(res.body.error, /the body is larger than 8 MB/);
  assert.ok(res.written < 3 * MAX_BODY_BYTES, `the server answered after ${res.written} bytes, not at the end of 64 MB`);
  assert.equal(res.headers.connection, "close", "the rest of the body is not read");
  assert.deepEqual(await deps.db.listRuns(project.id), []);

  // Under the limit, chunked is fine: a body of spaces is just not JSON.
  const small = await postChunked(`${server.url}/v1/runs`, auth, 1024 * 1024);
  assert.equal(small.status, 400);
  assert.equal(small.body.error, "the body must be JSON");
});

/**
 * Over a raw socket: send a chunked body to /v1/runs 64 KB at a time until `stopAfter` bytes (or forever), read nothing
 * for `readAfterMs`, then resolve with what was received and when the connection closed.
 */
function rawChunked(server, secret, { stopAfter = Infinity, readAfterMs = 0 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect(server.port, "127.0.0.1");
    let data = "";
    socket.pause();
    socket.on("data", (c) => (data += c));
    socket.on("error", () => {});
    socket.on("close", () => resolve({ data, closedAfterMs: Date.now() - started }));
    socket.write(`POST /v1/runs HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${secret}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`);
    const chunk = Buffer.alloc(64 * 1024, " ");
    const frame = Buffer.concat([Buffer.from(`${chunk.length.toString(16)}\r\n`), chunk, Buffer.from("\r\n")]);
    let sent = 0;
    const pump = () => {
      while (!socket.destroyed && !socket.writableEnded && sent < stopAfter) {
        sent += chunk.length;
        if (!socket.write(frame)) return socket.once("drain", pump);
      }
    };
    pump();
    setTimeout(() => socket.resume(), readAfterMs);
  });
}

test("a client still sending an oversized body gets the 413, even when it reads the answer late", async (t) => {
  const deps = { db: memoryDb(), storage: memoryStorage(), log: () => {} };
  const server = await startServer({ port: 0, deps });
  t.after(() => server.close());
  const project = await deps.db.createProject({ name: "fernwood" });
  const key = await deps.db.createAccessKey(project.id);

  // Closing at once reset the connection while the body was still arriving, and the reset made the client's kernel
  // discard the unread 413: the client saw only ECONNRESET or EPIPE.
  for (let i = 0; i < 3; i++) {
    const res = await rawChunked(server, key.secret, { stopAfter: 32 * 1024 * 1024, readAfterMs: 300 });
    assert.match(res.data, /^HTTP\/1\.1 413 /, `attempt ${i + 1}: no 413 was received (${JSON.stringify(res.data.slice(0, 80))})`);
    assert.match(res.data, /the body is larger than 8 MB/);
  }
  assert.deepEqual(await deps.db.listRuns(project.id), []);
});

test("a client that never stops sending is dropped soon after the linger time", async (t) => {
  const deps = { db: memoryDb(), storage: memoryStorage(), log: () => {} };
  const server = await startServer({ port: 0, deps });
  t.after(() => server.close());
  const project = await deps.db.createProject({ name: "fernwood" });
  const key = await deps.db.createAccessKey(project.id);

  const res = await rawChunked(server, key.secret);
  assert.match(res.data, /^HTTP\/1\.1 413 /);
  assert.ok(res.closedAfterMs < LINGER_MS + 3000, `the connection stayed open ${res.closedAfterMs} ms`);
});
