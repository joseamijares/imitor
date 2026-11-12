// Renders the placeholder fernwood screens (screens.mjs) into demo/assets/: one PNG per screen and scheme at
// 393 x 852, scale 1, and two short .webm videos of flows. Run once when the screens change, then commit the results:
//   node demo/screens/render.mjs
// Needs Playwright with Chromium. PNGs are reduced to a 64-colour palette with ImageMagick's `convert` when it is
// installed. The demo build (demo/build.mjs) does not run this; it only copies the committed files.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { page, SCREENS } from "./screens.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));
const SIZE = { width: 393, height: 852 };
const VIDEOS = {
  "log-a-watering-light": { scheme: "light", screens: ["today", "plant-detail", "log-sheet", "logged"] },
  "first-run-dark": { scheme: "dark", screens: ["welcome", "your-space", "add-plant", "plant-details", "schedule", "reminders", "all-set", "today"] },
};

let hasConvert = true;
try { execFileSync("convert", ["-version"], { stdio: "ignore" }); } catch { hasConvert = false; }

const browser = await chromium.launch();
try {
  fs.mkdirSync(path.join(ASSETS, "shots"), { recursive: true });
  const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1 });
  const tab = await context.newPage();
  for (const name of Object.keys(SCREENS)) {
    for (const scheme of ["light", "dark"]) {
      const file = path.join(ASSETS, "shots", `${name}-${scheme}.png`);
      await tab.setContent(page(name, scheme));
      await tab.screenshot({ path: file });
      if (hasConvert) execFileSync("convert", [file, "-strip", "-colors", "64", "-define", "png:compression-level=9", `PNG8:${file}`]);
    }
  }
  await context.close();

  fs.mkdirSync(path.join(ASSETS, "videos"), { recursive: true });
  for (const [name, v] of Object.entries(VIDEOS)) {
    const dir = fs.mkdtempSync(path.join(ASSETS, "videos", ".tmp-"));
    const ctx = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, recordVideo: { dir, size: { width: 262, height: 568 } } });
    const p = await ctx.newPage();
    for (const s of v.screens) {
      await p.setContent(page(s, v.scheme));
      await p.waitForTimeout(450);
    }
    const video = p.video();
    await ctx.close();
    fs.renameSync(await video.path(), path.join(ASSETS, "videos", `${name}.webm`));
    fs.rmSync(dir, { recursive: true, force: true });
  }
} finally {
  await browser.close();
}
console.log(`rendered into ${ASSETS}${hasConvert ? "" : " (convert not found: PNGs are not palette-reduced)"}`);
