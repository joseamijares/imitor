// A run: tabs Shots, Live, Problems, Captures. Shots groups the run's shots by flow, filtered by device and scheme.
import { api } from "../api.js";
import { html, raw, icon, statusMark, chip, seg, pill, button, thumb, loadingLine, errorState } from "../components.js";
import { ago, deviceName, schemeName, humanize, stepLabel, plural } from "../format.js";
import { pageHeader } from "./common.js";

const TABS = ["shots", "live", "problems", "captures"];

export async function mount(ctx) {
  const { main, params } = ctx;
  const id = params.id;
  const tab = TABS.includes(params.tab) ? params.tab : "shots";
  const base = `/runs/${encodeURIComponent(id)}`;
  document.title = "Run · Imitor";
  main.innerHTML = String(html`${pageHeader(html`<a class="crumb" href="/runs">Runs</a><span class="sep">/</span><h1 class="t3">${id}</h1>`)}<div class="content">${loadingLine("Loading run…")}</div>`);

  let data;
  try { data = await api.run(id); } catch (e) {
    if (!ctx.isCurrent()) return;
    main.querySelector(".content").innerHTML = String(errorState(`run ${id}`, e));
    return;
  }
  if (!ctx.isCurrent()) return;

  const { run, flows = [], problems = [] } = data;
  const devices = data.devices?.length ? data.devices : [...new Set(flows.map((f) => f.device))];
  const schemes = data.schemes?.length ? data.schemes : [...new Set(flows.map((f) => f.scheme))];
  const q = ctx.url.searchParams;
  let device = devices.includes(q.get("device")) ? q.get("device") : devices[0];
  let scheme = schemes.includes(q.get("scheme")) ? q.get("scheme") : schemes[0];
  const title = `${run.pr != null ? `#${run.pr} ` : ""}${run.title || run.id}`;
  document.title = `${title} · Imitor`;

  const header = pageHeader(
    html`<a class="crumb" href="/runs">Runs</a><span class="sep">/</span><h1 title="${title}">${title}</h1>${run.commit ? chip(run.commit) : ""}`,
    html`${button("Copy link", "secondary", { icon: "copy", attrs: `data-copy="${escAttr(location.origin + base)}" data-copy-toast="Link copied"` })}
         ${button("Open live preview", "primary", { href: `${base}/live` })}`);
  main.innerHTML = String(html`${header}<div class="toolbar run-tabs"></div><div class="content"></div>`);
  const bar = main.querySelector(".run-tabs");
  const content = main.querySelector(".content");

  const visible = () => flows.filter((f) => f.device === device && f.scheme === scheme);
  // The count matches run.problems everywhere: failed steps and page errors. Stand-ins are listed in the tab but not counted.
  const failures = problems.filter((p) => p.kind !== "stand-in");
  const openProblems = failures.filter((p) => !p.seen).length;

  function renderBar() {
    // The run's total, the same number the Runs list and the live preview show (not just the device and scheme in view).
    const shots = run.shots ?? visible().reduce((n, f) => n + f.steps.length, 0);
    const t = (key, label, count, bad) => html`<a class="tab" href="${base}${key === "shots" ? "" : "/" + key}${key === "shots" ? query() : ""}"${key === tab ? raw(' aria-current="page"') : ""}>${label}${count != null ? html`<span class="count${bad ? " bad" : ""}">${count}</span>` : ""}</a>`;
    bar.innerHTML = String(html`<nav class="tabs" aria-label="Run">
        ${t("shots", "Shots", shots)}${t("live", "Live")}${t("problems", "Problems", failures.length || null, openProblems > 0)}${t("captures", "Captures")}
      </nav>
      ${tab === "shots" ? html`<div class="toolbar-group">
        ${seg("device", devices.map((d) => ({ value: d, label: deviceName(d) })), device, "Device")}
        ${seg("scheme", schemes.map((s) => ({ value: s, label: schemeName(s) })), scheme, "Scheme")}</div>` : ""}`);
  }

  function query() {
    const u = new URLSearchParams();
    if (device !== devices[0]) u.set("device", device);
    if (scheme !== schemes[0]) u.set("scheme", scheme);
    const s = u.toString();
    return s ? `?${s}` : "";
  }

  function renderShots() {
    const list = visible();
    if (!flows.length) { content.innerHTML = String(html`<div class="state"><h2>No shots in this run</h2><p>The run finished without taking any shots. Check the flows in imitor.config.json.</p></div>`); return; }
    if (!list.length) { content.innerHTML = String(html`<p class="placeholder-page">No flows ran on ${deviceName(device)} in the ${scheme} scheme.</p>`); return; }
    content.innerHTML = String(html`<div class="flows">${list.map(flowSection)}</div>`);
    content.querySelectorAll(".flows .tiles").forEach(edgeFade);
  }

  function render() {
    renderBar();
    if (tab === "shots") renderShots();
    else if (tab === "problems") content.innerHTML = String(problemsTab(problems));
    else if (tab === "live") content.innerHTML = String(html`<p class="placeholder-page">The live preview is coming next.</p>`);
    else content.innerHTML = String(html`<p class="placeholder-page">This run’s captures are coming next. Until then, see <a href="/captures" style="text-decoration:underline">Captures</a>.</p>`);
  }

  bar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-seg] button");
    if (!b) return;
    const which = b.closest("[data-seg]").dataset.seg;
    if (which === "device") device = b.dataset.value;
    if (which === "scheme") scheme = b.dataset.value;
    history.replaceState(null, "", base + query());
    render();
    bar.querySelector(`[data-seg=${which}] [aria-pressed=true]`)?.focus();
  });
  render();
}

