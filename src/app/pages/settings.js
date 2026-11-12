// Settings: what Imitor knows about this project, read-only (from GET /api/project), and the app's
// appearance. There is no settings API: the preview configuration lives in imitor.config.json.
import { api } from "../api.js";
import { html, seg, pill, chip, skeletonRows, errorState } from "../components.js";
import { deviceName, schemeName, humanize, plural } from "../format.js";
import { pageHeader } from "./common.js";

const SECTIONS = [
  { id: "project", label: "Project" },
  { id: "devices", label: "Devices" },
  { id: "flows", label: "Flows" },
  { id: "stand-ins", label: "Stand-ins" },
  { id: "appearance", label: "Appearance" },
];
const THEMES = [{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }];
const CONFIG_NOTE = html`These come from <span class="mono">imitor.config.json</span> in the app’s folder. Edit that file to change them.`;

export async function mount(ctx) {
  const { main } = ctx;
  document.title = "Settings · Imitor";
  main.innerHTML = String(html`${pageHeader(html`<h1>Settings</h1>`)}<div class="content">${skeletonRows(6)}</div>`);

  let p;
  try { p = await api.project(); } catch (e) {
    if (!ctx.isCurrent()) return;
    main.querySelector(".content").innerHTML = String(errorState("the project", e));
    return;
  }
  if (!ctx.isCurrent()) return;

  const row = (label, value, sub) => html`<div class="set-row"><div class="set-label"><span>${label}</span>${sub ? html`<span class="set-sub">${sub}</span>` : ""}</div><div class="set-value">${value}</div></div>`;
  const devices = p.devices || [];
  const flows = p.flows || [];
  const standIns = p.standIns || [];
  const schemes = p.schemes || [];

  main.innerHTML = String(html`${pageHeader(html`<h1>Settings</h1>`)}
  <div class="content settings">
    <nav class="set-nav" aria-label="Settings sections">${SECTIONS.map((s, i) => html`<a href="#${s.id}" data-section="${s.id}"${i === 0 ? html` aria-current="true"` : ""}>${s.label}</a>`)}</nav>
    <div class="set-body">
      <section id="project" class="set-section" aria-labelledby="project-h">
        <h2 id="project-h">Project</h2>
        <p class="set-note">Read from the app’s folder and its git checkout when <span class="mono">imitor app</span> started.</p>
        ${row("Name", p.name || "—")}
        ${row("Branch", p.branch ? html`<span class="mono">${p.branch}</span>` : "—")}
        ${row("Commit", p.commit ? chip(p.commit) : "—")}
        ${row("Preview", p.built ? pill("Built", "ok") : pill("Not built yet", "neutral"), p.built ? "The web build that runs, shots and the live preview use" : html`Run <span class="mono">npx imitor build</span> to build it`)}
      </section>

      <section id="devices" class="set-section" aria-labelledby="devices-h">
        <h2 id="devices-h">Devices and schemes</h2>
        <p class="set-note">${CONFIG_NOTE} The configured devices come first, then the built-in ones.</p>
        ${devices.map((d) => row(deviceName(d.name), html`<span class="mono t2">${d.width} × ${d.height}</span>`, html`<span class="mono">${d.name}</span>${d.platform ? ` · ${d.platform === "ios" ? "iOS" : d.platform === "android" ? "Android" : d.platform}` : ""}`))}
        ${row("Schemes", schemes.length ? html`<span class="set-chips">${schemes.map((s) => chip(schemeName(s)))}</span>` : "—", "Flows run once per scheme")}
      </section>

      <section id="flows" class="set-section" aria-labelledby="flows-h">
        <h2 id="flows-h">Flows</h2>
        <p class="set-note">${CONFIG_NOTE}</p>
        ${flows.length ? flows.map((f) => {
          const shots = (f.steps || []).filter((s) => s.action === "shot").length;
          return row(humanize(f.name), html`<span class="mono t2">${plural(shots, "shot")} · ${plural((f.steps || []).length, "step")}</span>`, html`<span class="mono">${f.name}</span>${f.start ? html` · starts at <span class="mono">${f.start}</span>` : ""}`);
        }) : html`<p class="set-empty">No flows configured yet.</p>`}
      </section>

      <section id="stand-ins" class="set-section" aria-labelledby="stand-ins-h">
        <h2 id="stand-ins-h">Stand-ins</h2>
        <p class="set-note">${CONFIG_NOTE} A stand-in replaces a native-only module so the app runs on the web; what it draws is not like the real app.</p>
        ${standIns.length ? standIns.map((s) => row(html`<span class="mono">${s.module}</span>`, s.fidelity === "genuine" ? pill("Genuine", "ok") : pill("Stand-in", "warn"), s.fidelity === "genuine" ? `${s.kind}: the real code, running on the web` : `${s.kind}: not drawn like the real app`))
          : html`<p class="set-empty">No stand-ins: every module this app uses runs on the web.</p>`}
        ${p.notCovered?.length ? html`<div class="set-row set-row-top"><div class="set-label"><span>Never shown</span><span class="set-sub">An imitation can’t show these, whatever the configuration</span></div>
          <ul class="set-list">${p.notCovered.map((n) => html`<li>${n}</li>`)}</ul></div>` : ""}
      </section>

      <section id="appearance" class="set-section" aria-labelledby="appearance-h">
        <h2 id="appearance-h">Appearance</h2>
        ${row("Theme", seg("theme", THEMES, ctx.getTheme(), "Theme"), "System follows this computer’s setting. Saved in this browser.")}
      </section>
    </div>
  </div>`);

  const content = main.querySelector(".settings");
  const nav = main.querySelector(".set-nav");
  const setCurrent = (id) => nav.querySelectorAll("a").forEach((a) => (a.dataset.section === id ? a.setAttribute("aria-current", "true") : a.removeAttribute("aria-current")));

  let lockUntil = 0;
  nav.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-section]");
    if (!a) return;
    e.preventDefault();
    const target = main.querySelector(`#${CSS.escape(a.dataset.section)}`);
    target.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    target.querySelector("h2").setAttribute("tabindex", "-1");
    target.querySelector("h2").focus({ preventScroll: true });
    setCurrent(a.dataset.section);
    lockUntil = Date.now() + 1000; // keep the clicked section highlighted while the smooth scroll runs
    history.replaceState(null, "", `#${a.dataset.section}`);
  });
  // Highlight the section at the top of the scroll area.
  content.addEventListener("scroll", () => {
    if (Date.now() < lockUntil) return;
    const top = content.getBoundingClientRect().top + 40;
    let id = SECTIONS[0].id;
    for (const s of SECTIONS) { const el = main.querySelector(`#${s.id}`); if (el && el.getBoundingClientRect().top <= top) id = s.id; }
    if (content.scrollTop + content.clientHeight >= content.scrollHeight - 4) id = SECTIONS[SECTIONS.length - 1].id;
    setCurrent(id);
  }, { passive: true });

  main.querySelector("[data-seg=theme]").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    ctx.setTheme(b.dataset.value);
  });
  const syncTheme = () => {
    if (!ctx.isCurrent()) { document.removeEventListener("imitor:theme", syncTheme); return; }
    const t = ctx.getTheme();
    main.querySelectorAll("[data-seg=theme] button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === t)));
  };
  document.addEventListener("imitor:theme", syncTheme);

  const hash = location.hash.slice(1);
  if (SECTIONS.some((s) => s.id === hash)) { main.querySelector(`#${hash}`).scrollIntoView({ block: "start" }); setCurrent(hash); }
}
