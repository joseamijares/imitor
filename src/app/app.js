// Imitor app: the shell (sidebar and page frame), routes, and app-wide behaviour
// (theme, copy buttons, the shot lightbox, toasts, retry).
import { api } from "./api.js";
import { createRouter } from "./router.js";
import { html, icon, logo, navItem, toNode, safeUrl } from "./components.js";
import * as runsPage from "./pages/runs.js";
import * as runPage from "./pages/run.js";
import * as problemsPage from "./pages/problems.js";
import * as placeholder from "./pages/placeholder.js";

const DOCS_URL = "https://github.com/joseamijares/imitor#readme";

const state = { project: null, projectError: null, openProblems: null };

const routes = [
  { path: "/", page: runsPage, nav: "runs" },
  { path: "/runs", page: runsPage, nav: "runs" },
  { path: "/runs/:id", page: runPage, nav: "runs" },
  { path: "/runs/:id/:tab", page: runPage, nav: "runs" },
  { path: "/problems", page: problemsPage, nav: "problems" },
  { path: "/problems/:id", page: problemsPage, nav: "problems" },
  { path: "/captures", page: placeholder, nav: "captures", title: "Captures", line: "Captures are coming next: screenshots and videos taken by agents and people will be listed here." },
  { path: "/agents", page: placeholder, nav: "agents", title: "Agents", line: "Agents are coming next: connect commands, tool switches and recent agent activity." },
  { path: "/settings", page: placeholder, nav: "settings", title: "Settings", line: "Settings are coming next." },
  { path: "/onboarding", page: placeholder, nav: null, title: "Add Imitor", line: "Onboarding is coming next." },
  { path: "/onboarding/:step", page: placeholder, nav: null, title: "Add Imitor", line: "Onboarding is coming next." },
];

/* ---------- Theme: follows the system unless the person picked one ---------- */
const THEMES = ["system", "light", "dark"];
function getTheme() {
  try { const t = localStorage.getItem("imitor.theme"); return THEMES.includes(t) ? t : "system"; } catch { return "system"; }
}
function setTheme(t) {
  try { t === "system" ? localStorage.removeItem("imitor.theme") : localStorage.setItem("imitor.theme", t); } catch { /* storage blocked */ }
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  renderThemeToggle();
}
function renderThemeToggle() {
  const b = document.querySelector("[data-action=theme]");
  if (!b) return;
  const t = getTheme();
  const next = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
  const label = `Theme: ${t === "system" ? "follows the system" : t}. Switch to ${next === "system" ? "the system setting" : next}.`;
  b.innerHTML = String(icon(t === "light" ? "sun" : t === "dark" ? "moon" : "auto", 14));
  b.title = label;
  b.setAttribute("aria-label", label);
}

/* ---------- Shell ---------- */
const app = document.getElementById("app");
let current = { nav: null };

function sidebar() {
  const nav = current.nav;
  const p = state.project;
  const name = p?.name || (state.projectError ? "Project" : "…");
  return html`<aside class="side" aria-label="Main">
    <div class="side-brand">${logo(24)}<span class="wordmark">Imitor</span></div>
    <div class="project">
      <button type="button" class="project-button" data-action="project" aria-expanded="false" aria-controls="project-pop" title="${name}">
        <span class="project-swatch" aria-hidden="true"></span><span class="project-name">${name}</span>${icon("down", 12)}
      </button>
      <div class="project-pop" id="project-pop" hidden>${p ? html`<dl>
        <dt>Project</dt><dd>${p.name}</dd>
        <dt>Branch</dt><dd>${p.branch || "—"}</dd>
        <dt>Commit</dt><dd class="mono">${p.commit || "—"}</dd>
        <dt>Preview</dt><dd>${p.built ? "Built" : "Not built yet"}</dd></dl>` : html`<span>${state.projectError ? `Couldn’t load the project: ${state.projectError}` : "Loading…"}</span>`}</div>
    </div>
    <nav class="side-nav" aria-label="Pages">
      ${navItem({ href: "/runs", iconName: "runs", label: "Runs", active: nav === "runs" })}
      ${navItem({ href: "/captures", iconName: "captures", label: "Captures", active: nav === "captures" })}
      ${navItem({ href: "/problems", iconName: "problems", label: "Problems", active: nav === "problems", count: state.openProblems || null })}
      ${navItem({ href: "/agents", iconName: "agents", label: "Agents", active: nav === "agents" })}
    </nav>
    <div class="side-foot">
      ${navItem({ href: "/settings", iconName: "settings", label: "Settings", active: nav === "settings" })}
      <div class="side-foot-row">${navItem({ href: DOCS_URL, iconName: "docs", label: "Docs", external: true })}<button type="button" class="theme-toggle" data-action="theme"></button></div>
    </div>
  </aside>`;
}

