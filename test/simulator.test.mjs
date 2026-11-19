import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { writeReport } from "../src/report.mjs";
import { deepLink, failureLine, findDevice, firstFailed, IOS_NOT_COVERED, IOS_RENDERER, iosSettings, maestroEnv, maestroFlow, pause, pngSize, ranConfig, selector, shootIos, stepCommands } from "../src/simulator.mjs";

function project(config, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-sim-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fernwood" }));
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify(config));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body);
  return root;
}

test("selector: flow targets become Maestro selectors; css is refused with what to use", () => {
  assert.equal(selector("Continue"), "Continue");
  assert.deepEqual(selector({ testId: "save" }), { id: "save" });
  assert.deepEqual(selector({ label: "Next" }), { text: "Next" });
  assert.deepEqual(selector({ placeholder: "Your name" }), { text: "Your name" });
  assert.deepEqual(selector({ text: "Done" }), { text: "Done" });
  assert.throws(() => selector({ css: ".row" }), /only exists on the web.*testId, label, placeholder or text/);
  assert.throws(() => selector({}), /cannot locate/);
});

test("selector: values match as written, and exact: false matches text that contains it", () => {
  assert.deepEqual(selector({ testId: "row[0]" }), { id: "row\\[0\\]" });
  assert.equal(selector("Price (USD)"), "Price \\(USD\\)");
  assert.deepEqual(selector({ text: "Continue", exact: false }), { text: ".*Continue.*" });
  assert.deepEqual(selector({ text: "Total: $5.00", exact: false }), { text: ".*Total: \\$5\\.00.*" });
  assert.ok(new RegExp(`^${selector({ testId: "row[0]" }).id}$`).test("row[0]"));
});

test("ranConfig: the simulators used, and no state, seed or clock that was never applied", () => {
  const ran = ranConfig({ out: "preview", devices: [{ name: "iphone-16" }], flows: [{ name: "a", after: "b", state: "empty", seed: "seed.mjs", clock: "2026-01-01", steps: [] }] }, [{ name: "iphone-17", platform: "ios" }]);
  assert.deepEqual(ran.devices, [{ name: "iphone-17", platform: "ios" }]);
  assert.deepEqual(ran.flows, [{ name: "a", after: "b", steps: [] }]);
});

