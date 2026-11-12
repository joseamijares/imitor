import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { detectPackageManager, diff, ignores, init, inspectPackage, wrapMetroConfig } from "../src/init.mjs";
import { createServer } from "../src/mcp.mjs";

const BIN = fileURLToPath(new URL("../bin/imitor.mjs", import.meta.url));

// An invented Expo app ("fernwood", a plant-care app) with whatever files a test needs.
function app(files = {}, pkg = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-init-"));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write("package.json", JSON.stringify({ name: "fernwood", dependencies: { expo: "~54.0.0", "react-native": "0.81.5", "react-native-web": "~0.21.0", "react-dom": "19.1.0", ...pkg.dependencies }, ...(pkg.extra || {}) }, null, 2));
  write("app.json", JSON.stringify({ expo: { name: "Fernwood", userInterfaceStyle: "automatic", orientation: "portrait" } }));
  write(".gitignore", "node_modules/\n.expo/\ndist/\n");
  for (const [rel, text] of Object.entries(files)) if (text !== null) write(rel, text);
  for (const [rel, text] of Object.entries(files)) if (text === null) fs.rmSync(path.join(root, rel), { force: true });
  return root;
}
const snapshot = (root) => {
  const all = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else all[path.relative(root, full)] = fs.readFileSync(full, "utf8");
    }
  };
  walk(root);
  return all;
};
const cli = (root, ...args) => spawnSync(process.execPath, [BIN, "init", ...args], { cwd: root, encoding: "utf8" });

const SDK = 'const { getDefaultConfig } = require("expo/metro-config");\n';

test("wraps the common Metro shapes with a minimal edit", () => {
  const cases = [
    [`${SDK}const config = getDefaultConfig(__dirname);\nmodule.exports = config;\n`, `module.exports = require("imitor/metro").withImitor(config);\n`],
    [`${SDK}module.exports = getDefaultConfig(__dirname);\n`, `module.exports = require("imitor/metro").withImitor(getDefaultConfig(__dirname));\n`],
    [`${SDK}const config = getDefaultConfig(__dirname);\nmodule.exports = withLeafTransformer(config, {\n  strict: true,\n});\n`, `module.exports = require("imitor/metro").withImitor(withLeafTransformer(config, {\n  strict: true,\n}));\n`],
    [`${SDK}const config = getDefaultConfig(__dirname)\nmodule.exports = config // no semicolons here\n`, `module.exports = require("imitor/metro").withImitor(config) // no semicolons here\n`],
    [`${SDK}// module.exports = old;\nconst s = "module.exports = nope";\nmodule.exports = wrap.sentry(config);`, `module.exports = require("imitor/metro").withImitor(wrap.sentry(config));`],
  ];
  for (const [src, tail] of cases) {
    const { text, reason } = wrapMetroConfig(src);
    assert.equal(reason, undefined, src);
    assert.ok(text.endsWith(tail), `${text}\n--- expected to end with ---\n${tail}`);
    // Only the export changed.
    assert.equal(text.slice(0, text.indexOf("module.exports = require")), src.slice(0, src.lastIndexOf("module.exports =")));
    assert.equal(wrapMetroConfig(text).already, true);
  }
});

test("refuses Metro shapes it does not recognise", () => {
  for (const src of [
    `module.exports = { resolver: {} };\n`,
    `module.exports = (async () => getDefaultConfig(__dirname))();\n`,
    `module.exports = config;\nmodule.exports = other;\n`,
    `const config = 1;\n`,
    `import { getDefaultConfig } from "expo/metro-config";\nexport default getDefaultConfig(".");\n`,
  ]) assert.ok(wrapMetroConfig(src).reason, src);
});

