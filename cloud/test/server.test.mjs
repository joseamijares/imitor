// server.mjs over a real socket: what a fetch-built Request in api.test.mjs cannot show.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { MAX_BODY_BYTES } from "../src/api.mjs";
import { memoryDb } from "../src/db/memory.mjs";
import { startServer } from "../src/server.mjs";
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
