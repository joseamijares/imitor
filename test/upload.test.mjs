import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { redact } from "../src/redact.mjs";
import { checkUpload, fileRefs, MAX_BODY_BYTES, MAX_FILE_BYTES, pathProblem, sizeProblem } from "../src/upload.mjs";
import { validate } from "./jsonschema.mjs";

const SCHEMA = JSON.parse(fs.readFileSync(new URL("../src/schema/run-upload.v1.json", import.meta.url), "utf8"));
const SHA = "a".repeat(64);
const file = (path, contentType = "image/png", size = 1200) => ({ path, size, sha256: SHA, contentType });
const WELCOME = "screens/first-run-01-welcome-iphone-16-light.png";
const withRun = (patch) => {
  const b = body();
  b.run = JSON.parse(JSON.stringify({ ...b.run, ...patch }));
  return b;
};
const withManifest = (patch) => {
  const b = body();
  b.manifest = { ...b.manifest, ...patch };
  return b;
};

function body(patch = {}) {
  return {
    clientRunId: "20261110T090000-abc1234",
    schemaVersion: 1,
    run: { schemaVersion: 1, id: "20261110T090000-abc1234", status: "passed", startedAt: "2026-11-10T09:00:00.000Z", finishedAt: "2026-11-10T09:01:00.000Z", flows: [{ name: "first-run", steps: [{ index: 1, name: "01-welcome", status: "ok", shot: WELCOME }] }] },
    manifest: { app: "fernwood", shots: [{ file: WELCOME, flow: "first-run", shot: "01-welcome", stubs: [] }], problems: [] },
    files: [file(WELCOME), file("screens/clip.webm", "video/webm"), file("screens/a photo.jpeg", "image/jpeg")],
    ...patch,
  };
}

test("the schema is valid JSON Schema 2020-12 for what it uses, and a good body passes both checks", () => {
  assert.equal(SCHEMA.$schema, "https://json-schema.org/draft/2020-12/schema");
  const withCapture = body({ captures: [{ kind: "screenshot", file: "captures/x.png" }], activity: [{ at: "2026-11-10T09:00:30.000Z", tool: "imitor_screenshot" }] });
  withCapture.files.push(file("captures/x.png"));
  const empty = body({ files: [] });
  empty.run.flows = [];
  empty.manifest.shots = [];
  for (const good of [body(), withCapture, empty]) {
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
    "flow not an object": withRun({ flows: [1] }),
    "flow without steps": withRun({ flows: [{ name: "first-run" }] }),
    "shot without stubs": withManifest({ shots: [{ file: WELCOME, flow: "first-run" }] }),
    "problem not an object": withManifest({ problems: ["boom"] }),
    "no finishedAt": withRun({ finishedAt: undefined }),
    "activity without a time": body({ activity: [{ tool: "imitor_screenshot" }] }),
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

test("checkUpload refuses shapes the derivations would crash on, with a sentence instead of a throw", () => {
  assert.match(checkUpload(withRun({ flows: [1] })), /run.flows\[0\] must be an object with a list of steps/);
  assert.match(checkUpload(withRun({ flows: [{ steps: [null] }] })), /run.flows\[0\] must be an object with a list of steps/);
  assert.match(checkUpload(withManifest({ shots: [{ file: WELCOME }] })), /manifest.shots\[0\] must be an object with a file and a list of stubs/);
  assert.match(checkUpload(withManifest({ shots: [{ file: WELCOME, stubs: [{}] }] })), /manifest.shots\[0\]/);
  assert.match(checkUpload(withManifest({ problems: [null] })), /manifest.problems\[0\] must be an object/);
});

test("every file the run points at must be one of its own listed files, with a safe path", () => {
  const other = "../../prj_other/run_x/a.png";
  const failed = (patch) => withManifest({ problems: [{ kind: "flow-failed", message: "x", ...patch }] });
  assert.match(checkUpload(failed({ lastGoodShot: other })), /manifest.problems\[0\].lastGoodShot "..\/..\/prj_other\/run_x\/a.png" must not contain "\." or "\.\." folders/);
  assert.match(checkUpload(failed({ file: other })), /manifest.problems\[0\].file .*"\.\."/);
  assert.match(checkUpload(withManifest({ shots: [{ file: other, stubs: [] }] })), /manifest.shots\[0\].file .*"\.\."/);
  assert.match(checkUpload(withRun({ flows: [{ steps: [{ shot: other }] }] })), /run.flows\[0\].steps\[0\].shot .*"\.\."/);
  assert.match(checkUpload(body({ captures: [{ file: other }] })), /captures\[0\].file .*"\.\."/);
  for (const bad of ["/screens/a.png", "screens\\a.png", "screens//a.png"]) assert.match(checkUpload(failed({ file: bad })), /manifest.problems\[0\].file/, bad);
  assert.match(checkUpload(failed({ file: "screens/first-run-FAILED-iphone-16-light.png" })), /points at screens\/first-run-FAILED-iphone-16-light.png, which is not in files/);
  assert.match(checkUpload(failed({ file: 42 })), /manifest.problems\[0\].file must be a non-empty string/);
  assert.equal(checkUpload(failed({ file: null, lastGoodShot: WELCOME })), null, "no failure screenshot is fine");
});

test("fileRefs lists every file a body points at, and skips parts of the wrong shape instead of throwing", () => {
  const b = withManifest({ problems: [{ kind: "flow-failed", file: "screens/first-run-FAILED-iphone-16-light.png", lastGoodShot: WELCOME }] });
  b.captures = [{ file: "captures/x.png" }];
  assert.deepEqual(fileRefs(b).map((r) => [r.at, r.path, r.optional]), [
    ["manifest.shots[0].file", WELCOME, false],
    ["manifest.problems[0].file", "screens/first-run-FAILED-iphone-16-light.png", true],
    ["manifest.problems[0].lastGoodShot", WELCOME, true],
    ["run.flows[0].steps[0].shot", WELCOME, true],
    ["captures[0].file", "captures/x.png", true],
  ]);
  for (const odd of [null, [], {}, { run: { flows: [1, { steps: "x" }] }, manifest: { shots: {}, problems: [null] } }]) assert.deepEqual(fileRefs(odd), []);
});

test("checkUpload refuses a deeply nested or oversized body without overflowing the stack, before redaction", () => {
  let deep = [];
  for (let i = 0; i < 200000; i++) deep = [deep];
  const nested = withManifest({ extra: deep });
  assert.match(checkUpload(nested), /nested more than 64 levels deep/);
  assert.match(sizeProblem(deep), /nested more than 64 levels deep/);
  assert.doesNotThrow(() => redact(nested));
  assert.match(checkUpload(withManifest({ notes: "x".repeat(MAX_BODY_BYTES) })), /over 4 MB of JSON; the limit is 4 MB/);
  assert.equal(sizeProblem(body()), null);
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