test("init sets a plain Expo app up, then a second run changes nothing", () => {
  const root = app({ "metro.config.js": `${SDK}const config = getDefaultConfig(__dirname);\n\nmodule.exports = config;\n`, "package-lock.json": "{}" });
  const first = cli(root);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const metro = fs.readFileSync(path.join(root, "metro.config.js"), "utf8");
  assert.match(metro, /module\.exports = require\("imitor\/metro"\)\.withImitor\(config\);/);
  const config = JSON.parse(fs.readFileSync(path.join(root, "imitor.config.json"), "utf8"));
  assert.deepEqual(config, { shims: {}, devices: ["iphone-16"], schemes: ["light", "dark"], flows: [{ name: "home", start: "/", steps: [{ shot: "home" }] }] });
  assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /\n# Imitor output\npreview\/\n$/);
  assert.match(first.stdout, /npm i -D imitor playwright/);
  assert.match(first.stdout, /npx imitor app/);
  assert.match(first.stdout, /claude mcp add imitor -- npx imitor mcp/);
  assert.match(first.stdout, /"tap": "Continue"/);

  const before = snapshot(root);
  const second = cli(root, "--yes");
  assert.equal(second.status, 0, second.stdout);
  assert.deepEqual(snapshot(root), before);
  assert.match(second.stdout, /already uses withImitor/);
  assert.doesNotMatch(second.stdout, /Changed:/);
});

test("creates a wrapped Metro config when there is none (.cjs for an ES module package)", () => {
  const root = app();
  init(root);
  assert.match(fs.readFileSync(path.join(root, "metro.config.js"), "utf8"), /getDefaultConfig\(__dirname\);[\s\S]*withImitor\(config\)/);
  const esm = app({}, { extra: { type: "module" } });
  init(esm);
  assert.ok(fs.existsSync(path.join(esm, "metro.config.cjs")));
  assert.ok(!fs.existsSync(path.join(esm, "metro.config.js")));
});

test("leaves an unrecognised or ES module Metro config alone and says how to wrap it", () => {
  for (const [file, src] of [["metro.config.js", "module.exports = { resolver: {} };\n"], ["metro.config.mjs", "export default {};\n"], ["metro.config.ts", "export default {};\n"]]) {
    const root = app({ [file]: src });
    const r = init(root);
    assert.equal(fs.readFileSync(path.join(root, file), "utf8"), src);
    assert.equal(r.manual.length, 1);
    assert.match(r.manual[0].how, /withImitor\(config\)/);
    assert.ok(fs.existsSync(path.join(root, "imitor.config.json")), "the rest still applies");
  }
});

test("stops on an existing, different imitor.config.json unless --force", () => {
  const mine = JSON.stringify({ flows: [{ name: "mine", start: "/", steps: [{ shot: "x" }] }] }, null, 2) + "\n";
  const root = app({ "imitor.config.json": mine, "metro.config.js": `${SDK}module.exports = getDefaultConfig(__dirname);\n` });
  const before = snapshot(root);
  const r = cli(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /already exists and differs/);
  assert.match(r.stdout, /-  "flows": \[|\+  "shims": \{\}/);
  assert.deepEqual(snapshot(root), before, "nothing written");
  const forced = cli(root, "--force");
  assert.equal(forced.status, 0, forced.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "imitor.config.json"), "utf8")).flows[0].name, "home");
});

test("with the fingerprint policy it does not touch .gitignore and uses an ignored folder", () => {
  for (const extra of [{ "app.json": JSON.stringify({ expo: { name: "Fernwood", userInterfaceStyle: "light", runtimeVersion: { policy: "fingerprint" } } }) }, { "fingerprint.config.js": "module.exports = {};\n" }]) {
    const root = app({ ...extra, ".easignore": "node_modules/\ndist/\n", "eslint.config.js": 'const { globalIgnores } = require("eslint/config");\nmodule.exports = [globalIgnores(["coverage/*"])];\n' });
    const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    const r = init(root);
    assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), gitignore);
    assert.equal(fs.readFileSync(path.join(root, ".easignore"), "utf8"), "node_modules/\ndist/\n");
    const config = JSON.parse(fs.readFileSync(path.join(root, "imitor.config.json"), "utf8"));
    assert.equal(config.out, "dist/imitor");
    assert.ok(r.notes.some((n) => /fingerprint/.test(n) && /dist\/imitor/.test(n)));
    assert.ok(r.notes.some((n) => /eslint\.config\.js does not ignore dist\/imitor/.test(n)));
  }
  // A light-only app gets one scheme.
  const light = app({ "app.json": JSON.stringify({ expo: { userInterfaceStyle: "light" } }) });
  assert.deepEqual(init(light, { dryRun: true }).config.schemes, ["light"]);
});