function renderSidebar() {
  const old = app.querySelector(".side");
  const node = toNode(sidebar());
  if (old) old.replaceWith(node); else app.prepend(node);
  renderThemeToggle();
}

async function loadProject() {
  try { state.project = await api.project(); state.projectError = null; }
  catch (e) { state.projectError = e.message; }
  renderSidebar();
}

async function refreshCounts() {
  try {
    const { problems } = await api.problems();
    state.openProblems = problems.filter((p) => !p.seen).length;
  } catch { /* keep the last count */ }
  renderSidebar();
}

/* ---------- Routing ---------- */
let generation = 0;
const router = createRouter(routes, (m, url) => {
  const gen = ++generation;
  const route = m?.route;
  current = { nav: route ? route.nav : null };
  renderSidebar();
  const main = document.createElement("main");
  main.className = "main";
  main.id = "main";
  const old = app.querySelector(".main");
  if (old) old.replaceWith(main); else app.append(main);
  closeLightbox();
  const ctx = {
    main, url, params: m?.params || {}, route, state,
    isCurrent: () => gen === generation,
    navigate: router.navigate,
    reload: () => router.resolve(),
    refreshCounts, toast, copy,
    projectName: () => state.project?.name || "this project",
    projectReady: () => projectReady,
  };
  if (!route) return placeholder.mount({ ...ctx, route: { title: "Not found", line: `There is no page at ${url.pathname}.` } });
  route.page.mount(ctx);
});

/* ---------- App-wide behaviour ---------- */
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* unsupported */ }
    ta.remove();
    return ok;
  }
}

let toastTimer;
function toast(message) {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.append(t); }
  t.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2400);
}

let lastFocus = null;
function openLightbox(src, alt) {
  const url = safeUrl(src);
  if (!url) return;
  closeLightbox();
  lastFocus = document.activeElement;
  const box = toNode(html`<div class="lightbox" role="dialog" aria-modal="true" aria-label="${alt || "Shot"}" data-action="lightbox-backdrop">
    <img src="${url}" alt="${alt || ""}">
    <div class="lightbox-bar"><span>${alt || ""}</span>
      <a class="btn btn-secondary" href="${url}" target="_blank" rel="noopener">${icon("external", 14)}Open in new tab</a>
      <button type="button" class="btn btn-secondary" data-action="lightbox-close">${icon("close", 14)}Close</button></div>
  </div>`);
  document.body.append(box);
  box.querySelector("[data-action=lightbox-close]").focus();
}
function closeLightbox() {
  const box = document.querySelector(".lightbox");
  if (!box) return;
  box.remove();
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  lastFocus = null;
}

document.addEventListener("click", async (e) => {
  const t = e.target;
  const copyBtn = t.closest("[data-copy]");
  if (copyBtn) {
    const ok = await copy(copyBtn.dataset.copy);
    copyBtn.classList.toggle("is-done", ok);
    toast(ok ? copyBtn.dataset.copyToast || "Copied" : "Couldn’t copy: the browser blocked the clipboard");
    setTimeout(() => copyBtn.classList.remove("is-done"), 1200);
    return;
  }
  const shot = t.closest("[data-open-shot]");
  if (shot) { openLightbox(shot.dataset.openShot, shot.dataset.alt); return; }
  const action = t.closest("[data-action]")?.dataset.action;
  if (action === "theme") { const i = THEMES.indexOf(getTheme()); setTheme(THEMES[(i + 1) % THEMES.length]); return; }
  if (action === "retry") { router.resolve(); return; }
  if (action === "lightbox-close" || (action === "lightbox-backdrop" && t.classList.contains("lightbox"))) { closeLightbox(); return; }
  if (action === "project") {
    const b = t.closest("[data-action=project]");
    const pop = document.getElementById("project-pop");
    const open = pop.hidden;
    pop.hidden = !open;
    b.setAttribute("aria-expanded", String(open));
    return;
  }
  // Clicking anywhere else closes the project popover.
  const pop = document.getElementById("project-pop");
  if (pop && !pop.hidden && !t.closest(".project")) { pop.hidden = true; document.querySelector("[data-action=project]")?.setAttribute("aria-expanded", "false"); }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (document.querySelector(".lightbox")) { closeLightbox(); return; }
  const pop = document.getElementById("project-pop");
  if (pop && !pop.hidden) { pop.hidden = true; document.querySelector("[data-action=project]")?.focus(); }
});

/* ---------- Start ---------- */
app.textContent = "";
const projectReady = loadProject();
router.resolve();
refreshCounts();

