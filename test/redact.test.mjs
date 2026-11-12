import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { BLANK, fillValues, redact } from "../src/redact.mjs";
import { recordRun } from "../src/store.mjs";
import { checkUpload } from "../src/upload.mjs";

const PASSWORD = "correct-horse-battery-staple";

test("redact blanks fill values in steps and stepConfig, anywhere in the value, without changing the original", () => {
  const manifest = {
    shots: [],
    problems: [
      { kind: "flow-failed", step: 3, stepConfig: { fill: { placeholder: "Password", value: PASSWORD } }, file: "screens/sign-in-FAILED-iphone-16-light.png" },
    ],
  };
  const steps = [{ fill: { label: "Email", value: "ada@example.com" } }, { tap: "Sign in" }, { fill: { testId: "pin", value: 1234 } }];
  const original = JSON.stringify({ manifest, steps });
  const red = redact({ manifest, steps });
  assert.equal(JSON.stringify({ manifest, steps }), original, "the input is not changed");
  assert.deepEqual(red.manifest.problems[0].stepConfig, { fill: { placeholder: "Password", value: BLANK } });
  assert.deepEqual(red.steps, [{ fill: { label: "Email", value: BLANK } }, { tap: "Sign in" }, { fill: { testId: "pin", value: BLANK } }]);
  assert.equal(red.manifest.problems[0].file, "screens/sign-in-FAILED-iphone-16-light.png");
  assert.deepEqual([...fillValues({ manifest, steps })], [PASSWORD, "ada@example.com", "1234"]);
});

test("redact blanks typed values and passed secrets inside free text, but not in paths and names", () => {
  const value = {
    problems: [{ kind: "page-error", message: `TypeError: cannot read "${PASSWORD}"`, flow: "sign-in", file: "screens/sign-in-01-hunter2x-iphone-16-light.png" }],
    shots: [{ route: "/search?q=hunter2x", shot: "01-hunter2x" }],
    activity: [{ text: "took a screenshot of /search?q=hunter2x on iphone-16", tool: "imitor_screenshot" }],
  };
  const red = redact(value, { secrets: [PASSWORD, "hunter2x", "on"] });
  assert.equal(red.problems[0].message, `TypeError: cannot read "${BLANK}"`);
  assert.equal(red.shots[0].route, `/search?q=${BLANK}`);
  assert.equal(red.activity[0].text, `took a screenshot of /search?q=${BLANK} on iphone-16`, 'a two-letter secret ("on") is too short to blank');
  assert.equal(red.problems[0].file, value.problems[0].file, "file paths still match the uploaded files");
  assert.equal(red.shots[0].shot, "01-hunter2x");
});

test("a password typed in a flow never appears in the redacted upload body", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-redact-"));
  const config = {
    devices: ["iphone-16"],
    schemes: ["light"],
    flows: [{ name: "sign-in", start: "/", steps: [{ shot: "01-form" }, { fill: { placeholder: "Email", value: "ada@fernwood.example" } }, { fill: { placeholder: "Password", value: PASSWORD } }, { tap: "Sign in" }, { shot: "02-garden" }] }],
  };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fernwood" }));
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify(config));
  const out = path.join(root, "preview");
  fs.mkdirSync(path.join(out, "screens"), { recursive: true });
  const shots = [{ file: "screens/sign-in-01-form-iphone-16-light.png", flow: "sign-in", shot: "01-form", device: "iphone-16", scheme: "light", route: "/", stubs: [] }];
  const problems = [
    { where: "sign-in / iphone-16 / light", kind: "flow-failed", message: `locator.fill: Timeout 10000ms exceeded while typing "${PASSWORD}"`, file: "screens/sign-in-FAILED-iphone-16-light.png", flow: "sign-in", device: "iphone-16", scheme: "light", step: 3, stepConfig: config.flows[0].steps[2], lastGoodShot: "screens/sign-in-01-form-iphone-16-light.png", notReached: ["02-garden"] },
    { where: "sign-in / iphone-16 / light", kind: "dialog", message: `Wrong password ${PASSWORD} for ada@fernwood.example`, flow: "sign-in", device: "iphone-16", scheme: "light", step: 3 },
  ];
  for (const f of [...shots, ...problems.filter((p) => p.file)]) fs.writeFileSync(path.join(out, f.file), "png");
  const run = recordRun(out, { root, config: loadConfig(root), manifest: { commit: null, shots, problems }, startedAt: "2026-11-10T09:00:00.000Z", by: { name: "Ada", kind: "person" }, env: {} });

  const dir = path.join(out, "runs", run.id);
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const raw = { clientRunId: run.id, schemaVersion: 1, run: read("run.json"), manifest: read("manifest.json"), files: [] };
  assert.ok(JSON.stringify(raw).includes(PASSWORD), "the run on disk holds the password (the case this guards)");

  const body = redact(raw, { secrets: [...fillValues(loadConfig(root))] });
  const text = JSON.stringify(body);
  assert.ok(!text.includes(PASSWORD), text);
  assert.ok(!text.includes("ada@fernwood.example"), text);
  assert.equal(body.manifest.problems[0].stepConfig.fill.value, BLANK);
  assert.equal(body.manifest.problems[0].stepConfig.fill.placeholder, "Password");
  assert.equal(checkUpload(body), null);
});
