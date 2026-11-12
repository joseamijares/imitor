// The operations agents (and the CLI) can ask for: one screenshot, one flow run, one video, the problems of the last run.
import fs from "node:fs";
import path from "node:path";
import { DEVICES, fidelityOf, loadConfig } from "./config.mjs";
import { serve } from "./serve.mjs";
import { publicStep, refuseSecretRefs, scrub, secretValues } from "./secrets.mjs";
import { doStep, loadPlaywright, settle, shotOptions, visibleStandIns, watchDialogs } from "./shoot.mjs";
import { flowChain, flowSecrets, prepareContext, readSeedProblems, stateInfo } from "./state.mjs";

const slug = (s) => String(s).replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-") || "root";
/**
 * A short suffix that differs between calls (time in base 36 plus two random characters), so a capture taken again
 * with the same route, flow, device and scheme gets its own file and older captures/index.jsonl lines keep their image.
 */
export const uniqueSuffix = (now = Date.now()) => now.toString(36) + Math.random().toString(36).slice(2, 4).padEnd(2, "0");

function resolveDevice(config, name) {
  if (!name) return config.devices[0];
  const fromConfig = config.devices.find((d) => d.name === name);
  if (fromConfig) return fromConfig;
  if (DEVICES[name]) return { name, ...DEVICES[name] };
  throw new Error(`unknown device "${name}". Known: ${[...new Set([...config.devices.map((d) => d.name), ...Object.keys(DEVICES)])].join(", ")}`);
}

function findFlow(config, name) {
  const flow = config.flows.find((f) => f.name === name);
  if (!flow) throw new Error(`unknown flow "${name}". Flows in imitor.config.json: ${config.flows.map((f) => f.name).join(", ") || "none"}`);
  return flow;
}

function appDir(root, config) {
  const dir = path.resolve(root, config.out, "app");
  if (!fs.existsSync(path.join(dir, "index.html"))) throw new Error(`no preview build at ${path.relative(root, dir) || dir}. Build one first (imitor build, or the imitor_build tool).`);
  return dir;
}

/**
 * Open the built preview in a fresh browser context, set up for `flow` (its state, seed and clock), and hand the page to
 * `task`. The result carries the flow's state info and any seed problems.
 */
async function withPage(root, config, opts, flow, task) {
  const { chromium } = loadPlaywright(root);
  const device = resolveDevice(config, opts.device);
  const scheme = opts.scheme || config.schemes[0];
  const server = await serve(appDir(root, config));
  const browser = await chromium.launch();
  const errors = [];
  const dialogs = [];
  try {
    const context = await browser.newContext({
      viewport: { width: device.width, height: device.height },
      deviceScaleFactor: opts.scale || device.scale,
      colorScheme: scheme,
      locale: opts.locale || config.locale,
      timezoneId: config.timezone,
      reducedMotion: (opts.reducedMotion ?? config.reducedMotion) ? "reduce" : "no-preference",
      isMobile: true,
      hasTouch: true,
      ...(opts.videoDir ? { recordVideo: { dir: opts.videoDir, size: { width: device.width, height: device.height } } } : {}),
    });
    const setup = await prepareContext(context, flow);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(String(e.message).split("\n")[0]));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text().split("\n")[0].slice(0, 300)));
    watchDialogs(page, (message) => dialogs.push(message));
    const result = await task({ page, context, device, scheme, baseUrl: server.url });
    const seedErrors = await readSeedProblems(page, setup);
    await context.close(); // flushes the video file
    const { after, state, seeded, clock } = stateInfo(flow);
    // Error messages, page errors and dialogs can echo what was typed: take every secret value out of the result.
    return scrub({ ...result, device: device.name, scheme, after, state, seeded, clock, ...("passed" in result ? { passed: result.passed && !seedErrors.length } : {}), seedErrors, pageErrors: [...new Set(errors)], dialogs }, secretValues(config.secrets));
  } finally {
    await browser.close();
    server.close();
  }
}

/**
 * Open where `flow` really starts and run the steps of the flows it runs after ("after"), shots skipped. Returns
 * { steps, failedAt, failedIn } like runSteps; steps carry `after: <flow>`, failedIn names the flow that failed.
 */
async function startFlow(page, config, flow, baseUrl) {
  const chain = flowChain(config, flow);
  await page.goto(baseUrl + chain.start);
  await settle(page, config.settleMs);
  const done = [];
  for (const b of chain.before) {
    try {
      await doStep(page, b.step, baseUrl, config.secrets);
      if (!b.step.wait) await settle(page, 150);
      done.push({ after: b.flow, index: b.index, step: b.step, ok: true });
    } catch (error) {
      done.push({ after: b.flow, index: b.index, step: b.step, ok: false, error: String(error.message).split("\n")[0] });
      return { steps: done, failedAt: b.index, failedIn: b.flow };
    }
  }
  return { steps: done, failedAt: null, failedIn: null };
}

