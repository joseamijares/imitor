// Imitor app: the shell (sidebar and page frame), routes, and app-wide behaviour
// (theme, copy buttons, the shot lightbox, toasts, retry).
import { api, isDemo } from "./api.js";
import { createRouter } from "./router.js";
import { html, raw, icon, logo, navItem, toNode, safeUrl, demoPill } from "./components.js";
import * as runsPage from "./pages/runs.js";
import * as runPage from "./pages/run.js";
import * as problemsPage from "./pages/problems.js";
import * as capturesPage from "./pages/captures.js";
import * as agentsPage from "./pages/agents.js";
import * as settingsPage from "./pages/settings.js";
import * as placeholder from "./pages/placeholder.js";
import * as livePage from "./pages/live.js";
import * as onboardingPage from "./pages/onboarding.js";
import { withBase } from "./base.js";

const DOCS_URL = "https://github.com/joseamijares/imitor#readme";

const state = { project: null, projectError: null, openProblems: null };

const routes = [
  { path: "/", page: runsPage, nav: "runs" },
  { path: "/runs", page: runsPage, nav: "runs" },
  { path: "/runs/:id", page: runPage, nav: "runs" },
  { path: "/runs/:id/live", page: livePage, nav: null, bare: true },
  { path: "/runs/:id/:tab", page: runPage, nav: "runs" },
  { path: "/live", page: livePage, nav: null, bare: true },
  { path: "/problems", page: problemsPage, nav: "problems" },
  { path: "/problems/:id", page: problemsPage, nav: "problems" },
  { path: "/captures", page: capturesPage, nav: "captures" },
  { path: "/agents", page: agentsPage, nav: "agents" },
  { path: "/settings", page: settingsPage, nav: "settings" },
  { path: "/onboarding", page: onboardingPage, nav: null, bare: true },
  { path: "/onboarding/:step", page: onboardingPage, nav: null, bare: true },
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
  document.dispatchEvent(new CustomEvent("imitor:theme", { detail: t }));
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
    <div class="side-brand">${logo(24)}<span class="wordmark">Imitor</span>${isDemo ? demoPill() : ""}</div>
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
  // Full-width pages (live preview, onboarding) have no sidebar.
  app.classList.toggle("is-bare", !!current.bare);
  app.dataset.page = current.page || "";
  if (current.bare) { app.querySelector(".side")?.remove(); renderPhoneBars(); return; }
  const old = app.querySelector(".side");
  const node = toNode(sidebar());
  if (old) old.replaceWith(node); else app.prepend(node);
  renderThemeToggle();
  renderPhoneBars();
}

/* ---------- Phone: a top bar, a bottom tab bar and a "more" sheet in place of the sidebar ----------
   Always in the page; app.css shows them only below 700px wide (and hides the sidebar there). */
let sheetOpen = false;
const phoneTitle = () => document.title.replace(/\s*·\s*Imitor$/, "");

function phoneTop() {
  const p = state.project;
  const home = current.page === "/" || current.page === "/runs";
  return html`<header class="m-top">
    <a class="m-brand" href="${withBase(`/runs`)}" aria-label="Runs">${logo(24)}</a>
    ${home ? html`<span class="wordmark">Imitor</span><span class="m-divider" aria-hidden="true"></span>
      <button type="button" class="m-project" data-action="more" aria-haspopup="dialog" title="${p?.name || ""}"><span>${p?.name || (state.projectError ? "Project" : "…")}</span>${icon("down", 12)}</button>`
      : html`<span class="m-title">${phoneTitle()}</span>`}
    ${isDemo ? demoPill() : ""}
    <button type="button" class="m-more" data-action="more" aria-haspopup="dialog" aria-label="More: settings, docs, theme" title="More">${icon("more", 20)}</button>
  </header>`;
}

function phoneTabs() {
  const tab = (href, name, label, count) => {
    const on = current.nav === name;
    return html`<a class="m-tab${on ? " is-active" : ""}" href="${withBase(href)}"${on ? raw(' aria-current="page"') : ""}${count ? html` aria-label="${label}, ${count} open"` : ""}>
      <span class="m-tab-icon">${icon(name, 20)}${count ? html`<span class="m-count" aria-hidden="true">${count}</span>` : ""}</span><span class="m-tab-label">${label}</span></a>`;
  };
  return html`<nav class="m-tabs" aria-label="Pages">
    ${tab("/runs", "runs", "Runs")}${tab("/captures", "captures", "Captures")}${tab("/problems", "problems", "Problems", state.openProblems || null)}${tab("/agents", "agents", "Agents")}
  </nav>`;
}

