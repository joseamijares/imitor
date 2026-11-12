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
  const files = [...new Set([...shots, ...problems].map((f) => f.file).filter(Boolean))].map((p) => ({ path: p, size: 3, sha256: "a".repeat(64), contentType: "image/png" }));
  const raw = { clientRunId: run.id, schemaVersion: 1, run: read("run.json"), manifest: read("manifest.json"), files };
  assert.ok(JSON.stringify(raw).includes(PASSWORD), "the run on disk holds the password (the case this guards)");

  const body = redact(raw, { secrets: [...fillValues(loadConfig(root))] });
  const text = JSON.stringify(body);
  assert.ok(!text.includes(PASSWORD), text);
  assert.ok(!text.includes("ada@fernwood.example"), text);
  assert.equal(body.manifest.problems[0].stepConfig.fill.value, BLANK);
  assert.equal(body.manifest.problems[0].stepConfig.fill.placeholder, "Password");
  assert.equal(checkUpload(body), null);
});

test("a password in any free text is blanked: an after-step failure's error, a locator error, state, url, activity", () => {
  // What src/shoot.mjs writes when a fill step without a locator fails inside a flow this one runs after: locate()
  // throws `cannot locate {"value":"..."}`, kept in both message and error.
  const thrown = `cannot locate ${JSON.stringify({ value: PASSWORD })}`;
  const quoted = 'say "hi" \\ there';
  const manifest = {
    shots: [{ file: "screens/home-01-feed-iphone-16-light.png", flow: "home", shot: "01-feed", device: "iphone-16", scheme: "light", route: "/feed", stubs: ["camera"], state: `signed-in-as-${PASSWORD}` }],
    problems: [
      { where: "home / iphone-16 / light", kind: "flow-failed", message: `in "sign-in", which this flow runs after, step 2: ${thrown}`, error: thrown, file: "screens/home-FAILED-iphone-16-light.png", flow: "home", device: "iphone-16", scheme: "light", step: 0, stepConfig: { fill: { value: PASSWORD } }, after: { flow: "sign-in", step: 2 }, lastGoodShot: null, notReached: [`02-${PASSWORD}`] },
      { kind: "page-error", message: `cannot locate ${JSON.stringify({ value: quoted })}`, flow: "home" },
      { kind: "dialog", message: "pin", flow: "home", url: `https://fernwood.example/reset?token=${PASSWORD}` },
    ],
  };
  const activity = [{ at: "2026-11-10T09:00:00.000Z", tool: "imitor_run_flow", text: "ran sign-in", target: PASSWORD, note: `typed ${PASSWORD}`, ok: false }];
  const value = { manifest, activity, steps: [{ fill: { placeholder: "PIN", value: "pin" } }, { fill: { label: "Note", value: quoted } }] };
  const red = redact(value);
  const text = JSON.stringify(red);
  assert.ok(!text.includes(PASSWORD), text);
  assert.ok(!text.includes(JSON.stringify(quoted).slice(1, -1)), "a value as JSON quotes it inside an error message");
  assert.equal(red.manifest.problems[0].error, `cannot locate {"value":"${BLANK}"}`);
  assert.equal(red.manifest.problems[2].message, BLANK, "a short typed value is blanked when it is the whole text");
  assert.equal(red.manifest.shots[0].route, "/feed", "a short value is not blanked inside other text");
  // Ids, paths, names and times stay as they were, so files and records still match.
  for (const k of ["file", "flow", "device", "scheme", "shot", "stubs"]) assert.deepEqual(red.manifest.shots[0][k], manifest.shots[0][k], k);
  assert.deepEqual(red.manifest.problems[0].after, { flow: "sign-in", step: 2 });
  assert.equal(red.manifest.problems[0].where, "home / iphone-16 / light");
  assert.equal(red.activity[0].at, activity[0].at);
  assert.equal(red.activity[0].tool, "imitor_run_flow");
});

test("redact copies a value too deep to recurse into, and keeps __proto__ as a plain key", () => {
  let deep = { fill: { value: PASSWORD } };
  for (let i = 0; i < 200000; i++) deep = [deep];
  let red = redact({ deep });
  let n = 0;
  for (red = red.deep; Array.isArray(red); red = red[0]) n++;
  assert.equal(n, 200000);
  assert.deepEqual(red, { fill: { value: BLANK } });
  const odd = redact(JSON.parse(`{"__proto__":{"message":"${PASSWORD}"},"fill":{"value":"${PASSWORD}"}}`));
  assert.equal(Object.getPrototypeOf(odd), Object.prototype);
  assert.deepEqual(Object.keys(odd), ["__proto__", "fill"]);
});
