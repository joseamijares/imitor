// Problems: the list across recent runs with a detail pane. Open / Seen / All, Kind and Flow filters,
// "Mark as seen", and "Copy for agent" (a plain-text summary of the open problems).
import { api } from "../api.js";
import { html, raw, icon, statusMark, chip, seg, button, thumb, codeBlock, skeletonRows, errorState } from "../components.js";
import { ago, deviceName, schemeName, humanize, stepLabel } from "../format.js";
import { pageHeader } from "./common.js";

const SHOW = [{ value: "open", label: "Open" }, { value: "seen", label: "Seen" }, { value: "all", label: "All" }];
const KINDS = { "flow-failed": "Flow failed", "page-error": "Page error", "stand-in": "Stand-in" };
const markFor = (p) => (p.kind === "flow-failed" ? "failed" : p.kind === "stand-in" ? "standin" : "off");

export async function mount(ctx) {
  const { main, params } = ctx;
  document.title = "Problems · Imitor";
  const q = ctx.url.searchParams;
  let show = SHOW.some((s) => s.value === q.get("show")) ? q.get("show") : "all";
  let kind = q.get("kind") || "";
  let flow = q.get("flow") || "";
  let selected = params.id || null;

  main.innerHTML = String(html`${pageHeader(html`<h1>Problems</h1>`)}<div class="content">${skeletonRows(6)}</div>`);
  let problems;
  try { ({ problems } = await api.problems()); } catch (e) {
    if (!ctx.isCurrent()) return;
    main.querySelector(".content").innerHTML = String(errorState("problems", e));
    return;
  }
  if (!ctx.isCurrent()) return;

  const filtered = () => problems.filter((p) =>
    (show === "all" || (show === "open" ? !p.seen : p.seen)) && (!kind || p.kind === kind) && (!flow || p.detail?.flow === flow));

  function syncUrl() {
    const u = new URLSearchParams();
    if (show !== "all") u.set("show", show);
    if (kind) u.set("kind", kind);
    if (flow) u.set("flow", flow);
    const s = u.toString();
    history.replaceState(null, "", `/problems${selected ? "/" + encodeURIComponent(selected) : ""}${s ? "?" + s : ""}`);
  }

  function render() {
    const list = filtered();
    const open = problems.filter((p) => !p.seen);
    const current = list.find((p) => p.id === selected) || (selected ? problems.find((p) => p.id === selected) : null) || list[0] || null;
    const flows = [...new Set(problems.map((p) => p.detail?.flow).filter(Boolean))].sort();
    const kinds = [...new Set(problems.map((p) => p.kind))];

    main.innerHTML = String(html`
      ${pageHeader(html`<h1>Problems</h1><span class="mono t3">${list.length}</span>`, html`
        ${button("Mark all seen", "ghost", { attrs: `data-act="seen-all"`, disabled: !open.length })}
        ${button("Copy for agent", "secondary", { icon: "copy", attrs: `data-act="copy-open"`, disabled: !open.length, title: open.length ? "Copy the open problems as plain text" : "No open problems" })}`)}
      <div class="toolbar">
        ${seg("show", SHOW, show, "Show problems")}
        <div class="toolbar-group">
          <label class="select-ghost">Kind <select data-filter="kind"><option value="">Any</option>${kinds.map((k) => html`<option value="${k}"${k === kind ? raw(" selected") : ""}>${KINDS[k] || k}</option>`)}</select></label>
          <label class="select-ghost">Flow <select data-filter="flow"><option value="">Any</option>${flows.map((f) => html`<option value="${f}"${f === flow ? raw(" selected") : ""}>${humanize(f)}</option>`)}</select></label>
        </div>
      </div>
      ${problems.length ? html`<div class="split">
        <div class="problem-list" role="list">${list.length ? list.map((p) => row(p, p === current)) : html`<p class="placeholder-page">${show === "open" ? "No open problems." : "No problems match these filters."}</p>`}</div>
        <div class="problem-detail">${current ? detail(current) : html`<p class="detail-empty">Select a problem to see what happened.</p>`}</div>
      </div>` : html`<div class="state"><h2>No problems</h2><p>Nothing failed, errored or needed a new stand-in in the last 20 runs.</p></div>`}`);
    if (current) labelSteps(main, current, ctx);
  }

  async function setSeen(ids, seen) {
    try {
      await Promise.all(ids.map((id) => api.setSeen(id, seen)));
      for (const p of problems) if (ids.includes(p.id)) p.seen = seen;
      ctx.toast(ids.length > 1 ? `Marked ${ids.length} problems as seen` : seen ? "Marked as seen" : "Marked as open");
    } catch (e) {
      ctx.toast(`Couldn’t update: ${e.message}`);
    }
    if (!ctx.isCurrent()) return;
    render();
    ctx.refreshCounts();
  }

  main.addEventListener("click", async (e) => {
    const segBtn = e.target.closest("[data-seg=show] button");
    if (segBtn) { show = segBtn.dataset.value; syncUrl(); render(); main.querySelector("[data-seg=show] [aria-pressed=true]")?.focus(); return; }
    const rowEl = e.target.closest("[data-problem]");
    if (rowEl) {
      e.preventDefault();
      selected = rowEl.dataset.problem;
      syncUrl(); render();
      main.querySelector(`[data-problem="${CSS.escape(selected)}"]`)?.focus();
      return;
    }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "seen-all") return setSeen(problems.filter((p) => !p.seen).map((p) => p.id), true);
    if (act === "seen" || act === "unseen") return setSeen([e.target.closest("[data-act]").dataset.id], act === "seen");
    if (act === "copy-open" || act === "copy-one") {
      const list = act === "copy-one" ? problems.filter((p) => p.id === e.target.closest("[data-act]").dataset.id) : problems.filter((p) => !p.seen);
      const ok = await ctx.copy(agentText(list, ctx.projectName()));
      ctx.toast(ok ? `Copied ${list.length === 1 ? "1 problem" : `${list.length} problems`} for an agent` : "Couldn’t copy: the browser blocked the clipboard");
    }
  });
  main.addEventListener("change", (e) => {
    const f = e.target.dataset?.filter;
    if (f === "kind") kind = e.target.value;
    else if (f === "flow") flow = e.target.value;
    else return;
    syncUrl(); render();
    main.querySelector(`[data-filter=${f}]`)?.focus();
  });
  render();
}

