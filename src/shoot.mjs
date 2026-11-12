import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { publicStep, resolveValue, scrub, secretValues } from "./secrets.mjs";
import { flowChain, flowSecrets, prepareContext, readSeedProblems, stateInfo } from "./state.mjs";

// Prefer the app's own playwright, then Imitor's, then a global install.
export function loadPlaywright(root) {
  for (const from of [path.join(root, "package.json"), import.meta.url]) {
    try {
      return createRequire(from)("playwright");
    } catch {}
  }
  throw new Error("playwright is not installed. Run: npm i -D playwright && npx playwright install chromium");
}

export function locate(page, target) {
  if (typeof target === "string") return page.getByText(target, { exact: true }).first();
  if (target.testId) return page.getByTestId(target.testId).first();
  if (target.label) return page.getByLabel(target.label, { exact: true }).first();
  if (target.placeholder) return page.getByPlaceholder(target.placeholder).first();
  if (target.text) return page.getByText(target.text, { exact: target.exact ?? true }).first();
  if (target.css) return page.locator(target.css).first();
  throw new Error(`cannot locate ${JSON.stringify(target)}`);
}

export async function settle(page, ms) {
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await page.waitForTimeout(ms);
}

// Fields filled from a secret on each page, masked in that page's screenshots (unless they are password fields, which
// already draw dots).
const masked = new WeakMap();

/** Screenshot options for `page`: `extra`, plus a mask over every field filled from a secret. */
export const shotOptions = (page, extra = {}) => ({ ...extra, mask: masked.get(page) || [] });

/**
 * Perform one non-screenshot step. Returns false for a shot step (the caller handles those). `secrets` is the config's
 * list of names a fill may take its value from ({ "env": "NAME" }).
 */
export async function doStep(page, step, baseUrl, secrets = []) {
  if (step.tap !== undefined) await locate(page, step.tap).click({ timeout: 10000 });
  else if (step.fill) {
    const field = locate(page, step.fill);
    const fromEnv = step.fill.value !== null && typeof step.fill.value === "object";
    await field.fill(resolveValue(step.fill.value, secrets), { timeout: 10000 });
    if (fromEnv) {
      const password = await field.evaluate((el) => el.matches("input[type=password]") || Boolean(el.querySelector && el.querySelector("input[type=password]"))).catch(() => false);
      if (!password) masked.set(page, [...(masked.get(page) || []), field]);
    }
  }
  else if (step.goto) await page.goto(baseUrl + step.goto);
  else if (step.wait) await page.waitForTimeout(step.wait);
  else if (step.waitFor) await locate(page, step.waitFor).waitFor({ timeout: 15000 });
  else if (step.scroll) {
    // The wheel scrolls whatever is under the pointer. React Native Web apps scroll an inner ScrollView, not the
    // document, and the pointer starts at (0, 0), usually over a header, so aim at the middle of the viewport.
    const size = page.viewportSize();
    if (size) await page.mouse.move(size.width / 2, size.height / 2);
    await page.mouse.wheel(0, step.scroll);
  }
  else if (step.shot) return false;
  else throw new Error(`unknown step ${JSON.stringify(publicStep(step))}`);
  return true;
}

/**
 * Record alert / confirm / prompt dialogs and dismiss them (as Playwright does by default). Apps often show errors with
 * window.alert on web, and a browser dialog never appears in a screenshot, so without this its text is lost.
 */
export function watchDialogs(page, onDialog) {
  page.on("dialog", (dialog) => {
    onDialog(`${dialog.type()}: ${dialog.message().replace(/\s+/g, " ").trim().slice(0, 300)}`);
    dialog.dismiss().catch(() => {});
  });
}

/** The names of stand-ins visible on the page right now. */
export const visibleStandIns = (page) =>
  page.evaluate(() => [...new Set([...document.querySelectorAll("[data-imitor-stub]")].map((n) => n.getAttribute("data-imitor-stub")))]);

/** Where a step run before a flow's own steps is: "in "onboarding", which this flow runs after, step 3", or "opening /x". */
export function afterWhere(pre, flowName) {
  if (pre.flow === flowName) return `opening its start ${pre.step.goto}, after the flows it runs after`;
  return `in "${pre.flow}", which this flow runs after, ${pre.index ? `step ${pre.index}` : `opening ${pre.step.goto}`}`;
}

