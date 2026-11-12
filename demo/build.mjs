// Builds the public demo of Imitor's interface into demo/site/ (git-ignored):
//   node demo/build.mjs        (or: npm run demo)
// It assembles a throwaway Imitor output folder for "fernwood", an invented plant-care app (demo/dataset.mjs), with the
// store's own functions and file formats, then runs the export with --demo. Node only: no Playwright, no Expo, no
// network, so it runs on a static host's build machine. Times are relative to now, so the newest run is minutes old.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MEDIA_MARKER } from "../src/build.mjs";
import { loadConfig, NOT_COVERED } from "../src/config.mjs";
import { exportSite } from "../src/export.mjs";
import { appendActivity, appendCapture, problemsOfRun, recordRun, setSeen } from "../src/store.mjs";
import { ACTIVITY, CAPTURES, CONFIG, PACKAGE, RUNS, SHOTS } from "./dataset.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ASSETS = path.join(HERE, "assets");
const DEVICE = "iphone-16";

export function buildDemo({ out = path.join(HERE, "site"), now = Date.now() } = {}) {
  const at = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-demo-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(PACKAGE, null, 2));
    fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify(CONFIG, null, 2));
    const config = loadConfig(root);
    const dir = path.join(root, config.out);
    // A stand-in for the web build, so the project reads as built (its time is the newest build in the activity).
    const appIndex = path.join(dir, "app", "index.html");
    fs.mkdirSync(path.dirname(appIndex), { recursive: true });
    fs.writeFileSync(appIndex, `<!doctype html><title>fernwood</title><script>/* ${MEDIA_MARKER} */</script>`);
    const builtAt = new Date(now - 9 * 60000);
    fs.utimesSync(appIndex, builtAt, builtAt);

    const shotPng = (image, scheme) => path.join(ASSETS, "shots", `${image}-${scheme}.png`);
    const recorded = [];
    for (const r of [...RUNS].reverse()) {
      const screens = path.join(dir, "screens");
      fs.rmSync(screens, { recursive: true, force: true });
      fs.mkdirSync(screens, { recursive: true });
      const shots = [];
      const problems = [];
      for (const flow of CONFIG.flows) {
        for (const scheme of CONFIG.schemes) {
          const where = `${flow.name} / ${DEVICE} / ${scheme}`;
          const failure = (r.failures || []).find((f) => f.flow === flow.name && f.schemes.includes(scheme));
          let lastGoodShot = null;
          const notReached = [];
          flow.steps.forEach((step, i) => {
            if (!step.shot) return;
            if (failure && i + 1 > failure.step) { notReached.push(step.shot); return; }
            const [screen, route, kind] = SHOTS[flow.name][step.shot];
            const standIn = kind === "skia" && r.skia;
            const file = `screens/${flow.name}-${step.shot}-${DEVICE}-${scheme}.png`;
            fs.copyFileSync(shotPng(standIn ? `${screen}-standin` : screen, scheme), path.join(dir, file));
            shots.push({ file, flow: flow.name, shot: step.shot, device: DEVICE, platform: "ios", width: 393, height: 852, scheme, route, stubs: standIn ? ["skia"] : [] });
            lastGoodShot = file;
          });
          if (failure) {
            const file = `screens/${flow.name}-FAILED-${DEVICE}-${scheme}.png`;
            fs.copyFileSync(shotPng(failure.screen, scheme), path.join(dir, file));
            problems.push({ where, kind: "flow-failed", message: failure.message, file, flow: flow.name, device: DEVICE, scheme, step: failure.step, stepConfig: failure.stepConfig, lastGoodShot, notReached });
          }
          for (const e of (r.pageErrors || []).filter((e) => e.flow === flow.name && e.scheme === scheme)) {
            problems.push({ where, kind: "page-error", message: e.message, flow: flow.name, device: DEVICE, scheme });
          }
        }
      }
      const startedAt = at(r.ago);
      const finishedAt = new Date(Date.parse(startedAt) + r.minutes * 60000).toISOString();
      const manifest = { tool: "imitor", app: PACKAGE.name, commit: r.commit, generatedAt: finishedAt, renderer: "react-native-web in headless Chromium", shims: config.shims, shots, problems, notCovered: NOT_COVERED };
      const env = r.pr ? { GITHUB_REF: `refs/pull/${r.pr}/merge` } : {};
      const run = recordRun(dir, { root, config, manifest, startedAt, finishedAt, by: r.by, env, git: { branch: r.branch, commit: r.commit, subject: r.subject } });
      recorded.push({ run, seen: r.seen });
    }
    for (const { run, seen } of recorded) if (seen) for (const p of problemsOfRun(dir, run.id)) setSeen(dir, p.id, true);

    fs.mkdirSync(path.join(dir, "captures"), { recursive: true });
    for (const c of [...CAPTURES].reverse()) {
      const file = `captures/${c.file}.${c.kind === "video" ? "webm" : "png"}`;
      fs.copyFileSync(c.kind === "video" ? path.join(ASSETS, "videos", `${c.video}.webm`) : path.join(ASSETS, "shots", `${c.image}.png`), path.join(dir, file));
      appendCapture(dir, { kind: c.kind, file, route: c.route ?? null, flow: c.flow ?? null, device: DEVICE, scheme: c.scheme, by: c.by, at: at(c.ago), seconds: c.seconds ?? null, standIns: c.standIns || [] });
    }
    for (const [ago, by, tool, text, ok = true] of [...ACTIVITY].reverse()) appendActivity(dir, { at: at(ago), by, tool, text, ok });

    const newest = RUNS[0];
    return exportSite(root, { out, demo: true, git: { branch: newest.branch, commit: newest.commit } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const site = buildDemo();
  console.log(`demo: ${site.runs} runs, ${site.files} files, ${(site.bytes / 1024 / 1024).toFixed(1)} MB -> ${path.relative(process.cwd(), site.dir) || site.dir}`);
  if (site.missing.length) {
    console.error(`demo: ${site.missing.length} referenced files are missing, e.g. ${site.missing[0]}`);
    process.exitCode = 1;
  }
}