// A flow's tile row scrolls sideways; fade the edge that has more tiles behind it.
function edgeFade(el) {
  const update = () => {
    const max = el.scrollWidth - el.clientWidth;
    el.classList.toggle("more-right", el.scrollLeft < max - 1);
    el.classList.toggle("more-left", el.scrollLeft > 1);
  };
  el.addEventListener("scroll", update, { passive: true });
  new ResizeObserver(update).observe(el);
  update();
}

// Attribute values passed through `attrs` are raw, so escape them here.
function escAttr(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

function flowSection(f) {
  const standIns = f.steps.filter((s) => s.status === "stand-in").length;
  const failed = f.steps.find((s) => s.status === "failed");
  const secs = typeof f.seconds === "number" ? `${f.seconds.toFixed(1)} s` : null;
  const meta = [failed ? `failed at step ${stepLabel(failed).num}` : standIns ? plural(standIns, "stand-in") : null, secs].filter(Boolean).join(" · ");
  return html`<section class="flow" aria-label="${humanize(f.name)}">
    <div class="flow-head">
      <div class="flow-title">${statusMark(f.status)}<h2>${humanize(f.name)}</h2><span class="mono t3">${plural(f.steps.length, "step")}</span></div>
      <span class="mono t3">${meta}</span>
    </div>
    <div class="tiles" role="region" tabindex="0" aria-label="${humanize(f.name)} shots, scroll sideways for more">${f.steps.map((s) => tile(f, s))}</div>
  </section>`;
}

function tile(f, s) {
  const { num, label } = stepLabel(s);
  const alt = `${humanize(f.name)}, ${num} ${label}`;
  const missing = s.status === "not-reached" || !s.shot;
  return html`<div class="tile${missing ? " is-missing" : ""}">
    ${thumb(s.shot, s.status, { alt })}
    <div class="tile-label"><span class="mono">${num}</span><span class="name" title="${label}">${label}</span></div>
    ${s.status === "stand-in" ? html`<span class="tile-pill" title="${s.standIns?.length ? `Stand-in: ${s.standIns.join(", ")}` : "Contains a stand-in"}">${pill("Stand-in", "warn")}</span>` : ""}
    ${s.status === "failed" ? html`<span class="tile-note">${icon("warn", 12)}Failed at this step</span>` : ""}
  </div>`;
}

function problemsTab(problems) {
  if (!problems.length) return html`<p class="placeholder-page">No problems in this run.</p>`;
  return html`<div class="run-problem-list">${problems.map((p) => html`<a class="problem-row" href="/problems/${encodeURIComponent(p.id)}">
      ${statusMark(p.kind === "flow-failed" ? "failed" : p.kind === "stand-in" ? "standin" : "off")}
      <div style="min-width:0"><div class="title">${p.title}</div><div class="sub">${[deviceName(p.device), schemeName(p.scheme)].filter(Boolean).join(" · ") || (p.detail?.shots?.length ? plural(p.detail.shots.length, "shot") : "")}</div></div>
      <div class="side-col"><span class="mono">${ago(p.at)}</span>${p.seen ? "" : html`<span class="unseen-dot" title="Not seen yet"></span>`}</div>
    </a>`)}</div>`;
}