/** Steps as results report them, with fill values hidden (publicStep). */
const stepReport = (s) => {
  const action = Object.keys(s.step)[0];
  return { ...(s.after ? { after: s.after } : {}), index: s.index, action, target: publicStep(s.step)[action], ok: s.ok, ...(s.error ? { error: s.error } : {}) };
};

/** The flow a screenshot without `flow` runs as: the route, under the top-level state settings (or opts.state). */
function adHocFlow(config, opts) {
  const d = config.defaults || {};
  return { name: null, start: opts.route || "/", steps: [], after: d.after ?? null, state: opts.state ?? d.state ?? null, seed: d.seed ?? null, clock: d.clock ?? null };
}

/** `secrets: [names]` for a result whose flow (or the flows it runs after) fills values from the environment. */
const secretsNote = (config, flow) => {
  const used = flowSecrets(config, flow);
  return used.length ? { secrets: used } : {};
};

/** Run steps, calling onShot for shot steps. Returns { steps: [...], failedAt } without throwing on a failed step. */
async function runSteps(page, steps, baseUrl, config, onShot) {
  const done = [];
  for (const [index, step] of steps.entries()) {
    try {
      if (await doStep(page, step, baseUrl, config.secrets)) {
        if (!step.wait) await settle(page, 150);
      } else {
        await settle(page, config.settleMs);
        if (onShot) await onShot(step);
      }
      done.push({ index: index + 1, step, ok: true });
    } catch (error) {
      done.push({ index: index + 1, step, ok: false, error: String(error.message).split("\n")[0] });
      return { steps: done, failedAt: index + 1 };
    }
  }
  return { steps: done, failedAt: null };
}

/**
 * One screenshot. Reach the screen either by `route`, by running a named `flow` first (its own shot steps are skipped),
 * or by inline `steps`. Saved under <out>/captures.
 */
export async function screenshot(root, opts = {}) {
  const config = loadConfig(root);
  const dir = path.resolve(root, config.out, "captures");
  fs.mkdirSync(dir, { recursive: true });
  refuseSecretRefs(opts.steps);
  const flow = opts.flow ? findFlow(config, opts.flow) : null;
  const base = flow ? (opts.state !== undefined ? { ...flow, state: opts.state } : flow) : adHocFlow(config, opts);
  return withPage(root, config, opts, base, async ({ page, device, scheme, baseUrl }) => {
    const pre = await startFlow(page, config, base, baseUrl);
    const steps = [...(flow ? flow.steps : []), ...(opts.steps || [])];
    const run = pre.failedAt !== null ? pre : await runSteps(page, steps, baseUrl, config, null);
    if (flow && opts.route) {
      await page.goto(baseUrl + opts.route);
    }
    await settle(page, config.settleMs);
    const route = new URL(page.url()).pathname;
    const name = opts.name || `${slug(flow ? flow.name : route)}-${device.name}-${scheme}-${uniqueSuffix()}`;
    const file = path.join(dir, `${slug(name)}.png`);
    await page.screenshot(shotOptions(page, { path: file, fullPage: opts.fullPage === true }));
    const failed = run.failedAt !== null;
    return { file: path.relative(root, file), route, standIns: await visibleStandIns(page), failedAt: run.failedAt, ...(failed && run.failedIn ? { failedIn: run.failedIn } : {}), failedStep: failed ? { ...run.steps.at(-1), step: publicStep(run.steps.at(-1).step) } : null, ...secretsNote(config, base) };
  });
}

