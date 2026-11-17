// Run the config's flows on a real iOS Simulator instead of the web build: `imitor shoot --target ios`.
//
// The simulator is driven by two outside tools, neither bundled: Xcode's `xcrun simctl` (boot, appearance, install,
// screenshots, video) and Maestro (taps, fills, waits). What comes back has the same shape as shoot() in shoot.mjs, so
// the report, the run store, the gate and `imitor push` take it unchanged. macOS only: the iOS Simulator runs nowhere else.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publicStep, secretsUsed } from "./secrets.mjs";
import { flowChain } from "./state.mjs";
import { afterWhere } from "./shoot.mjs";

export const IOS_RENDERER = "the native app in the iOS Simulator";

/** What a simulator still does not show. Much shorter than the web list: the app, its chrome and its fonts are real. */
export const IOS_NOT_COVERED = [
  "Behaviour that differs on a real phone: performance, camera, sensors, push notifications, purchases",
  "Android: this run was on the iOS Simulator only",
  "State, seed and clock settings: they belong to the web stand-ins and are not applied on a simulator",
];

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const yaml = (value) => JSON.stringify(value); // JSON strings and flow maps are valid YAML

/** A flow target (the `tap`, `fill` and `waitFor` forms) as a Maestro selector. */
export function selector(target) {
  if (typeof target === "string") return target;
  if (target.testId) return { id: target.testId };
  // React Native's accessibilityLabel and placeholder both reach iOS as the element's accessibility text.
  if (target.label) return { text: target.label };
  if (target.placeholder) return { text: target.placeholder };
  if (target.text) return { text: target.text };
  if (target.css) throw new Error(`a "css" target only exists on the web; use testId, label, placeholder or text on a simulator: ${JSON.stringify(target)}`);
  throw new Error(`cannot locate ${JSON.stringify(target)}`);
}

/** The route as a link the app opens, from its URL scheme: ("myapp", "/today") gives "myapp://today". */
export function deepLink(scheme, route) {
  if (!scheme) throw new Error(`opening "${route}" on a simulator needs the app's URL scheme: set "simulator": { "ios": { "scheme": "myapp" } }`);
  return `${scheme}://${String(route).replace(/^\/+/, "")}`;
}

/** A fixed pause. Maestro has no plain sleep: wait for something that never appears, and do not fail when it does not. */
export const pause = (ms) => ({ extendedWaitUntil: { visible: { id: "imitor-wait-never-present" }, timeout: ms, optional: true } });

/**
 * One step as Maestro commands. A shot becomes `takeScreenshot` at `shotPath(step)`, a relative path: Maestro only writes them inside its
 * own debug folder (and adds ".png"), and shootIos() moves them into the run afterwards.
 * `settleMs` is the pause before a shot, as on the web.
 */
export function stepCommands(step, { scheme = null, shotPath = () => null, settleMs = 600 } = {}) {
  if (step.tap !== undefined) return [{ tapOn: selector(step.tap) }];
  if (step.fill) {
    if (step.fill.value !== null && typeof step.fill.value === "object") throw new Error("a fill from a secret cannot run on a simulator yet: its screenshots and video are not masked");
    return [{ tapOn: selector(step.fill) }, { eraseText: 200 }, { inputText: String(step.fill.value) }];
  }
  if (step.goto) return [{ openLink: deepLink(scheme, step.goto) }];
  if (step.wait) return [pause(step.wait)];
  if (step.waitFor) return [{ extendedWaitUntil: { visible: selector(step.waitFor), timeout: 15000 } }];
  if (step.scroll) return [{ swipe: { direction: step.scroll > 0 ? "UP" : "DOWN" } }]; // a swipe up scrolls down; pixels do not carry over
  // Pause first, as the web run does: a screen that is still loading can hold still long enough to pass for settled.
  if (step.shot) return [pause(settleMs), { waitForAnimationToEnd: { timeout: 3000 } }, { takeScreenshot: shotPath(step) }];
  throw new Error(`unknown step ${JSON.stringify(publicStep(step))}`);
}

/**
 * A whole flow as a Maestro file. Returns the YAML text and `owners`: for each command, the step it came from
 * ({ pre } for a step of a flow this one runs after, { index } for the flow's own 1-based step, { index: 0 } for the start).
 */