test("without fingerprint it adds the output folder to .gitignore and .easignore", () => {
  const root = app({ ".easignore": "node_modules/" });
  init(root);
  assert.equal(fs.readFileSync(path.join(root, ".easignore"), "utf8"), "node_modules/\n\n# Imitor output\npreview/\n");
  const ignored = app({ ".gitignore": "/preview\n" });
  const r = init(ignored);
  assert.equal(fs.readFileSync(path.join(ignored, ".gitignore"), "utf8"), "/preview\n");
  assert.ok(r.unchanged.some((u) => /already ignores/.test(u)));
});

test("ignore-file matching", () => {
  assert.ok(ignores("dist/\n", "dist/imitor"));
  assert.ok(ignores("/dist\n", "dist/imitor"));
  assert.ok(ignores("dist/*\n", "dist/imitor"));
  assert.ok(ignores("build\n", "packages/build"));
  assert.ok(!ignores("dist/\n!dist/imitor\n", "dist/imitor"));
  assert.ok(!ignores("distribution/\n", "dist/imitor"));
  assert.ok(!ignores("/a/dist\n", "dist/imitor"));
});

test("detects the package manager from the lockfile", () => {
  const pm = (files, extra) => detectPackageManager(app(files, { extra }));
  assert.equal(pm({}), "npm");
  assert.equal(pm({ "package-lock.json": "{}" }), "npm");
  assert.equal(pm({ "yarn.lock": "" }), "yarn");
  assert.equal(pm({ "pnpm-lock.yaml": "" }), "pnpm");
  assert.equal(pm({ "bun.lock": "" }), "bun");
  assert.equal(pm({ "bun.lockb": "" }), "bun");
  assert.equal(pm({}, { packageManager: "pnpm@9.0.0" }), "pnpm");
  const r = init(app({ "yarn.lock": "" }), { dryRun: true });
  assert.equal(r.install.install, "yarn add -D imitor playwright");
  assert.equal(init(app({ "pnpm-lock.yaml": "" }, { dependencies: { imitor: "0.1.0" } }), { dryRun: true }).install.install, "pnpm add -D playwright");
});

test("--dry-run prints every change and writes nothing", () => {
  const root = app({ "metro.config.js": `${SDK}const config = getDefaultConfig(__dirname);\nmodule.exports = config;\n`, ".easignore": "x\n" });
  const before = snapshot(root);
  const r = cli(root, "--dry-run");
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(snapshot(root), before);
  for (const file of ["metro.config.js", ".gitignore", ".easignore", "imitor.config.json"]) assert.match(r.stdout, new RegExp(`\\+\\+\\+ b/${file.replace(".", "\\.")}`));
  assert.match(r.stdout, /-module\.exports = config;\n\+module\.exports = require\("imitor\/metro"\)\.withImitor\(config\);/);
  assert.match(r.stdout, /Dry run: nothing was written/);
});

test("refuses a bare React Native app and a folder that is not an app", () => {
  const bare = app({ "package.json": JSON.stringify({ name: "x", dependencies: { "react-native": "0.81.5" } }) });
  const r = cli(bare);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /without Expo/);
  assert.deepEqual(Object.keys(snapshot(bare)).sort(), ["package.json", "app.json", ".gitignore"].sort());
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-init-"));
  assert.match(cli(empty).stdout, /no package\.json/);
});