export async function shoot(root, config, baseUrl) {
  const { chromium } = loadPlaywright(root);
  const outDir = path.resolve(root, config.out);
  const shotDir = path.join(outDir, "screens");
  fs.rmSync(shotDir, { recursive: true, force: true });
  fs.mkdirSync(shotDir, { recursive: true });

  const browser = await chromium.launch();
  const shots = [];
  const problems = [];
  const secrets = config.secrets || [];
  try {
    for (const flow of config.flows) {
      for (const device of config.devices) {
        for (const scheme of config.schemes) {
          const context = await browser.newContext({
            viewport: { width: device.width, height: device.height },
            deviceScaleFactor: device.scale,
            colorScheme: scheme,
            locale: flow.locale || config.locale,
            timezoneId: config.timezone,
            reducedMotion: config.reducedMotion ? "reduce" : "no-preference",
            isMobile: true,
            hasTouch: true,
          });
          const setup = await prepareContext(context, flow);
          const { state, seeded, clock } = stateInfo(flow);
          const usesSecrets = flowSecrets(config, flow);
          const chain = flowChain(config, flow);
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", (e) => errors.push(String(e.message).split("\n")[0]));
          page.on("console", (m) => m.type() === "error" && errors.push(m.text().split("\n")[0].slice(0, 300)));
          const where = `${flow.name} / ${device.name} / ${scheme}`;
          const at = { flow: flow.name, device: device.name, scheme };
          const steps = flow.steps || [];
          let index = 0; // 1-based index of the step being run; 0 while opening the start route
          watchDialogs(page, (message) => problems.push({ where, kind: "dialog", message, ...at, step: index }));
          let lastGoodShot = null;
          let pre = null; // the step of a flow this one runs after ("after"), while those run
          try {
            await page.goto(baseUrl + chain.start);
            await settle(page, config.settleMs);
            for (const b of chain.before) {
              pre = b;
              await doStep(page, b.step, baseUrl, secrets);
              if (!b.step.wait) await settle(page, 150);
            }
            pre = null;
            for (const step of steps) {
              index++;
              if (await doStep(page, step, baseUrl, secrets)) {
                if (!step.wait) await settle(page, 150);
                continue;
              }
              await settle(page, config.settleMs);
              const file = `screens/${flow.name}-${step.shot}-${device.name}-${scheme}.png`;
              await page.screenshot(shotOptions(page, { path: path.join(outDir, file), fullPage: step.fullPage === true }));
              const stubs = await visibleStandIns(page);
              shots.push({ file, flow: flow.name, shot: step.shot, step: index, device: device.name, platform: device.platform, width: device.width, height: device.height, scheme, route: new URL(page.url()).pathname, stubs, state, seeded, clock, ...(usesSecrets.length ? { secrets: usesSecrets } : {}) });
              lastGoodShot = file;
            }
          } catch (error) {
            const file = `screens/${flow.name}-FAILED-${device.name}-${scheme}.png`;
            await page.screenshot(shotOptions(page, { path: path.join(outDir, file) })).catch(() => {});
            const notReached = steps.slice(Math.max(0, index - 1)).filter((s) => s.shot).map((s) => s.shot);
            const message = String(error.message).split("\n")[0];
            if (pre) problems.push({ where, kind: "flow-failed", message: `${afterWhere(pre, flow.name)}: ${message}`, error: message, file, ...at, step: 0, stepConfig: publicStep(pre.step), after: { flow: pre.flow, step: pre.index }, lastGoodShot, notReached });
            else problems.push({ where, kind: "flow-failed", message, file, ...at, step: index, stepConfig: publicStep(steps[index - 1] ?? null), lastGoodShot, notReached });
          }
          for (const message of await readSeedProblems(page, setup)) problems.push({ where, kind: "seed-failed", message, ...at });
          for (const message of [...new Set(errors)]) problems.push({ where, kind: "page-error", message, ...at });
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  // Errors, page errors and dialogs can echo what was typed: take every secret value out of them.
  return { shots, problems: scrub(problems, secretValues(secrets)) };
}
