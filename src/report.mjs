import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NOT_COVERED } from "./config.mjs";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function commit(root) {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

export function writeReport(root, config, result) {
  const outDir = path.join(root, config.out);
  const app = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name || path.basename(root);
  const manifest = {
    tool: "imitor",
    app,
    commit: commit(root),
    generatedAt: new Date().toISOString(),
    renderer: "react-native-web in headless Chromium",
    shims: config.shims,
    shots: result.shots,
    problems: result.problems,
    notCovered: NOT_COVERED,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const groups = new Map();
  for (const s of result.shots) {
    const key = `${s.flow} · ${s.shot}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const sections = [...groups].map(([title, shots]) => `
    <section><h2>${esc(title)}</h2><div class="row">${shots.map((s) => `
      <figure><a href="${esc(s.file)}"><img loading="lazy" src="${esc(s.file)}" width="${s.width}" height="${s.height}" alt="${esc(title)} ${esc(s.device)} ${esc(s.scheme)}"></a>
      <figcaption>${esc(s.device)} · ${esc(s.scheme)}${s.stubs.length ? ` <span class="warn">stand-in: ${esc(s.stubs.join(", "))}</span>` : ""}</figcaption></figure>`).join("")}
    </div></section>`).join("");
  const problems = result.problems.length ? `<section><h2>Problems (${result.problems.length})</h2><ul class="problems">${result.problems.map((p) => `<li><b>${esc(p.kind)}</b> ${esc(p.where)}: ${esc(p.message)}</li>`).join("")}</ul></section>` : "";

  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(app)} preview</title>
<style>
:root{color-scheme:light dark;--bg:#f6f6f4;--fg:#1c1c1a;--mut:#6b6b66;--line:#deded9;--warn:#9a5b00}
@media(prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecece8;--mut:#9a9a93;--line:#2e2e2b;--warn:#e0a44a}}
body{margin:0;padding:24px 16px 64px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1200px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:32px 0 12px;padding-top:16px;border-top:1px solid var(--line)}
.meta,figcaption{color:var(--mut);font-size:13px}.row{display:flex;gap:16px;overflow-x:auto;padding-bottom:8px}
figure{margin:0;flex:none}img{display:block;width:240px;height:auto;border-radius:22px;border:1px solid var(--line)}
figcaption{margin-top:6px;max-width:240px}.warn{color:var(--warn)}.problems{padding-left:18px;font-size:13px}
details{margin-top:12px;font-size:13px;color:var(--mut)}
</style><main>
<h1>${esc(app)} preview</h1>
<div class="meta">${manifest.commit ? `commit ${esc(manifest.commit)} · ` : ""}${esc(manifest.generatedAt)} · ${result.shots.length} shots · rendered on web, not on a phone</div>
<details><summary>What this does not show</summary><ul>${NOT_COVERED.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>
${problems}${sections}
</main></html>`;
  fs.writeFileSync(path.join(outDir, "index.html"), html);
  return manifest;
}
