import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { checkUpload, MAX_FILE_BYTES, pathProblem } from "../src/upload.mjs";
import { validate } from "./jsonschema.mjs";

const SCHEMA = JSON.parse(fs.readFileSync(new URL("../src/schema/run-upload.v1.json", import.meta.url), "utf8"));
const SHA = "a".repeat(64);
const file = (path, contentType = "image/png", size = 1200) => ({ path, size, sha256: SHA, contentType });

function body(patch = {}) {
  return {
    clientRunId: "20261110T090000-abc1234",
    schemaVersion: 1,
    run: { schemaVersion: 1, id: "20261110T090000-abc1234", status: "passed", startedAt: "2026-11-10T09:00:00.000Z", flows: [] },
    manifest: { app: "fernwood", shots: [], problems: [] },
    files: [file("screens/first-run-01-welcome-iphone-16-light.png"), file("screens/clip.webm", "video/webm"), file("screens/a photo.jpeg", "image/jpeg")],
    ...patch,
  };
}

test("the schema is valid JSON Schema 2020-12 for what it uses, and a good body passes both checks", () => {
  assert.equal(SCHEMA.$schema, "https://json-schema.org/draft/2020-12/schema");
  for (const good of [body(), body({ captures: [{ kind: "screenshot", file: "captures/x.png" }], activity: [{ tool: "imitor_screenshot" }] }), body({ files: [] })]) {
    assert.deepEqual(validate(SCHEMA, good), []);
    assert.equal(checkUpload(good), null);
  }
});

test("the schema and checkUpload refuse the same bad bodies", () => {
  const bad = {
    "not an object": [],
    "extra field": body({ projectId: "prj_other" }),
    "bad client id": body({ clientRunId: "../x" }),
    "newer schema": body({ schemaVersion: 2 }),
    "no manifest": body({ manifest: undefined }),
    "svg file": body({ files: [file("screens/x.svg", "image/svg+xml")] }),
    "html file": body({ files: [file("screens/index.html", "text/html")] }),
    "javascript as png": body({ files: [file("screens/x.js", "image/png")] }),
    "dot dot": body({ files: [file("screens/../../x.png")] }),
    "leading dot dot": body({ files: [file("../x.png")] }),
    "absolute": body({ files: [file("/etc/x.png")] }),
    "backslash": body({ files: [file("screens\\x.png")] }),
    "empty folder": body({ files: [file("screens//x.png")] }),
    "too large": body({ files: [file("screens/x.png", "image/png", MAX_FILE_BYTES + 1)] }),
    "negative size": body({ files: [file("screens/x.png", "image/png", -1)] }),
    "bad sha": body({ files: [{ ...file("screens/x.png"), sha256: "XYZ" }] }),
    "extra file field": body({ files: [{ ...file("screens/x.png"), key: "other-project/x.png" }] }),
    "captures not objects": body({ captures: ["x"] }),
  };
  if (bad["no manifest"]) delete bad["no manifest"].manifest;
  for (const [name, b] of Object.entries(bad)) {
    assert.ok(validate(SCHEMA, b).length > 0, `schema accepted: ${name}`);
    assert.equal(typeof checkUpload(b), "string", `checkUpload accepted: ${name}`);
  }
});

test("checkUpload also enforces what the schema cannot say", () => {
  const big = Array.from({ length: 13 }, (_, i) => file(`screens/${i}.webm`, "video/webm", MAX_FILE_BYTES));
  assert.match(checkUpload(body({ files: big })), /the run is 325 MB; the limit is 300 MB per run/);
  assert.match(checkUpload(body({ files: [file("screens/x.png"), file("screens/x.png")] })), /listed twice/);
  assert.match(checkUpload(body({ files: [file("screens/x.png", "image/jpeg")] })), /does not match its extension/);
  assert.match(checkUpload(body({ clientRunId: "20261110T090000-other" })), /run.id must equal clientRunId/);
  assert.match(checkUpload(body({ schemaVersion: 2 })), /schemaVersion 2 is newer/);
  assert.match(checkUpload(body({ files: [file("screens/x.svg", "image/svg+xml")] })), /must end in .png, .jpg, .jpeg, .webm, .json/);
});

test("pathProblem explains each refused path in plain words", () => {
  assert.equal(pathProblem("screens/first-run-01-welcome-iphone-16-light.png"), null);
  assert.equal(pathProblem("screens/überblick (1).png"), null);
  assert.match(pathProblem("/x.png"), /relative/);
  assert.match(pathProblem("C:/x.png"), /relative/);
  assert.match(pathProblem("a/../x.png"), /"\.\."/);
  assert.match(pathProblem("a/x.PNG"), /must end in/);
  assert.match(pathProblem("a/x.png\u0000.png"), /letters, digits/);
});
