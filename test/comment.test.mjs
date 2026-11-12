import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BODY_LIMIT, MARKER, buildComment, formatComment, imageUrl } from "../src/comment.mjs";

const BASE = "https://github.com/fern/fernwood/blob/imitor-shots/pr-7/abc1234/?raw=true";
const shot = (flow, name, step, extra = {}) => ({ file: `screens/${flow}-${name}-${extra.device || "iphone-16"}-${extra.scheme || "light"}.png`, flow, shot: name, step, device: "iphone-16", scheme: "light", stubs: [], ...extra });
const run = {
  app: "fernwood",
  commit: "abc1234",
  shots: [
    shot("water", "logged", 4),
    shot("first-run", "welcome", 1),
    shot("water", "today", 1, { stubs: ["skia"] }),
    shot("first-run", "home", 5),
    shot("first-run", "welcome", 1, { scheme: "dark" }),
    shot("first-run", "welcome", 1, { device: "pixel-9" }),
  ],
  problems: [],
};
const blocked = {
  ...run,
  problems: [{ kind: "flow-failed", where: "repot / iphone-16 / light", flow: "repot", device: "iphone-16", scheme: "light", step: 3, stepConfig: { tap: "Pick a pot" }, message: "locator.click: Timeout 10000ms exceeded.", file: "screens/repot-FAILED-iphone-16-light.png" }],
};

