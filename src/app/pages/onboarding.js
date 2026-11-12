// Onboarding: three steps without the sidebar. 1 Add Imitor (agent prompt or by hand, and whether a build and a first
// run exist yet), 2 Stand-ins (read-only, from imitor.config.json), 3 First run (the latest run's first shots).
import { api, isStatic } from "../api.js";
import { html, raw, icon, logo, statusMark, chip, pill, seg, avatar, button, codeBlock, thumb, loadingLine, errorState } from "../components.js";
import { ago, deviceName, schemeName, humanize, stepLabel, plural } from "../format.js";
import { withBase } from "../base.js";

const STEPS = [
  { key: "add", path: "/onboarding", name: "Add Imitor" },
  { key: "stand-ins", path: "/onboarding/stand-ins", name: "Stand-ins" },
  { key: "first-run", path: "/onboarding/first-run", name: "First run" },
];
const REPO = "https://github.com/joseamijares/imitor";
const POLL_MS = 3000;

const PROMPT = `Set up Imitor (${REPO}) in this repo by following the "Set up" section of its README: install it and playwright, wrap the Metro config with withImitor, write imitor.config.json with a stand-in for each native-only module and a first flow, then run npx imitor and tell me what it found.`;

const KIND_TEXT = {
  sqljs: "Real SQLite in the browser (sql.js)",
  skia: "Keeps the box, draws nothing",
  canvaskit: "Real Skia drawing in the browser (CanvasKit)",
  inert: "Every export exists and does nothing",
};

export async function mount(ctx) {
  const { main, params } = ctx;
  const key = params.step || "add";
  const index = Math.max(0, STEPS.findIndex((s, i) => s.key === key || String(i + 1) === key));
  const step = STEPS[index];
  document.title = `${step.name} · Set up · Imitor`;
  main.classList.add("onb-main");
  main.innerHTML = String(html`${topBar(index)}<div class="onb-centre"><div class="onb-col">${loadingLine()}</div></div>`);
  const col = main.querySelector(".onb-col");
  if (step.key === "add") return stepAdd(ctx, col);
  if (step.key === "stand-ins") return stepStandIns(ctx, col);
  return stepFirstRun(ctx, col);
}

function topBar(current) {
  return html`<header class="onb-bar">
    <a class="onb-brand" href="${withBase(`/runs`)}" title="Runs">${logo(24)}<span class="wordmark">Imitor</span></a>
    <ol class="onb-steps" aria-label="Set up steps">${STEPS.map((s, i) => {
      const state = i < current ? "done" : i === current ? "now" : "next";
      return html`${i ? html`<li class="onb-line" aria-hidden="true"></li>` : ""}<li class="onb-step is-${raw(state)}">
        <a href="${withBase(s.path)}"${i === current ? raw(' aria-current="step"') : ""}><span class="onb-num" aria-hidden="true">${state === "done" ? icon("check", 11) : i + 1}</span>${s.name}</a></li>`;
    })}</ol>
    <a class="onb-skip" href="${withBase(`/runs`)}">Skip setup</a>
  </header>`;
}

const footer = (left, right) => html`<div class="onb-foot"><div class="onb-foot-note">${left}</div><div class="onb-foot-actions">${right}</div></div>`;

