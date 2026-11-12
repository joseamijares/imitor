import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

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

/** Perform one non-screenshot step. Returns false for a shot step (the caller handles those). */
export async function doStep(page, step, baseUrl) {
  if (step.tap !== undefined) await locate(page, step.tap).click({ timeout: 10000 });
  else if (step.fill) await locate(page, step.fill).fill(String(step.fill.value), { timeout: 10000 });
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
  else throw new Error(`unknown step ${JSON.stringify(step)}`);
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

export async function shoot(root, config, baseUrl) {
  const { chromium } = loadPlaywright(root);
  const outDir = path.resolve(root, config.out);
  const shotDir = path.join(outDir, "screens");
  fs.rmSync(shotDir, { recursive: true, force: true });
  fs.mkdirSync(shotDir, { recursive: true });

  const browser = await chromium.launch();
  const shots = [];
  const problems = [];
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
          try {
            await page.goto(baseUrl + (flow.start || "/"));
            await settle(page, config.settleMs);
            for (const step of steps) {
              index++;
              if (await doStep(page, step, baseUrl)) {
                if (!step.wait) await settle(page, 150);
                continue;
              }
              await settle(page, config.settleMs);
              const file = `screens/${flow.name}-${step.shot}-${device.name}-${scheme}.png`;
              await page.screenshot({ path: path.join(outDir, file), fullPage: step.fullPage === true });
              const stubs = await visibleStandIns(page);
              shots.push({ file, flow: flow.name, shot: step.shot, step: index, device: device.name, platform: device.platform, width: device.width, height: device.height, scheme, route: new URL(page.url()).pathname, stubs });
              lastGoodShot = file;
            }
          } catch (error) {
            const file = `screens/${flow.name}-FAILED-${device.name}-${scheme}.png`;
            await page.screenshot({ path: path.join(outDir, file) }).catch(() => {});
            const notReached = steps.slice(Math.max(0, index - 1)).filter((s) => s.shot).map((s) => s.shot);
            problems.push({ where, kind: "flow-failed", message: String(error.message).split("\n")[0], file, ...at, step: index, stepConfig: steps[index - 1] ?? null, lastGoodShot, notReached });
          }
          for (const message of [...new Set(errors)]) problems.push({ where, kind: "page-error", message, ...at });
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  return { shots, problems };
}