test("the comment starts with the marker and the verdict, then a counts line", () => {
  const pass = formatComment(buildComment(run, { imageBase: BASE }));
  const lines = pass.split("\n");
  assert.equal(lines[0], MARKER);
  assert.equal(lines[1], "### ✅ Imitor gate: passed");
  assert.match(lines[2], /^6 shots · 2 flows · 0 failed flows · 0 page errors · stand-ins in 1 shot \(skia\) · commit `abc1234`$/);
  assert.match(pass, /web imitation of the app .* not the native build/);
  const block = formatComment(buildComment(blocked, { imageBase: BASE }));
  assert.match(block.split("\n")[1], /^### ❌ Imitor gate: blocked: 1 flow failed$/);
  assert.match(block, /stand-in/);
  assert.equal(buildComment(run, { failOn: "stand-ins" }).verdict.passed, false);
});

test("shots are grouped by flow in run order, sorted by step, for the first configured device and scheme", () => {
  const data = buildComment(run, { imageBase: BASE, configured: { devices: ["iphone-16", "pixel-9"], schemes: ["light", "dark"] } });
  assert.deepEqual(data.showing.device, "iphone-16");
  assert.deepEqual(data.flows.map((f) => [f.name, f.shots.map((s) => s.step)]), [["water", ["today", "logged"]], ["first-run", ["welcome", "home"]]]);
  assert.equal(data.flows[1].elsewhere, 2);
  const md = formatComment(data);
  assert.ok(md.indexOf("#### water") < md.indexOf("#### first-run"));
  assert.ok(md.indexOf("water-today") < md.indexOf("water-logged"));
  assert.match(md, /Not shown: 2 shots on other devices or schemes/);
  // the full-size link and the thumbnail point at the same raw file
  assert.match(md, /<a href="https:\/\/github.com\/fern\/fernwood\/blob\/imitor-shots\/pr-7\/abc1234\/screens\/first-run-home-iphone-16-light.png\?raw=true"><img src="[^"]+\?raw=true" width="160" alt="first-run: home"><\/a><br><sub>home<\/sub>/);
  const dark = buildComment(run, { scheme: "dark", imageBase: BASE });
  assert.deepEqual(dark.flows.map((f) => f.shots.length), [0, 1]);
  assert.match(formatComment(dark), /No shots on iphone-16, dark/);
});

test("the per-flow cap says how many more shots exist", () => {
  const many = { shots: Array.from({ length: 15 }, (_, i) => shot("tour", `s${String(i + 1).padStart(2, "0")}`, i + 1)), problems: [] };
  const md = formatComment(buildComment(many, { imageBase: BASE }));
  assert.equal((md.match(/<img /g) || []).length, 12);
  assert.match(md, /Not shown: 3 more shots on iphone-16, light\. They are in the full report\./);
  assert.ok(!md.includes("s13"));
  assert.equal((formatComment(buildComment(many, { imageBase: BASE, maxShots: 4 })).match(/<img /g) || []).length, 4);
  assert.throws(() => buildComment(many, { maxShots: "0" }), /--max-shots needs a whole number/);
});

test("stand-ins and failed flows are called out, with the failure screenshot", () => {
  const md = formatComment(buildComment(blocked, { imageBase: BASE }));
  assert.match(md, /<sub>today<\/sub><br><sub>⚠︎ stand-in: skia<\/sub>/);
  assert.match(md, /\*\*Failed flows\*\*/);
  assert.match(md, /- \*\*repot on iphone-16, light\*\*: stopped at step 3 while tapping "Pick a pot"\. locator.click: Timeout 10000ms exceeded\./);
  assert.match(md, /<img src="[^"]+screens\/repot-FAILED-iphone-16-light.png\?raw=true" width="160" alt="Where repot on iphone-16, light stopped">/);
});

test("flow and step names are escaped for Markdown and HTML", () => {
  const evil = { shots: [shot("<b>x</b> *y* | [z](http://e.vil) @owner", '"><script>alert(1)</script>', 1, { stubs: ["<i>skia</i>"] })], problems: [] };
  const md = formatComment(buildComment(evil, { imageBase: BASE }));
  assert.ok(!md.includes("<script>"));
  assert.ok(!md.includes("<b>x</b>"));
  assert.ok(!md.includes("<i>skia</i>"));
  assert.ok(!md.includes("@owner"), "names must not mention anyone");
  assert.match(md, /#### &lt;b&gt;x&lt;\/b&gt; \\\*y\\\* \\\| \\\[z\\\]\(http:\/\/e.vil\) @⁠owner/);
  assert.match(md, /alt="[^"]*&quot;&gt;&lt;script&gt;/);
  // file names are URL-encoded in the image address
  assert.ok(md.includes("%3Cb%3Ex%3C/b%3E%20*y*%20%7C%20%5Bz%5D"));
  const table = formatComment(buildComment(evil, {}));
  assert.match(table, /\| "&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt; \| `screens\/<b>x<\/b> \*y\* \\\| /);
});

test("a large run stays under GitHub's comment size limit", () => {
  const shots = [];
  for (let f = 0; f < 300; f++) for (let s = 0; s < 40; s++) shots.push(shot(`flow-${f}-${"long".repeat(10)}`, `step-${s}-${"name".repeat(8)}`, s + 1, { stubs: s % 3 ? [] : ["skia"] }));
  const problems = Array.from({ length: 50 }, (_, i) => ({ kind: "flow-failed", flow: `flow-${i}`, device: "iphone-16", scheme: "light", step: 2, stepConfig: { tap: "x".repeat(500) }, message: "y".repeat(2000), file: `screens/flow-${i}-FAILED.png` }));
  const md = formatComment(buildComment({ shots, problems }, { imageBase: BASE }));
  assert.ok(md.length < BODY_LIMIT, `body is ${md.length} characters`);
  assert.ok(md.startsWith(MARKER));
  assert.match(md, /and 40 more failed flows in the full report/);
  assert.match(md, /more flows in the full report/);
  assert.match(md, /not the native build/);
  const plain = formatComment(buildComment({ shots, problems }, {}));
  assert.ok(plain.length < BODY_LIMIT);
});

test("without an image base the comment lists file paths in a table", () => {
  const md = formatComment(buildComment(blocked, {}));
  assert.ok(!md.includes("<img"));
  assert.match(md, /\| Step \| Shot \| Stand-in \|/);
  assert.match(md, /\| today \| `screens\/water-today-iphone-16-light.png` \| skia \|/);
  assert.match(md, /Screenshot: `screens\/repot-FAILED-iphone-16-light.png`/);
  assert.ok(!md.includes("tap one for full size"));
});

test("image URLs: prefix, path before a query string, or a {path} template", () => {
  assert.equal(imageUrl("https://h.example/run/", "screens/a b.png"), "https://h.example/run/screens/a%20b.png");
  assert.equal(imageUrl("https://h.example/run", "screens/a.png"), "https://h.example/run/screens/a.png");
  assert.equal(imageUrl(BASE, "screens/a#1.png"), "https://github.com/fern/fernwood/blob/imitor-shots/pr-7/abc1234/screens/a%231.png?raw=true");
  assert.equal(imageUrl("https://h.example/{path}?v=1", "screens/a.png"), "https://h.example/screens/a.png?v=1");
});

test("imitor comment reads the last run from the app folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-comment-"));
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify({ devices: ["pixel-9", "iphone-16"], schemes: ["light"] }));
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bin", "imitor.mjs");
  const none = spawnSync("node", [cli, "comment"], { cwd: root, encoding: "utf8" });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no run found/);
  fs.mkdirSync(path.join(root, "preview"));
  fs.writeFileSync(path.join(root, "preview", "manifest.json"), JSON.stringify(run));
  const md = spawnSync("node", [cli, "comment", "--image-base", "https://h.example/"], { cwd: root, encoding: "utf8" });
  assert.equal(md.status, 0, md.stderr);
  assert.match(md.stdout, /Shots\*\* on pixel-9, light/); // the first configured device that has shots
  const json = JSON.parse(spawnSync("node", [cli, "comment", "--json", "--device", "iphone-16", "--max-shots", "1"], { cwd: root, encoding: "utf8" }).stdout);
  assert.equal(json.marker, MARKER);
  assert.equal(json.showing.device, "iphone-16");
  assert.equal(json.flows[0].more, 1);
  assert.equal(json.imageBase, null);
});