function phoneSheet() {
  const p = state.project;
  const t = getTheme();
  return html`<div class="m-sheet${sheetOpen ? " is-open" : ""}" id="m-sheet"${sheetOpen ? "" : raw(" hidden")}>
    <div class="m-sheet-backdrop" data-action="more-close"></div>
    <div class="m-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="m-sheet-title">
      <div class="m-sheet-head"><span class="m-sheet-project"><span class="project-swatch" aria-hidden="true"></span><span id="m-sheet-title">${p?.name || "Imitor"}</span></span>
        <button type="button" class="m-icon-btn" data-action="more-close" aria-label="Close">${icon("close", 16)}</button></div>
      ${p ? html`<dl class="m-sheet-facts"><dt>Branch</dt><dd class="mono">${p.branch || "—"}</dd><dt>Commit</dt><dd class="mono">${p.commit || "—"}</dd><dt>Preview</dt><dd>${p.built ? "Built" : "Not built yet"}</dd></dl>` : ""}
      <nav class="m-sheet-nav" aria-label="More">
        <a class="m-sheet-item${current.nav === "settings" ? " is-active" : ""}" href="${withBase(`/settings`)}">${icon("settings")}<span>Settings</span>${icon("chevron", 14)}</a>
        <a class="m-sheet-item" href="${DOCS_URL}" target="_blank" rel="noopener">${icon("docs")}<span>Docs</span>${icon("external", 14)}</a>
      </nav>
      <div class="m-sheet-theme"><span>Theme</span>
        <div class="seg" role="group" aria-label="Theme" data-seg="m-theme">${THEMES.map((v) => html`<button type="button" data-value="${v}" aria-pressed="${v === t ? "true" : "false"}">${v === "system" ? "System" : v === "light" ? "Light" : "Dark"}</button>`)}</div></div>
    </div>
  </div>`;
}

function renderPhoneBars() {
  const parts = current.bare ? [] : [["m-top", phoneTop], ["m-tabs", phoneTabs], ["m-sheet", phoneSheet]];
  for (const cls of ["m-top", "m-tabs", "m-sheet"]) if (!parts.some(([c]) => c === cls)) app.querySelector(`:scope > .${cls}`)?.remove();
  for (const [cls, make] of parts) {
    const old = app.querySelector(`:scope > .${cls}`);
    const node = toNode(make());
    if (old) old.replaceWith(node); else app.append(node);
  }
}

function setSheet(open) {
  sheetOpen = open;
  const sheet = document.getElementById("m-sheet");
  if (!sheet) return;
  sheet.hidden = !open;
  sheet.classList.toggle("is-open", open);
  if (open) sheet.querySelector(".m-sheet-head [data-action=more-close]")?.focus();
  else document.querySelector(".m-top .m-more")?.focus({ preventScroll: true });
}

// The top bar names the page from its document title ("Problems · Imitor" -> "Problems").
new MutationObserver(() => { const el = app.querySelector(".m-top .m-title"); if (el) el.textContent = phoneTitle(); })
  .observe(document.querySelector("title"), { childList: true, characterData: true, subtree: true });
document.addEventListener("imitor:theme", () => {
  const t = getTheme();
  document.querySelectorAll("[data-seg=m-theme] button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === t)));
});

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
  current = { nav: route ? route.nav : null, bare: !!route?.bare, page: route?.path || "" };
  sheetOpen = false;
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
    refreshCounts, toast, copy, getTheme, setTheme,
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
// opts: { video: play the file in a <video controls> player, copyLink: add a "Copy link" button }
function openLightbox(src, alt, opts = {}) {
  const url = safeUrl(src);
  if (!url) return;
  closeLightbox();
  lastFocus = document.activeElement;
  const box = toNode(html`<div class="lightbox${opts.video ? " is-video" : ""}" role="dialog" aria-modal="true" aria-label="${alt || "Shot"}" data-action="lightbox-backdrop">
    ${opts.video ? html`<video src="${url}" controls autoplay playsinline preload="auto" aria-label="${alt || "Video"}"></video>` : html`<img src="${url}" alt="${alt || ""}">`}
    <div class="lightbox-bar"><span>${alt || ""}</span>
      ${opts.copyLink ? html`<button type="button" class="btn btn-secondary" data-copy="${location.origin + url}" data-copy-toast="Link copied">${icon("copy", 14)}Copy link</button>` : ""}
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
  if (shot) { openLightbox(shot.dataset.openShot, shot.dataset.alt, { video: shot.dataset.video === "1", copyLink: "copyLink" in shot.dataset }); return; }
  const action = t.closest("[data-action]")?.dataset.action;
  if (action === "theme") { const i = THEMES.indexOf(getTheme()); setTheme(THEMES[(i + 1) % THEMES.length]); return; }
  if (action === "retry") { router.resolve(); return; }
  if (action === "more") { setSheet(true); return; }
  if (action === "more-close" || t.closest(".m-sheet-item")) { setSheet(false); return; }
  const themeBtn = t.closest("[data-seg=m-theme] button");
  if (themeBtn) { setTheme(themeBtn.dataset.value); return; }
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
  if (sheetOpen) { setSheet(false); return; }
  const pop = document.getElementById("project-pop");
  if (pop && !pop.hidden) { pop.hidden = true; document.querySelector("[data-action=project]")?.focus(); }
});

/* ---------- Start ---------- */
app.textContent = "";
const projectReady = loadProject();
router.resolve();
refreshCounts();