test("deepLink: a route becomes a link under the app's scheme, and says what to set without one", () => {
  assert.equal(deepLink("fernwood", "/today"), "fernwood://today");
  assert.equal(deepLink("fernwood", "/plants/3"), "fernwood://plants/3");
  assert.throws(() => deepLink(null, "/today"), /needs the app's URL scheme.*"scheme"/);
});

test("stepCommands: each kind of step", () => {
  assert.deepEqual(stepCommands({ tap: "Continue" }), [{ tapOn: "Continue" }]);
  assert.deepEqual(stepCommands({ fill: { placeholder: "Your name", value: "Ada" } }), [{ tapOn: { text: "Your name" } }, { eraseText: 200 }, { inputText: "Ada" }]);
  assert.deepEqual(stepCommands({ goto: "/today" }, { scheme: "fernwood" }), [{ openLink: "fernwood://today" }]);
  assert.deepEqual(stepCommands({ wait: 500 }), [pause(500)]);
  assert.deepEqual(stepCommands({ waitFor: { testId: "list" } }), [{ extendedWaitUntil: { visible: { id: "list" }, timeout: 15000 } }]);
  assert.deepEqual(stepCommands({ scroll: 400 }), [{ swipe: { direction: "UP" } }]);
  assert.deepEqual(stepCommands({ scroll: -400 }), [{ swipe: { direction: "DOWN" } }]);
  assert.deepEqual(stepCommands({ shot: "home" }, { shotPath: (s) => `screens/x-${s.shot}`, settleMs: 600 }), [pause(600), { waitForAnimationToEnd: { timeout: 3000 } }, { takeScreenshot: "screens/x-home" }]);
  assert.throws(() => stepCommands({ dance: true }), /unknown step/);
});

test("stepCommands: a fill from a secret is refused, and the pause never fails a flow", () => {
  assert.throws(() => stepCommands({ fill: { placeholder: "Password", value: { env: "TEST_PASSWORD" } } }), /cannot run on a simulator yet.*not masked/);
  assert.equal(pause(300).extendedWaitUntil.optional, true);
});

test("maestroFlow: launches, pauses, runs the flows it comes after without their shots, and says which step owns each command", () => {
  const root = project({
    flows: [
      { name: "welcome", steps: [{ shot: "first" }, { tap: "Continue" }] },
      { name: "name", after: "welcome", start: "/name", steps: [{ fill: { placeholder: "Your name", value: "Ada" } }, { shot: "named" }] },
    ],
  });
  const config = loadConfig(root);
  const { text, owners, commands } = maestroFlow(config, config.flows[1], { bundleId: "com.fernwood.app", scheme: "fernwood", shotPath: (s) => `screens/name-${s.shot}`, launchWaitMs: 1000 });
  assert.deepEqual(commands[0], { launchApp: { appId: "com.fernwood.app", clearState: true } });
  assert.deepEqual(commands[1], pause(1000));
  assert.equal(commands.length, owners.length);
  assert.ok(!commands.some((c) => c.takeScreenshot === "screens/name-first"), "a shot of a flow run before this one is skipped");
  const tap = commands.findIndex((c) => c.tapOn === "Continue");
  assert.equal(owners[tap].pre.flow, "welcome");
  const input = commands.findIndex((c) => c.inputText === "Ada");
  assert.deepEqual(owners[input], { index: 1 });
  assert.deepEqual(owners.at(-1), { index: 2 });
  assert.deepEqual(commands.at(-1), { takeScreenshot: "screens/name-named" });
  assert.ok(commands.some((c) => c.openLink === "fernwood://name"), "the flow's own start is opened as a link");
  assert.match(text, /^appId: "com\.fernwood\.app"\n---\n- \{"launchApp"/);
});

test("iosSettings: what the config must hold, and the defaults", () => {
  assert.throws(() => iosSettings(project({})), /--target ios needs "simulator"/);
  assert.throws(() => iosSettings(project({ simulator: { ios: {} } })), /bundleId/);
  assert.throws(() => iosSettings(project({ simulator: { ios: { bundleId: "a.b", app: "build/App.app" } } })), /build\/App\.app does not exist.*Build it for the simulator first/);
  assert.throws(() => iosSettings(project({ simulator: { ios: { bundleId: "a.b", devices: [] } } })), /list of simulator names/);
  assert.throws(() => iosSettings(project({ simulator: { ios: { bundleId: "a.b", launchWaitMs: -1 } } })), /launchWaitMs/);
  const root = project({ simulator: { ios: { bundleId: "a.b", scheme: "ab", video: true } } });
  assert.deepEqual(iosSettings(root), { bundleId: "a.b", app: null, scheme: "ab", devices: ["iPhone 17"], clearState: true, video: true, launchWaitMs: 2500 });
});

test("findDevice: by name on the newest iOS runtime, else the names that exist", () => {
  const list = {
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [{ name: "iPhone 17", udid: "OLD", state: "Shutdown" }],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-2": [{ name: "iPhone 17", udid: "NEW", state: "Booted" }, { name: "iPhone Air", udid: "AIR", state: "Shutdown" }],
      "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [{ name: "Apple Watch", udid: "W", state: "Shutdown" }],
    },
  };
  assert.deepEqual(findDevice("iPhone 17", list), { udid: "NEW", name: "iPhone 17", state: "Booted" });
  assert.throws(() => findDevice("iPhone 4", list), /no simulator named "iPhone 4"\. Available: iPhone 17, iPhone Air$/);
});

test("firstFailed: the failed command among ours, skipping Maestro's own two; -1 when none; unknown without a file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-dbg-"));
  assert.deepEqual(firstFailed(dir), { at: null, error: null });
  fs.mkdirSync(path.join(dir, "flow"));
  const entry = (name, status, error) => ({ command: { [name]: {} }, metadata: { status, ...(error ? { error: { message: error } } : {}) } });
  const file = path.join(dir, "flow", "commands.json");
  fs.writeFileSync(file, JSON.stringify([entry("defineVariablesCommand", "COMPLETED"), entry("applyConfigurationCommand", "COMPLETED"), entry("launchAppCommand", "COMPLETED"), entry("tapOnElement", "FAILED", "Element not found: Text matching regex: Save")]));
  assert.deepEqual(firstFailed(dir), { at: 1, error: "Element not found: Text matching regex: Save" });
  fs.writeFileSync(file, JSON.stringify([entry("defineVariablesCommand", "COMPLETED"), entry("launchAppCommand", "COMPLETED")]));
  assert.equal(firstFailed(dir).at, -1);
});