export function maestroFlow(config, flow, { bundleId, scheme = null, shotPath, clearState = true, launchWaitMs = 2500 }) {
  const chain = flowChain(config, flow);
  // The pause after launch lets the first screen load and lay out: a tap aimed while rows are still moving lands on the wrong one.
  const commands = [{ launchApp: { appId: bundleId, clearState } }, pause(launchWaitMs)];
  const owners = [{ index: 0 }, { index: 0 }];
  const add = (step, owner) => {
    for (const c of stepCommands(step, { scheme, shotPath, settleMs: config.settleMs })) {
      commands.push(c);
      owners.push(owner);
    }
  };
  if (chain.start && chain.start !== "/") add({ goto: chain.start }, { index: 0 });
  // Steps of the flows this one runs after: their shots are skipped, as on the web.
  for (const b of chain.before) if (!b.step.shot) add(b.step, { pre: b });
  (flow.steps || []).forEach((step, i) => add(step, { index: i + 1 }));
  const text = `appId: ${yaml(bundleId)}\n---\n${commands.map((c) => `- ${yaml(c)}`).join("\n")}\n`;
  return { text, owners, commands };
}

/** Width and height of a PNG file, from its header. */
export function pngSize(file) {
  const head = Buffer.alloc(24);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, head, 0, 24, 0);
  } finally {
    fs.closeSync(fd);
  }
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

function launchWait(value) {
  if (value === undefined) return 2500;
  if (!Number.isInteger(value) || value < 0 || value > 60000) throw new Error(`"simulator.ios.launchWaitMs" must be a whole number of milliseconds from 0 to 60000`);
  return value;
}

/** The simulator settings from imitor.config.json, checked. */
export function iosSettings(root) {
  const file = path.join(root, "imitor.config.json");
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const ios = raw.simulator?.ios;
  if (!ios || typeof ios !== "object") throw new Error(`--target ios needs "simulator": { "ios": { "bundleId": "com.example.app", "app": "path/to/Built.app" } } in imitor.config.json`);
  if (typeof ios.bundleId !== "string" || !ios.bundleId) throw new Error(`"simulator.ios.bundleId" must be the app's bundle identifier, such as "com.example.app"`);
  if (ios.app !== undefined) {
    if (typeof ios.app !== "string") throw new Error(`"simulator.ios.app" must be the path of a .app built for the simulator`);
    if (!fs.existsSync(path.resolve(root, ios.app))) throw new Error(`"simulator.ios.app": ${ios.app} does not exist (paths are relative to the app folder). Build it for the simulator first.`);
  }
  const devices = ios.devices === undefined ? ["iPhone 17"] : ios.devices;
  if (!Array.isArray(devices) || !devices.length || devices.some((d) => typeof d !== "string")) throw new Error(`"simulator.ios.devices" must be a list of simulator names, such as ["iPhone 17"] (see: xcrun simctl list devices available)`);
  return { bundleId: ios.bundleId, app: ios.app ? path.resolve(root, ios.app) : null, scheme: ios.scheme || null, devices, clearState: ios.clearState !== false, video: ios.video === true, launchWaitMs: launchWait(ios.launchWaitMs) };
}