/* ---------- 1 Add Imitor ---------- */
async function stepAdd(ctx, col) {
  const name = (await ctx.projectReady(), ctx.projectName());
  if (!ctx.isCurrent()) return;
  let mode = ctx.url.searchParams.get("mode") === "hand" ? "hand" : "agent";
  let status = { kind: "loading" };

  function render() {
    col.className = "onb-col w560";
    col.innerHTML = String(html`
      <h1 class="onb-title">Add Imitor to your app</h1>
      <p class="onb-lede">${mode === "agent" ? `Hand one prompt to your coding agent. It installs Imitor in ${name} and runs the first preview.` : `Four steps in ${name}’s folder. The same ones the agent would take.`}</p>
      <div class="onb-mode">${seg("mode", [{ value: "agent", label: "With an agent" }, { value: "hand", label: "By hand" }], mode, "How to add Imitor")}</div>
      ${mode === "agent" ? agentPanel() : handPanel()}
      <div class="onb-status" role="status" aria-live="polite">${statusRow(status, name)}</div>
      ${footer(status.kind === "run" ? "The first run is here." : "Continue unlocks when the first run arrives.",
        html`${mode === "agent" ? html`<button type="button" class="btn btn-ghost" data-onb="hand">I’ll do it by hand</button>` : html`<button type="button" class="btn btn-ghost" data-onb="agent">Use an agent instead</button>`}
          ${status.kind === "run" ? button("Continue", "primary", { href: STEPS[1].path }) : html`<button type="button" class="btn btn-secondary" disabled title="Waiting for the first run">Continue</button>`}`)}`);
  }
  col.addEventListener("click", (e) => {
    const b = e.target.closest("[data-seg=mode] button");
    const o = e.target.closest("[data-onb]")?.dataset.onb;
    const next = b ? b.dataset.value : o;
    if (next !== "agent" && next !== "hand") return;
    mode = next;
    const u = new URL(location.href);
    mode === "hand" ? u.searchParams.set("mode", "hand") : u.searchParams.delete("mode");
    history.replaceState(null, "", u);
    render();
    col.querySelector(`[data-seg=mode] [data-value=${mode}]`)?.focus();
  });

  render();
  // Poll until the page is left: whether the preview is built, and whether a run exists.
  while (ctx.isCurrent()) {
    try {
      const [project, { runs }] = await Promise.all([api.project(), api.runs()]);
      status = runs.length ? { kind: "run", run: runs[0], count: runs.length } : project.built ? { kind: "built", at: project.builtAt } : { kind: "waiting" };
    } catch (e) {
      status = { kind: "error", message: e.message };
    }
    if (!ctx.isCurrent()) return;
    // The footer depends on whether the run is here: re-render everything only when that changes.
    if (status.kind === "run" || !col.querySelector(".onb-status")) render();
    else col.querySelector(".onb-status").innerHTML = String(statusRow(status, name));
    if (status.kind === "run") return; // nothing more to wait for
    if (isStatic) return; // an exported site never changes
    await new Promise((ok) => setTimeout(ok, POLL_MS));
  }
}

function agentPanel() {
  return html`<div class="onb-paste">
      <span class="onb-paste-label">Paste this into</span>
      <span class="onb-agent">${avatar("Claude Code")}Claude Code</span>
      <span class="onb-agent">${avatar("Cursor")}Cursor</span>
      <span class="onb-agent">${avatar("Codex")}Codex</span>
      <span class="onb-paste-hint t3">Run it from the app’s folder</span>
    </div>
    ${codeBlock([PROMPT])}
    <h2 class="onb-h2">Your agent will</h2>
    <ol class="onb-list">
      ${["Install Imitor and Playwright", "Wrap the Metro config", "Write imitor.config.json and pick a stand-in for each native-only module", "Run the first preview and report back"].map((t, i) => html`<li><span class="mono t3">${String(i + 1).padStart(2, "0")}</span>${t}</li>`)}
    </ol>`;
}

function handPanel() {
  const steps = [
    { title: "Install it, with Playwright and its Chromium", code: ["npm i -D imitor playwright", "npx playwright install chromium"] },
    { title: "Wrap your Metro config. It does nothing unless Imitor is running the build", code: ["// metro.config.js", 'module.exports = require("imitor/metro").withImitor(config);'] },
    { title: "Add imitor.config.json next to package.json: stand-ins, devices, schemes and flows", code: ["{", '  "shims": { "expo-sqlite": "sqljs", "@shopify/react-native-skia": "skia" },', '  "devices": ["iphone-16"],', '  "flows": [{ "name": "first-run", "start": "/", "steps": [{ "shot": "home" }] }]', "}"] },
    { title: "Run it in the app’s folder", code: ["npx imitor"] },
  ];
  return html`<ol class="onb-hand">${steps.map((s, i) => html`<li><div class="onb-hand-title"><span class="mono t3">${String(i + 1).padStart(2, "0")}</span>${s.title}</div>${codeBlock(s.code)}</li>`)}</ol>
    <p class="onb-more t3">The full list of stand-ins, flow steps and config keys is in the <a href="${REPO}#set-up" target="_blank" rel="noopener">README</a>.</p>`;
}