test("failureLine: the line that says why, not a stack frame", () => {
  assert.equal(failureLine("Running on iPhone 17\n > Flow t\nTap on \"Save\"... FAILED\n\nElement not found: Text matching regex: Save\n"), "Tap on \"Save\"... FAILED");
  assert.equal(failureLine(""), "Maestro failed without a message");
});

test("maestroEnv: analytics off; Homebrew's Java is added only when no Java is set up", () => {
  const brew = (file) => file === "/opt/homebrew/opt/openjdk@17/bin/java";
  const env = maestroEnv({ PATH: "/usr/bin" }, brew);
  assert.equal(env.MAESTRO_CLI_NO_ANALYTICS, "1");
  assert.equal(env.PATH, `/opt/homebrew/opt/openjdk@17/bin${path.delimiter}/usr/bin`);
  assert.equal(maestroEnv({ PATH: "/usr/bin", JAVA_HOME: "/jdk" }, brew).PATH, "/usr/bin");
  assert.equal(maestroEnv({ PATH: "/usr/bin" }, () => false).PATH, "/usr/bin");
});

test("pngSize: reads the width and height from the header", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imitor-png-")), "a.png");
  const head = Buffer.alloc(24);
  head.writeUInt32BE(1206, 16);
  head.writeUInt32BE(2622, 20);
  fs.writeFileSync(file, head);
  assert.deepEqual(pngSize(file), { width: 1206, height: 2622 });
});

test("shootIos: a flow that fills from a secret stops the run before any simulator starts", { skip: process.platform === "darwin" ? false : "needs macOS" }, async () => {
  const root = project({ secrets: ["TEST_PASSWORD"], simulator: { ios: { bundleId: "a.b" } }, flows: [{ name: "sign-in", steps: [{ fill: { placeholder: "Password", value: { env: "TEST_PASSWORD" } } }] }] });
  const config = loadConfig(root);
  const kept = path.join(root, config.out, "screens", "last-run.png");
  fs.mkdirSync(path.dirname(kept), { recursive: true });
  fs.writeFileSync(kept, "");
  await assert.rejects(shootIos(root, config), /flow "sign-in" fills from a secret \(TEST_PASSWORD\).*not masked/);
  assert.ok(fs.existsSync(kept), "a refused run leaves the previous run's screens");
});

test("shootIos: off a Mac it says the simulator needs macOS", { skip: process.platform === "darwin" ? "this is a Mac" : false }, async () => {
  const root = project({ simulator: { ios: { bundleId: "a.b" } } });
  await assert.rejects(shootIos(root, loadConfig(root)), /needs macOS.*macOS runner/);
});

test("report: a simulator run names its renderer, its own limits and its videos; a web run is unchanged", () => {
  const root = project({ flows: [{ name: "home", steps: [{ shot: "home" }] }] });
  const config = loadConfig(root);
  fs.mkdirSync(path.join(root, config.out), { recursive: true });
  const shot = { file: "screens/home-home-iphone-17-light.png", flow: "home", shot: "home", step: 1, device: "iphone-17", platform: "ios", width: 402, height: 874, scheme: "light", route: null, stubs: [], state: null, seeded: false, clock: null, target: "ios-simulator" };
  const videos = [{ file: "screens/home-iphone-17-light.mp4", flow: "home", device: "iphone-17", scheme: "light" }];
  const sim = writeReport(root, config, { shots: [shot], problems: [], videos, renderer: IOS_RENDERER, notCovered: IOS_NOT_COVERED });
  assert.equal(sim.renderer, IOS_RENDERER);
  assert.deepEqual(sim.notCovered, IOS_NOT_COVERED);
  assert.deepEqual(sim.videos, videos);
  const html = fs.readFileSync(path.join(root, config.out, "index.html"), "utf8");
  assert.match(html, /run in the native app in the iOS Simulator, not on a phone/);
  assert.doesNotMatch(html, /rendered on web/);
  const web = writeReport(root, config, { shots: [], problems: [] });
  assert.equal(web.renderer, "react-native-web in headless Chromium");
  assert.equal(web.videos, undefined);
  assert.match(fs.readFileSync(path.join(root, config.out, "index.html"), "utf8"), /rendered on web, not on a phone/);
});