function run(cmd, args, { timeout = 120000, env = process.env, cwd = undefined } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout, env, cwd, maxBuffer: 32 * 1024 * 1024 });
  if (r.error?.code === "ENOENT") throw new Error(cmd === "maestro" ? "Maestro is not installed. Install it: brew install mobile-dev-inc/tap/maestro (it needs Java 17 or newer)" : `${cmd} was not found. The iOS Simulator needs a Mac with Xcode installed.`);
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}` };
}

/** Find an available simulator by name (newest runtime first). Returns { udid, name, state } or throws with the names that exist. */
export function findDevice(name, list = null) {
  const data = list || JSON.parse(run("xcrun", ["simctl", "list", "devices", "available", "--json"]).out);
  const runtimes = Object.keys(data.devices).filter((r) => /iOS/.test(r)).sort().reverse();
  for (const r of runtimes) {
    const hit = data.devices[r].find((d) => d.name === name);
    if (hit) return { udid: hit.udid, name: hit.name, state: hit.state };
  }
  const names = [...new Set(runtimes.flatMap((r) => data.devices[r].map((d) => d.name)))];
  throw new Error(`no simulator named "${name}". Available: ${names.join(", ") || "none (install an iOS runtime in Xcode)"}`);
}

/**
 * The first of our commands Maestro did not complete, from the commands.json its debug output holds. Maestro lists only
 * the commands it started, after two of its own (variables, configuration). `at` is -1 when none failed, null when unknown.
 */
export function firstFailed(debugDir) {
  const file = fs.existsSync(debugDir) ? fs.readdirSync(debugDir, { recursive: true }).map(String).find((f) => /(^|[\\/])commands[^\\/]*\.json$/.test(f)) : null;
  if (!file) return { at: null, error: null };
  const entries = JSON.parse(fs.readFileSync(path.join(debugDir, file), "utf8")).filter((e) => !e.command?.defineVariablesCommand && !e.command?.applyConfigurationCommand);
  const at = entries.findIndex((e) => e.metadata?.status === "FAILED");
  return { at, error: at >= 0 ? entries[at].metadata?.error?.message || null : null };
}

/** The line of Maestro's output that says why a run failed. */
export function failureLine(out) {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /not found|is visible|Assertion|Unable to|failed|Exception|timed out/i.test(l) && !/^\s*at /.test(l));
  return (hit || lines.at(-1) || "Maestro failed without a message").slice(0, 300);
}

/**
 * The environment Maestro runs in. Homebrew's Java is "keg-only" (not on the PATH), so when no Java is set up, add the
 * places Homebrew puts it. Analytics off: a run in CI should send nothing.
 */
export function maestroEnv(env = process.env, exists = fs.existsSync) {
  const out = { ...env, MAESTRO_CLI_NO_ANALYTICS: "1", MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true" };
  if (env.JAVA_HOME) return out;
  const kegs = ["/opt/homebrew/opt", "/usr/local/opt"].flatMap((base) => ["openjdk", "openjdk@21", "openjdk@17"].map((k) => `${base}/${k}/bin`)).filter((dir) => exists(`${dir}/java`));
  if (kegs.length) out.PATH = `${kegs[0]}${path.delimiter}${env.PATH || ""}`;
  return out;
}

/** Stop before any flow when Maestro cannot start, with what to install, instead of failing every flow the same way. */
function checkMaestro(env) {
  const r = run("maestro", ["--version"], { timeout: 60000, env });
  if (/Unable to locate a Java Runtime|java: command not found|JAVA_HOME/i.test(r.out) || !r.ok) {
    throw new Error(`Maestro could not start${/Java/i.test(r.out) ? ": it needs Java 17 or newer. Install it (brew install openjdk@17) or set JAVA_HOME" : `: ${failureLine(r.out)}`}`);
  }
}

export async function shootIos(root, config, settings = iosSettings(root)) {
  if (process.platform !== "darwin") throw new Error("--target ios needs macOS: the iOS Simulator runs only on a Mac. In CI, use a macOS runner.");
  const outDir = path.resolve(root, config.out);
  const shotDir = path.join(outDir, "screens");
  fs.rmSync(shotDir, { recursive: true, force: true });
  fs.mkdirSync(shotDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-ios-"));
  for (const flow of config.flows) {
    const names = secretsUsed([...flowChain(config, flow).before.map((b) => b.step), ...(flow.steps || [])]);
    if (names.length) throw new Error(`flow "${flow.name}" fills from a secret (${names.join(", ")}). That cannot run on a simulator yet: its screenshots and video are not masked.`);
  }

  const env = maestroEnv();
  checkMaestro(env);
  const shots = [];
  const problems = [];
  const videos = [];
  const devices = []; // the simulators this run used, in the shape config.devices has, for the run record
  try {
    for (const deviceName of settings.devices) {
      const device = findDevice(deviceName);
      const name = slug(device.name);
      devices.push({ name, platform: "ios" });
      if (device.state !== "Booted") run("xcrun", ["simctl", "boot", device.udid]);
      const booted = run("xcrun", ["simctl", "bootstatus", device.udid, "-b"], { timeout: 300000 });
      if (!booted.ok) throw new Error(`the simulator "${device.name}" did not boot: ${failureLine(booted.out)}`);
      if (settings.app) {
        const installed = run("xcrun", ["simctl", "install", device.udid, settings.app]);
        if (!installed.ok) throw new Error(`could not install ${settings.app} on "${device.name}": ${failureLine(installed.out)}`);
      }
      for (const flow of config.flows) {
        for (const scheme of config.schemes) {
          run("xcrun", ["simctl", "ui", device.udid, "appearance", scheme]);
          const where = `${flow.name} / ${name} / ${scheme}`;
          const at = { flow: flow.name, device: name, scheme };
          const steps = flow.steps || [];
          const rel = (shot) => `screens/${flow.name}-${shot}-${name}-${scheme}`;
          const { text, owners } = maestroFlow(config, flow, { bundleId: settings.bundleId, scheme: settings.scheme, clearState: settings.clearState, launchWaitMs: settings.launchWaitMs, shotPath: (step) => rel(step.shot) });
          const id = `${flow.name}-${name}-${scheme}`;
          const flowFile = path.join(work, `${id}.yaml`);
          const debugDir = path.join(work, `${id}-debug`);
          fs.writeFileSync(flowFile, text);

          let recorder = null;
          const videoFile = `screens/${id}.mp4`;
          if (settings.video) recorder = spawn("xcrun", ["simctl", "io", device.udid, "recordVideo", "--force", path.join(outDir, videoFile)], { stdio: "ignore" });
          const result = run("maestro", ["--udid", device.udid, "test", "--debug-output", debugDir, "--flatten-debug-output", flowFile], { timeout: 900000, env });
          if (recorder) {
            // simctl finishes the file on SIGINT.
            await new Promise((done) => {
              recorder.once("exit", done);
              recorder.kill("SIGINT");
              setTimeout(done, 10000);
            });
            if (fs.existsSync(path.join(outDir, videoFile))) videos.push({ file: videoFile, ...at });
          }

          // Maestro keeps screenshots inside its debug folder (<flow>/takeScreenshot/<path>.png): move them into the run.
          const written = fs.existsSync(debugDir) ? fs.readdirSync(debugDir, { recursive: true }).map(String) : [];
          for (const step of steps.filter((st) => st.shot)) {
            const tail = path.join("takeScreenshot", `${rel(step.shot)}.png`);
            const hit = written.find((f) => f.endsWith(tail));
            if (hit) fs.copyFileSync(path.join(debugDir, hit), path.join(outDir, `${rel(step.shot)}.png`));
          }
          const failed = result.ok ? { at: -1, error: null } : firstFailed(debugDir);
          const owner = failed.at >= 0 && failed.at !== null ? owners[failed.at] : null;
          const failIndex = result.ok ? Infinity : owner ? (owner.pre ? 0 : owner.index) : steps.length;
          let lastGoodShot = null;
          steps.forEach((step, i) => {
            if (!step.shot) return;
            const file = `${rel(step.shot)}.png`;
            const full = path.join(outDir, file);
            // A shot counts when its step ran before the one that failed and its file is there.
            if (i + 1 >= failIndex && !result.ok) return fs.rmSync(full, { force: true });
            if (!fs.existsSync(full)) return;
            // Sizes are in points, as on the web: iPhones wider than 1080 pixels draw at 3x, everything else at 2x.
            const px = pngSize(full);
            const scale = /iphone/i.test(device.name) && Math.min(px.width, px.height) >= 1080 ? 3 : 2;
            const size = { width: Math.round(px.width / scale), height: Math.round(px.height / scale) };
            Object.assign(devices.at(-1), { ...size, scale });
            shots.push({ file, flow: flow.name, shot: step.shot, step: i + 1, device: name, platform: "ios", width: size.width, height: size.height, scale, scheme, route: null, stubs: [], state: null, seeded: false, clock: null, target: "ios-simulator" });
            lastGoodShot = file;
          });
          if (!result.ok) {
            const file = `screens/${flow.name}-FAILED-${name}-${scheme}.png`;
            run("xcrun", ["simctl", "io", device.udid, "screenshot", path.join(outDir, file)]);
            const message = (failed.error || failureLine(result.out)).split("\n")[0].slice(0, 300);
            const index = failIndex === Infinity ? steps.length : failIndex;
            const notReached = steps.slice(Math.max(0, index - 1)).filter((s) => s.shot).map((s) => s.shot);
            const shot = fs.existsSync(path.join(outDir, file)) ? file : null;
            if (owner?.pre) problems.push({ where, kind: "flow-failed", message: `${afterWhere(owner.pre, flow.name)}: ${message}`, error: message, file: shot, ...at, step: 0, stepConfig: publicStep(owner.pre.step), after: { flow: owner.pre.flow, step: owner.pre.index }, lastGoodShot, notReached });
            else problems.push({ where, kind: "flow-failed", message, file: shot, ...at, step: index, stepConfig: publicStep(steps[index - 1] ?? null), lastGoodShot, notReached });
          }
        }
      }
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return { shots, problems, videos, devices, renderer: IOS_RENDERER, notCovered: IOS_NOT_COVERED };
}