function statusRow(s, name) {
  if (s.kind === "run") {
    const r = s.run;
    return html`<div class="onb-status-row is-ok">${statusMark("ok", "Arrived")}<span>First run arrived: ${r.pr != null ? `#${r.pr} ` : ""}${r.title || r.id} · ${plural(r.shots ?? 0, "shot")}</span><span class="mono t3">${ago(r.finishedAt || r.startedAt)}</span></div>`;
  }
  if (s.kind === "built") return html`<div class="onb-status-row">${statusMark("progress", "Waiting")}<span>Preview built${s.at ? ` ${ago(s.at) === "now" ? "just now" : `${ago(s.at)} ago`}` : ""}. Waiting for the first run from ${name}…</span><span class="mono t3">listening</span></div>`;
  if (s.kind === "waiting") return html`<div class="onb-status-row">${statusMark("progress", "Waiting")}<span>No preview build yet. Waiting for the first run from ${name}…</span><span class="mono t3">listening</span></div>`;
  if (s.kind === "error") return html`<div class="onb-status-row is-bad">${statusMark("failed", "Error")}<span>${s.message}</span><span class="mono t3">retrying</span></div>`;
  return html`<div class="onb-status-row">${statusMark("progress", "Checking")}<span>Checking ${name} for a build and a run…</span><span class="mono t3">checking</span></div>`;
}

/* ---------- 2 Stand-ins ---------- */
async function stepStandIns(ctx, col) {
  let project;
  try { project = await api.project(); } catch (e) {
    if (ctx.isCurrent()) col.innerHTML = String(errorState("the project", e));
    return;
  }
  if (!ctx.isCurrent()) return;
  const list = project.standIns || [];
  col.className = "onb-col w760";
  col.innerHTML = String(html`
    <h1 class="onb-title">Choose stand-ins</h1>
    <p class="onb-lede">${list.length ? `${project.name} uses ${plural(list.length, "stand-in")} for native-only modules. ` : `${project.name} has no stand-ins yet. `}The choices live in <span class="mono">imitor.config.json</span> under <span class="mono">"shims"</span>: edit that file and rebuild to change them.</p>
    ${list.length ? html`<div class="onb-table" role="table" aria-label="Stand-ins">
      <div class="onb-tr onb-th" role="row"><span role="columnheader">Module</span><span role="columnheader">In the preview</span><span role="columnheader">Fidelity</span><span role="columnheader" class="right">Stand-in</span></div>
      ${list.map((s) => html`<div class="onb-tr" role="row">
        <span role="cell" class="mono t1" title="${s.module}">${s.module}</span>
        <span role="cell" class="t2">${KIND_TEXT[s.kind] || (/^\.{0,2}\//.test(s.kind) ? "Your own stand-in" : "Replaced for the web")}</span>
        <span role="cell">${s.fidelity === "genuine" ? pill("Genuine", "ok") : pill("Stand-in", "warn")}</span>
        <span role="cell" class="right">${chip(s.kind)}</span></div>`)}
    </div>` : html`<div class="onb-empty t2">Every module the app imports is bundled as it is. If the build fails on a native-only module, add it under <span class="mono">"shims"</span> with <span class="mono">"inert"</span>, <span class="mono">"skia"</span>, <span class="mono">"canvaskit"</span> or <span class="mono">"sqljs"</span>.</div>`}
    <p class="onb-footnote">${statusMark("standin", "Stand-in")}<span>Stand-ins only change the preview build. Your iOS and Android builds keep the real modules.</span></p>
    ${footer(button("Back", "ghost", { href: STEPS[0].path }), button("Continue", "primary", { href: STEPS[2].path }))}`);
}