const runRef = (r) => html`${r?.pr != null ? html`<span class="mono">#${r.pr}</span>` : ""}${r?.commit ? html`<span class="mono">${r.commit}</span>` : ""}`;

function row(p, active) {
  return html`<a role="listitem" class="problem-row${active ? " is-active" : ""}" href="/problems/${encodeURIComponent(p.id)}" data-problem="${p.id}"${active ? raw(' aria-current="true"') : ""}>
    ${statusMark(markFor(p), KINDS[p.kind])}
    <div style="min-width:0"><div class="title">${p.title}</div>
      <div class="sub">${runRef(p.run)}<span class="t3">·</span><span>${deviceName(p.device)} · ${schemeName(p.scheme)}</span></div></div>
    <div class="side-col"><span class="mono">${ago(p.at)}</span>${p.seen ? "" : html`<span class="unseen-dot" title="Not seen yet"></span>`}</div>
  </a>`;
}

function detail(p) {
  const d = p.detail || {};
  const run = p.run || {};
  const runHref = run.id ? `/runs/${encodeURIComponent(run.id)}` : null;
  const step = d.step != null ? String(d.step) : null;
  const shots = [];
  if (d.lastGoodShot) shots.push(html`<div class="detail-shot"><div class="label">Last good step<span class="t3" data-step-label="good"></span></div>${thumb(d.lastGoodShot, "ok", { alt: "Last good step" })}</div>`);
  if (d.failureShot) shots.push(html`<div class="detail-shot${p.kind === "flow-failed" ? " is-failed" : ""}"><div class="label">${p.kind === "flow-failed" ? "Where it stopped" : "Shot"}<span data-step-label="stop">${d.step != null ? `step ${d.step}` : ""}</span></div>${thumb(d.failureShot, p.kind === "flow-failed" ? "failed" : p.kind === "stand-in" ? "stand-in" : "ok", { alt: p.kind === "flow-failed" ? "Where it stopped" : "Shot" })}</div>`);

  const where = [d.flow ? `the flow ${humanize(d.flow)}` : null, step ? `step ${step}` : null].filter(Boolean).join(", ");
  const summary = {
    "flow-failed": `${where ? `${cap(where)} could not finish` : "The flow could not finish"} on ${deviceName(p.device)} in the ${p.scheme} scheme.${d.stepConfig ? ` The step was ${describeStep(d.stepConfig)}.` : ""}`,
    "page-error": `The page reported an error${where ? ` during ${where}` : ""} on ${deviceName(p.device)} in the ${p.scheme} scheme.`,
    "stand-in": d.message || "A stand-in replaced a native module on these shots.",
  }[p.kind] || d.message || "";

  const lines = [];
  if (p.kind !== "stand-in") {
    if (d.flow) lines.push({ text: `# flow ${d.flow}${step ? ` · step ${step}` : ""}`, tone: "dim" });
    if (d.stepConfig) lines.push(...yamlish(d.stepConfig).map((t) => ({ text: t })));
    if (d.message) { if (lines.length) lines.push({ text: "" }); String(d.message).split("\n").forEach((t, i) => lines.push({ text: i ? t : `Error: ${t}`, tone: "bad" })); }
  }

  return html`<div class="detail-title">${statusMark(markFor(p), KINDS[p.kind])}<h2>${p.title}</h2></div>
    <div class="detail-meta">
      <span>Run</span>${runHref ? html`<a href="${runHref}" class="t2" style="display:inline-flex;gap:6px">${runRef({ pr: run.pr })}<span>${run.title || run.id}</span></a>` : ""}${run.commit ? chip(run.commit) : ""}
      <span class="t3">·</span><span>${deviceName(p.device)} · ${schemeName(p.scheme)}</span><span class="t3">·</span><span>${ago(p.at)} ago</span>
      ${p.seen ? html`<span class="t3">·</span><span class="t3">Seen</span>` : ""}
    </div>
    <div class="detail-body">
      ${shots.length ? html`<div class="detail-shots">${shots}</div>` : ""}
      <div class="detail-section"><h3>What happened</h3><p>${summary}</p>${lines.length ? codeBlock(lines) : ""}</div>
      <div class="detail-actions">
        ${runHref ? button("Open the run", "secondary", { icon: "image", href: runHref }) : ""}
        ${button("Copy for agent", "secondary", { icon: "copy", attrs: `data-act="copy-one" data-id="${escAttr(p.id)}"` })}
        ${p.seen ? button("Mark as open", "ghost", { attrs: `data-act="unseen" data-id="${escAttr(p.id)}"` }) : button("Mark as seen", "ghost", { attrs: `data-act="seen" data-id="${escAttr(p.id)}"` })}
      </div>
    </div>`;
}