/** Run one flow and report every step. Shots are saved under <out>/captures/<flow>/. */
export async function runFlow(root, opts = {}) {
  const config = loadConfig(root);
  const flow = findFlow(config, opts.flow);
  const dir = path.resolve(root, config.out, "captures", slug(flow.name));
  fs.mkdirSync(dir, { recursive: true });
  const suffix = uniqueSuffix();
  return withPage(root, config, opts, flow, async ({ page, device, scheme, baseUrl }) => {
    const pre = await startFlow(page, config, flow, baseUrl);
    const shots = [];
    const own = pre.failedAt !== null ? { steps: [], failedAt: null } : await runSteps(page, flow.steps || [], baseUrl, config, async (step) => {
      const file = path.join(dir, `${slug(step.shot)}-${device.name}-${scheme}-${suffix}.png`);
      await page.screenshot(shotOptions(page, { path: file, fullPage: step.fullPage === true }));
      shots.push({ shot: step.shot, file: path.relative(root, file), route: new URL(page.url()).pathname, standIns: await visibleStandIns(page) });
    });
    const run = { steps: [...pre.steps, ...own.steps], failedAt: pre.failedAt ?? own.failedAt, failedIn: pre.failedIn ?? (own.failedAt !== null ? flow.name : null) };
    let failureShot = null;
    if (run.failedAt !== null) {
      const file = path.join(dir, `FAILED-step-${run.failedAt}-${device.name}-${scheme}-${suffix}.png`);
      await page.screenshot(shotOptions(page, { path: file })).catch(() => {});
      failureShot = path.relative(root, file);
    }
    return { flow: flow.name, passed: run.failedAt === null, failedAt: run.failedAt, ...(run.failedIn ? { failedIn: run.failedIn } : {}), failureShot, steps: run.steps.map(stepReport), shots, ...secretsNote(config, flow) };
  });
}

/** Record a video of one flow as it plays. Saved as .webm under <out>/captures. */
export async function recordVideo(root, opts = {}) {
  const config = loadConfig(root);
  const flow = findFlow(config, opts.flow);
  // A video shows every frame, including a secret being typed and whatever the session it opens shows; masks do not
  // reach it. Refuse rather than record.
  const used = flowSecrets(config, flow);
  if (used.length) throw new Error(`flow "${flow.name}" fills values from the environment (${used.join(", ")}), and Imitor does not record videos of such flows`);
  const dir = path.resolve(root, config.out, "captures");
  const tmp = fs.mkdtempSync(path.join(dir.replace(/captures$/, ""), ".video-"));
  fs.mkdirSync(dir, { recursive: true });
  let video;
  try {
    const result = await withPage(root, config, { ...opts, scale: 1, reducedMotion: opts.reducedMotion ?? false, videoDir: tmp }, flow, async ({ page, device, scheme, baseUrl }) => {
      video = page.video();
      const started = Date.now();
      const pre = await startFlow(page, config, flow, baseUrl);
      const own = pre.failedAt !== null ? { failedAt: null } : await runSteps(page, flow.steps || [], baseUrl, config, async () => page.waitForTimeout(opts.holdMs ?? 700));
      const run = { failedAt: pre.failedAt ?? own.failedAt, failedIn: pre.failedIn ?? (own.failedAt !== null ? flow.name : null) };
      await page.waitForTimeout(opts.holdMs ?? 700);
      return { flow: flow.name, passed: run.failedAt === null, failedAt: run.failedAt, ...(run.failedIn ? { failedIn: run.failedIn } : {}), seconds: Math.round((Date.now() - started) / 100) / 10, name: `${slug(flow.name)}-${device.name}-${scheme}-${uniqueSuffix()}` };
    });
    const file = path.join(dir, `${result.name}.webm`);
    fs.copyFileSync(await video.path(), file);
    const { name: _name, ...rest } = result;
    return { ...rest, file: path.relative(root, file), bytes: fs.statSync(file).size };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Problems and coverage of the last full run (imitor, or imitor shoot). */
export function readProblems(root) {
  const config = loadConfig(root);
  const file = path.resolve(root, config.out, "manifest.json");
  if (!fs.existsSync(file)) throw new Error("no run found. Run `imitor` (or the imitor_build tool, then imitor_run_flow) first.");
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  const standIns = [...new Set(m.shots.flatMap((s) => s.stubs))];
  return { commit: m.commit, generatedAt: m.generatedAt, shots: m.shots.length, problems: m.problems, standInsSeen: standIns, shotsWithStandIns: m.shots.filter((s) => s.stubs.length).map((s) => s.file), notCovered: m.notCovered };
}

/** Flows, devices and schemes an agent can ask for. */
export function describe(root) {
  const config = loadConfig(root);
  return { flows: config.flows.map((f) => ({ name: f.name, start: f.start || (f.after ? null : "/"), steps: (f.steps || []).length, shots: (f.steps || []).filter((s) => s.shot).map((s) => s.shot), ...stateInfo(f), secrets: flowSecrets(config, f) })), devices: [...new Set([...config.devices.map((d) => d.name), ...Object.keys(DEVICES)])], schemes: ["light", "dark"], standIns: config.shims, fidelity: Object.fromEntries(Object.entries(config.shims).map(([module, kind]) => [module, fidelityOf(kind)])), built: fs.existsSync(path.resolve(root, config.out, "app", "index.html")) };
}
