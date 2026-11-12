// The operations agents (and the CLI) can ask for: one screenshot, one flow run, one video, the problems of the last run.
import fs from "node:fs";
import path from "node:path";
import { DEVICES, loadConfig } from "./config.mjs";
import { serve } from "./serve.mjs";
import { doStep, loadPlaywright, settle, visibleStandIns, watchDialogs } from "./shoot.mjs";

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

/** Open the built preview in a fresh browser context and hand the page to `task`. */
async function withPage(root, config, opts, task) {
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
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(String(e.message).split("\n")[0]));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text().split("\n")[0].slice(0, 300)));
    watchDialogs(page, (message) => dialogs.push(message));
    const result = await task({ page, context, device, scheme, baseUrl: server.url });
    await context.close(); // flushes the video file
    return { ...result, device: device.name, scheme, pageErrors: [...new Set(errors)], dialogs };
  } finally {
    await browser.close();
    server.close();
  }
}

/** Run steps, calling onShot for shot steps. Returns { steps: [...], failedAt } without throwing on a failed step. */
async function runSteps(page, steps, baseUrl, config, onShot) {
  const done = [];
  for (const [index, step] of steps.entries()) {
    try {
      if (await doStep(page, step, baseUrl)) {
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
  return withPage(root, config, opts, async ({ page, device, scheme, baseUrl }) => {
    const flow = opts.flow ? findFlow(config, opts.flow) : null;
    await page.goto(baseUrl + (opts.route && !flow ? opts.route : flow?.start || opts.route || "/"));
    await settle(page, config.settleMs);
    const steps = [...(flow ? flow.steps : []), ...(opts.steps || [])];
    const run = await runSteps(page, steps, baseUrl, config, null);
    if (flow && opts.route) {
      await page.goto(baseUrl + opts.route);
    }
    await settle(page, config.settleMs);
    const route = new URL(page.url()).pathname;
    const name = opts.name || `${slug(flow ? flow.name : route)}-${device.name}-${scheme}-${uniqueSuffix()}`;
    const file = path.join(dir, `${slug(name)}.png`);
    await page.screenshot({ path: file, fullPage: opts.fullPage === true });
    return { file: path.relative(root, file), route, standIns: await visibleStandIns(page), failedAt: run.failedAt, failedStep: run.failedAt ? run.steps.at(-1) : null };
  });
}

/** Run one flow and report every step. Shots are saved under <out>/captures/<flow>/. */
export async function runFlow(root, opts = {}) {
  const config = loadConfig(root);
  const flow = findFlow(config, opts.flow);
  const dir = path.resolve(root, config.out, "captures", slug(flow.name));
  fs.mkdirSync(dir, { recursive: true });
  const suffix = uniqueSuffix();
  return withPage(root, config, opts, async ({ page, device, scheme, baseUrl }) => {
    await page.goto(baseUrl + (flow.start || "/"));
    await settle(page, config.settleMs);
    const shots = [];
    const run = await runSteps(page, flow.steps || [], baseUrl, config, async (step) => {
      const file = path.join(dir, `${slug(step.shot)}-${device.name}-${scheme}-${suffix}.png`);
      await page.screenshot({ path: file, fullPage: step.fullPage === true });
      shots.push({ shot: step.shot, file: path.relative(root, file), route: new URL(page.url()).pathname, standIns: await visibleStandIns(page) });
    });
    let failureShot = null;
    if (run.failedAt) {
      const file = path.join(dir, `FAILED-step-${run.failedAt}-${device.name}-${scheme}-${suffix}.png`);
      await page.screenshot({ path: file }).catch(() => {});
      failureShot = path.relative(root, file);
    }
    return { flow: flow.name, passed: !run.failedAt, failedAt: run.failedAt, failureShot, steps: run.steps.map((s) => ({ index: s.index, action: Object.keys(s.step)[0], target: s.step[Object.keys(s.step)[0]], ok: s.ok, ...(s.error ? { error: s.error } : {}) })), shots };
  });
}

/** Record a video of one flow as it plays. Saved as .webm under <out>/captures. */
export async function recordVideo(root, opts = {}) {
  const config = loadConfig(root);
  const flow = findFlow(config, opts.flow);
  const dir = path.resolve(root, config.out, "captures");
  const tmp = fs.mkdtempSync(path.join(dir.replace(/captures$/, ""), ".video-"));
  fs.mkdirSync(dir, { recursive: true });
  let video;
  try {
    const result = await withPage(root, config, { ...opts, scale: 1, reducedMotion: opts.reducedMotion ?? false, videoDir: tmp }, async ({ page, device, scheme, baseUrl }) => {
      video = page.video();
      const started = Date.now();
      await page.goto(baseUrl + (flow.start || "/"));
      await settle(page, config.settleMs);
      const run = await runSteps(page, flow.steps || [], baseUrl, config, async () => page.waitForTimeout(opts.holdMs ?? 700));
      await page.waitForTimeout(opts.holdMs ?? 700);
      return { flow: flow.name, passed: !run.failedAt, failedAt: run.failedAt, seconds: Math.round((Date.now() - started) / 100) / 10, name: `${slug(flow.name)}-${device.name}-${scheme}-${uniqueSuffix()}` };
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
  return { flows: config.flows.map((f) => ({ name: f.name, start: f.start || "/", steps: (f.steps || []).length, shots: (f.steps || []).filter((s) => s.shot).map((s) => s.shot) })), devices: [...new Set([...config.devices.map((d) => d.name), ...Object.keys(DEVICES)])], schemes: ["light", "dark"], standIns: config.shims, built: fs.existsSync(path.resolve(root, config.out, "app", "index.html")) };
}