test("proposes stand-ins from the table and flags unknown native packages", () => {
  const nm = {
    // Invented packages, shaped like real ones.
    "node_modules/leaf-sensor/package.json": JSON.stringify({ name: "leaf-sensor", main: "index.js" }),
    "node_modules/leaf-sensor/index.js": 'import { requireNativeModule } from "expo";\nexport default requireNativeModule("LeafSensor");\n',
    "node_modules/leaf-sensor/ios/LeafSensor.swift": "",
    "node_modules/leaf-web/package.json": JSON.stringify({ name: "leaf-web" }),
    "node_modules/leaf-web/index.web.js": "",
    "node_modules/leaf-web/android/build.gradle": "",
    "node_modules/leaf-split/package.json": JSON.stringify({ name: "leaf-split" }),
    "node_modules/leaf-split/Thing.native.js": "",
    "node_modules/leaf-split/Thing.js": "",
    "node_modules/leaf-split/ios/x.m": "",
    "node_modules/leaf-pure/package.json": JSON.stringify({ name: "leaf-pure" }),
    "node_modules/leaf-pure/index.js": "",
    "modules/soil-probe/expo-module.config.json": JSON.stringify({ platforms: ["apple"] }),
    "modules/soil-probe/index.ts": 'import { requireNativeModule } from "expo";\nexport default requireNativeModule("SoilProbe");\n',
    "modules/soil-probe/ios/x.swift": "",
    "modules/rain-gauge/expo-module.config.json": JSON.stringify({ platforms: ["apple"] }),
    "modules/rain-gauge/index.ts": 'let m = null;\ntry {\n  m = requireNativeModule("RainGauge");\n} catch {}\nexport default m;\n',
    "modules/rain-gauge/ios/x.swift": "",
  };
  const root = app(nm, { dependencies: { "expo-sqlite": "~16.0.0", "@shopify/react-native-skia": "2.2.12", "expo-haptics": "~15.0.0", "leaf-sensor": "1.0.0", "leaf-web": "1.0.0", "leaf-split": "1.0.0", "leaf-pure": "1.0.0", "leaf-missing": "1.0.0" } });
  const r = init(root, { dryRun: true });
  assert.deepEqual(r.config.shims, { "@shopify/react-native-skia": "skia", "expo-sqlite": "sqljs" });
  assert.deepEqual(r.standIns.mayNeed.map((m) => m.package), ["leaf-sensor", "soil-probe"]);
  assert.match(r.standIns.mayNeed[0].why, /requireNativeModule in index\.js/);
  assert.ok(r.standIns.noneNeeded.includes("expo-haptics"));
  assert.ok(r.standIns.noneNeeded.some((n) => n.startsWith("rain-gauge")));
  assert.deepEqual(r.standIns.notInstalled, ["leaf-missing"]);
  assert.equal(inspectPackage(path.join(root, "node_modules/leaf-split")).webSignal, "Thing.js next to Thing.native.js");
});

test("every stand-in in the table is one Imitor has", () => {
  const table = JSON.parse(fs.readFileSync(new URL("../src/standins.json", import.meta.url), "utf8")).packages;
  for (const [name, entry] of Object.entries(table)) {
    assert.ok(["sqljs", "skia", "inert", "none"].includes(entry.kind), name);
    assert.ok(entry.why && entry.checked, name);
  }
});

test("an app.config.js that cannot be evaluated falls back to app.json", () => {
  const root = app({ "app.config.js": "module.exports = ({ config }) => ({ ...config, runtimeVersion: { policy: 'fingerprint' } });\n" });
  const r = init(root, { dryRun: true });
  assert.ok(r.notes.some((n) => /could not evaluate app\.config\.js/.test(n)));
  assert.equal(r.app.name, "Fernwood");
  assert.equal(r.config.out, "dist/imitor", "the fingerprint policy is still found in the file's text");
});

test("diff shows a new file and an edit", () => {
  assert.equal(diff("a.txt", null, "x\n"), "--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,1 @@\n+x");
  assert.equal(diff("a.txt", "1\n2\n3\n", "1\n2\n3\n"), "");
  assert.match(diff("a.txt", "1\n2\n3\n", "1\nTWO\n3\n"), /@@ -1,3 \+1,3 @@\n 1\n-2\n\+TWO\n 3/);
});

test("the imitor_init MCP tool plans by default and writes with dryRun false", async () => {
  const root = app();
  const server = createServer(root);
  const call = (args) => server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "imitor_init", arguments: args } });
  const before = snapshot(root);
  const planned = await call({});
  assert.ok(!planned.result.isError);
  assert.match(planned.result.content[0].text, /Would change/);
  assert.deepEqual(JSON.parse(planned.result.content[1].text).changes.sort(), [".gitignore", "imitor.config.json", "metro.config.js"]);
  assert.deepEqual(snapshot(root), before, "a dry run writes nothing, not even the activity log");
  const done = await call({ dryRun: false });
  assert.match(done.result.content[0].text, /Changed:/);
  assert.ok(fs.existsSync(path.join(root, "imitor.config.json")));
  assert.match(fs.readFileSync(path.join(root, "preview", "activity.jsonl"), "utf8"), /set up Imitor/);
  server.close();
});