/* ---------- 3 First run ---------- */
async function stepFirstRun(ctx, col) {
  let project, runs, detail = null;
  try {
    [project, { runs }] = await Promise.all([api.project(), api.runs()]);
    if (runs.length) detail = await api.run(runs[0].id);
  } catch (e) {
    if (ctx.isCurrent()) col.innerHTML = String(errorState("the first run", e));
    return;
  }
  if (!ctx.isCurrent()) return;
  col.className = "onb-col w720";
  if (!detail) {
    col.innerHTML = String(html`<h1 class="onb-title">First run</h1>
      <p class="onb-lede">No run yet in ${project.name}. Start one with <span class="mono">npx imitor</span>, or hand the prompt in step 1 to your agent; this page shows it when it arrives.</p>
      ${footer(button("Back to step 1", "ghost", { href: STEPS[0].path }), button("Connect an agent", "secondary", { href: "/agents", icon: "agents" }))}`);
    return;
  }
  const { run, flows } = detail;
  const flow = flows[0];
  const verb = { passed: "passed", "stand-ins": "passed with stand-ins", failed: "failed" }[flow?.status] || flow?.status;
  const shown = (flow?.steps || []).filter((s) => s.shot).slice(0, 5);
  const kinds = [...new Set(flows.flatMap((f) => f.steps.flatMap((s) => s.standIns || [])))];
  const seconds = (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000;
  const took = Number.isFinite(seconds) && seconds >= 0 ? (seconds >= 60 ? `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s` : `${Math.round(seconds)} s`) : null;
  const problems = run.problems ?? 0;
  const first = runs.length === 1;
  col.innerHTML = String(html`
    <h1 class="onb-title">First run</h1>
    <p class="onb-lede">${first ? `Your first preview of ${project.name} finished. Here is what Imitor captured.` : `${project.name} already has ${plural(runs.length, "run")}. Here is what the latest one captured.`}</p>
    ${flow ? html`<div class="onb-run-line">${statusMark(flow.status)}<span class="t1">Flow “${humanize(flow.name)}” ${verb}</span>${run.commit ? chip(run.commit) : ""}<span class="t2">${[deviceName(flow.device), schemeName(flow.scheme), took].filter(Boolean).join(" · ")}</span></div>
    <div class="onb-shots">${shown.map((s) => {
      const { num, label } = stepLabel(s);
      return html`<figure class="onb-shot">${thumb(s.shot, s.status, { small: true, alt: `${humanize(flow.name)}, ${num} ${label}` })}<figcaption><span class="mono t3">${num}</span>${label}</figcaption></figure>`;
    })}</div>` : html`<p class="t2">This run has no flows.</p>`}
    <p class="onb-counts"><span><b class="mono">${run.shots ?? 0}</b> shots</span><span class="dot" aria-hidden="true">•</span><span><b class="mono">${kinds.length}</b> ${kinds.length === 1 ? "stand-in" : "stand-ins"} used</span><span class="dot" aria-hidden="true">•</span><span class="${problems ? "bad" : ""}"><b class="mono">${problems}</b> ${problems === 1 ? "problem" : "problems"}</span></p>
    <p class="onb-limits">${statusMark("off", "Not shown")}<span><b>What it cannot show</b> ${(project.notCovered || []).join("; ")}.</span></p>
    ${footer("Agents can start runs like this one through the MCP server or CLI.", html`${button("Connect an agent", "secondary", { href: "/agents", icon: "agents" })}${button("Open the run", "primary", { href: `/runs/${encodeURIComponent(run.id)}` })}`)}`);
}