// Names the last good step and the step where a flow stopped, from the run's own step list.
const runCache = new Map();
async function labelSteps(main, p, ctx) {
  const d = p.detail || {};
  if (p.kind !== "flow-failed" || !p.run?.id || !d.flow) return;
  if (!runCache.has(p.run.id)) runCache.set(p.run.id, api.run(p.run.id).catch(() => null));
  const data = await runCache.get(p.run.id);
  if (!data || !ctx.isCurrent()) return;
  const f = (data.flows || []).find((x) => x.name === d.flow && x.device === p.device && x.scheme === p.scheme);
  const i = f ? f.steps.findIndex((s) => s.status === "failed") : -1;
  if (i < 0) return;
  const name = (s) => { const l = stepLabel(s); return `${l.num} ${l.label}`; };
  const good = f.steps.slice(0, i).reverse().find((s) => s.status === "ok" || s.status === "stand-in");
  const set = (k, text) => { const el = main.querySelector(`[data-step-label=${k}]`); if (el && text) el.textContent = text; };
  set("stop", name(f.steps[i]));
  if (good) set("good", name(good));
}

function escAttr(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** { tap: "Add 250 ml" } -> 'tap "Add 250 ml"'. */
function describeStep(cfg) {
  if (typeof cfg !== "object" || !cfg) return JSON.stringify(cfg);
  return Object.entries(cfg).map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : JSON.stringify(String(v))}`).join(", ");
}

/** A step's config as YAML-like lines, for reading only. */
function yamlish(v, indent = "") {
  if (v == null || typeof v !== "object") return [`${indent}${JSON.stringify(v)}`];
  return Object.entries(v).flatMap(([k, val]) =>
    val && typeof val === "object" ? [`${indent}${k}:`, ...yamlish(val, indent + "  ")] : [`${indent}${k}: ${typeof val === "string" ? JSON.stringify(val) : String(val)}`]);
}

/** Plain-text summary for pasting into an agent's prompt. */
export function agentText(list, project) {
  const origin = location.origin;
  const head = list.length === 1 ? `Imitor problem in ${project}:` : `Imitor: ${list.length} open problems in ${project}.`;
  const items = list.map((p, i) => {
    const d = p.detail || {};
    const r = p.run || {};
    const out = [`${i + 1}. ${p.title}`,
      `   Kind: ${p.kind}. Device: ${p.device}, scheme: ${p.scheme}.`,
      `   Run: ${r.pr != null ? `#${r.pr} ` : ""}${r.commit || ""} "${r.title || r.id || ""}" (${r.id || "unknown run"})`];
    if (d.flow) out.push(`   Flow: ${d.flow}${d.step != null ? `, step ${d.step}` : ""}${d.stepConfig ? `: ${JSON.stringify(d.stepConfig)}` : ""}`);
    if (d.message) out.push(`   ${p.kind === "stand-in" ? "Note" : "Error"}: ${String(d.message).replace(/\n\s*/g, " ")}`);
    if (d.lastGoodShot) out.push(`   Last good shot: ${origin}${d.lastGoodShot}`);
    if (d.failureShot) out.push(`   ${p.kind === "flow-failed" ? "Failure shot" : "Shot"}: ${origin}${d.failureShot}`);
    return out.join("\n");
  });
  return [head, "", items.join("\n\n"), "", "Reproduce with the Imitor MCP tools or `npx imitor`, fix the cause, then run Imitor again."].join("\n");
}
