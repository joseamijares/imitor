// Settings: what Imitor knows about this project, read-only (from GET /api/project), and the app's
// appearance. There is no settings API: the preview configuration lives in imitor.config.json.
// In Imitor Cloud the project is what its newest run says, and three more sections appear: the project's upload keys
// (made, listed and revoked here; a new key is shown once), its members (added by address and removed by owners) and
// the signed-in account.
import { api, cloud, CLOUD_PAGES, isCloud, isStatic } from "../api.js";
import { html, seg, pill, chip, button, codeBlock, skeletonRows, errorState } from "../components.js";
import { ago, deviceName, schemeName, humanize, plural } from "../format.js";
import { pageHeader } from "./common.js";

const SECTIONS = isCloud ? [
  { id: "project", label: "Project" },
  { id: "devices", label: "Devices" },
  { id: "flows", label: "Flows" },
  { id: "access-keys", label: "Access keys" },
  { id: "members", label: "Members" },
  { id: "account", label: "Account" },
  { id: "appearance", label: "Appearance" },
] : [
  { id: "project", label: "Project" },
  { id: "devices", label: "Devices" },
  { id: "flows", label: "Flows" },
  { id: "stand-ins", label: "Stand-ins" },
  { id: "appearance", label: "Appearance" },
];
const THEMES = [{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }];
const CONFIG_NOTE = isCloud
  ? html`These come from the newest run pushed to this project. Edit <span class="mono">imitor.config.json</span> in the app’s folder to change them for the next run.`
  : html`These come from <span class="mono">imitor.config.json</span> in the app’s folder. Edit that file to change them.`;
const PROJECT_NOTE = isCloud
  ? "The branch and commit of the newest run pushed to this project."
  : isStatic ? "Read from the app’s folder and its git checkout when this site was exported." : html`Read from the app’s folder and its git checkout when <span class="mono">imitor app</span> started.`;

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
        <p class="set-note">${PROJECT_NOTE}</p>
        ${row("Name", p.name || "—")}
        ${row("Branch", p.branch ? html`<span class="mono">${p.branch}</span>` : "—")}
        ${row("Commit", p.commit ? chip(p.commit) : "—")}
        ${isCloud ? row("Live preview", pill("Not in the cloud", "neutral"), "Imitor Cloud keeps runs and their shots, not a build of the app")
          : row("Preview", p.built ? pill("Built", "ok") : pill("Not built yet", "neutral"), p.built ? "The web build that runs, shots and the live preview use" : html`Run <span class="mono">npx imitor build</span> to build it`)}
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

      ${isCloud ? cloudSections() : html`<section id="stand-ins" class="set-section" aria-labelledby="stand-ins-h">
        <h2 id="stand-ins-h">Stand-ins</h2>
        <p class="set-note">${CONFIG_NOTE} A stand-in replaces a native-only module so the app runs on the web; what it draws is not like the real app.</p>
        ${standIns.length ? standIns.map((s) => row(html`<span class="mono">${s.module}</span>`, s.fidelity === "genuine" ? pill("Genuine", "ok") : pill("Stand-in", "warn"), s.fidelity === "genuine" ? `${s.kind}: the real code, running on the web` : `${s.kind}: not drawn like the real app`))
          : html`<p class="set-empty">No stand-ins: every module this app uses runs on the web.</p>`}
        ${p.notCovered?.length ? html`<div class="set-row set-row-top"><div class="set-label"><span>Never shown</span><span class="set-sub">An imitation can’t show these, whatever the configuration</span></div>
          <ul class="set-list">${p.notCovered.map((n) => html`<li>${n}</li>`)}</ul></div>` : ""}
      </section>`}

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

  if (isCloud) mountCloud(ctx, main);

  const hash = location.hash.slice(1);
  if (SECTIONS.some((s) => s.id === hash)) { main.querySelector(`#${hash}`).scrollIntoView({ block: "start" }); setCurrent(hash); }
}

/* ---------- Imitor Cloud: access keys, members and the account ---------- */

function cloudSections() {
  return html`<section id="access-keys" class="set-section" aria-labelledby="access-keys-h">
        <h2 id="access-keys-h">Access keys</h2>
        <p class="set-note">Agents and CI push runs to this project with a key. A key can only upload runs here: it cannot read, list or delete anything. Only a hash of it is kept, so it is shown once, when it is made.</p>
        <div data-keys>${skeletonRows(2)}</div>
      </section>

      <section id="members" class="set-section" aria-labelledby="members-h">
        <h2 id="members-h">Members</h2>
        <p class="set-note">Everyone here sees this project’s runs. Owners also make keys and add or remove people. Add someone by the address of their Google account: they sign in with it, even if they have never signed in before.</p>
        <div data-members>${skeletonRows(2)}</div>
      </section>

      <section id="account" class="set-section" aria-labelledby="account-h">
        <h2 id="account-h">Account</h2>
        <div data-account>${skeletonRows(1)}</div>
      </section>`;
}

function keyRow(k, canManage) {
  const used = k.lastUsedAt ? `last used ${ago(k.lastUsedAt)} ago` : "never used";
  const sub = html`<span class="mono">${k.prefix}…</span> · made ${ago(k.createdAt)} ago · ${k.revokedAt ? `revoked ${ago(k.revokedAt)} ago` : used}`;
  const value = k.revokedAt ? pill("Revoked", "neutral")
    : html`${pill("Active", "ok")}${canManage ? button("Revoke", "secondary", { attrs: String(html`data-revoke="${k.id}" data-name="${k.name}"`) }) : ""}`;
  return html`<div class="set-row" data-key="${k.id}"><div class="set-label"><span>${k.name}</span><span class="set-sub">${sub}</span></div><div class="set-value">${value}</div></div>`;
}

function memberRow(m, canManage) {
  const who = m.name && m.name !== m.email ? m.name : m.email;
  const sub = html`${who !== m.email ? html`<span class="mono">${m.email}</span> · ` : ""}${m.you ? "you · " : ""}added ${ago(m.since) === "now" ? "just now" : `${ago(m.since)} ago`}`;
  const value = html`${pill(m.role === "owner" ? "Owner" : "Member", m.role === "owner" ? "ok" : "neutral")}${canManage || m.you ? button(m.you ? "Leave" : "Remove", "secondary", { attrs: String(html`data-remove-member="${m.userId}" data-email="${m.email}" data-you="${m.you ? "1" : ""}"`) }) : ""}`;
  return html`<div class="set-row" data-member="${m.userId}"><div class="set-label"><span>${who}</span><span class="set-sub">${sub}</span></div><div class="set-value">${value}</div></div>`;
}

async function mountMembers(ctx, main) {
  const box = main.querySelector("[data-members]");
  async function load() {
    let data;
    try { data = await cloud.members(); } catch (e) {
      if (ctx.isCurrent()) box.innerHTML = String(errorState("the members", e));
      return;
    }
    if (!ctx.isCurrent()) return;
    const form = data.canManage ? html`<form class="key-create" data-member-add>
        <label class="sr-only" for="member-email">Google account address</label>
        <input class="field" id="member-email" name="email" type="email" maxlength="254" placeholder="name@example.com" autocomplete="off" required>
        <label class="sr-only" for="member-role">Role</label>
        <select class="field" id="member-role" name="role"><option value="member">Member</option><option value="owner">Owner</option></select>
        <button type="submit" class="btn btn-primary">Add</button></form>`
      : html`<p class="set-empty">Only an owner of this project can add or remove people. You can leave it.</p>`;
    box.innerHTML = String(html`${form}${data.members.map((m) => memberRow(m, data.canManage))}`);
  }
  box.addEventListener("submit", async (e) => {
    const form = e.target.closest("[data-member-add]");
    if (!form) return;
    e.preventDefault();
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    const email = form.elements.email.value.trim();
    try {
      await cloud.addMember(email, form.elements.role.value);
      if (!ctx.isCurrent()) return;
      ctx.toast(`Added ${email}`);
      await load();
    } catch (err) {
      ctx.toast(`Couldn’t add ${email}: ${err.message}`);
      submit.disabled = false;
    }
  });
  box.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-remove-member]");
    if (!b) return;
    const you = b.dataset.you === "1";
    if (!confirm(you ? "Leave this project? You will lose access to it until an owner adds you again." : `Remove ${b.dataset.email} from this project? Their account stays; they lose access to this project.`)) return;
    b.disabled = true;
    try {
      await cloud.removeMember(b.dataset.removeMember);
      if (you) { location.assign(CLOUD_PAGES.projects); return; }
      ctx.toast(`Removed ${b.dataset.email}`);
      await load();
    } catch (err) {
      ctx.toast(`Couldn’t remove ${b.dataset.email}: ${err.message}`);
      b.disabled = false;
    }
  });
  await load();
}

async function mountCloud(ctx, main) {
  mountMembers(ctx, main);
  const box = main.querySelector("[data-keys]");
  const account = main.querySelector("[data-account]");

  cloud.me().then((me) => {
    if (!ctx.isCurrent()) return;
    account.innerHTML = String(html`<div class="set-row"><div class="set-label"><span>Signed in as</span>${me.user.name && me.user.name !== me.user.email ? html`<span class="set-sub">${me.user.name}</span>` : ""}</div><div class="set-value"><span class="mono t2">${me.user.email}</span></div></div>
      <div class="set-row"><div class="set-label"><span>Your role</span><span class="set-sub">Owners make keys and add people</span></div><div class="set-value">${pill(me.project.role === "owner" ? "Owner" : "Member")}</div></div>
      <div class="set-row"><div class="set-label"><span>Sign out</span><span class="set-sub">Everywhere ends your sessions in every browser</span></div>
        <div class="set-value"><form method="post" action="${CLOUD_PAGES.signOut}"><button type="submit" class="btn btn-secondary">Sign out</button></form><form method="post" action="${CLOUD_PAGES.signOutEverywhere}"><button type="submit" class="btn btn-secondary">Sign out everywhere</button></form></div></div>
      <div class="set-row"><div class="set-label"><span>Projects</span><span class="set-sub">Every project you are a member of</span></div><div class="set-value"><a class="btn btn-secondary" href="${CLOUD_PAGES.projects}">All projects</a></div></div>`);
  }, (e) => { if (ctx.isCurrent()) account.innerHTML = String(errorState("the account", e)); });

  async function load() {
    let data;
    try { data = await cloud.keys(); } catch (e) {
      if (ctx.isCurrent()) box.innerHTML = String(errorState("the access keys", e));
      return;
    }
    if (!ctx.isCurrent()) return;
    const form = data.canManage ? html`<form class="key-create" data-key-create>
        <label class="sr-only" for="key-name">Key name</label>
        <input class="field" id="key-name" name="name" maxlength="60" placeholder="Name it after who pushes: ci, claude-code" autocomplete="off" required>
        <button type="submit" class="btn btn-primary">Make a key</button></form>`
      : html`<p class="set-empty">Only an owner of this project can make or revoke keys.</p>`;
    box.innerHTML = String(html`${form}${data.keys.length ? data.keys.map((k) => keyRow(k, data.canManage)) : html`<p class="set-empty">No keys yet.</p>`}`);
  }

  box.addEventListener("submit", async (e) => {
    const form = e.target.closest("[data-key-create]");
    if (!form) return;
    e.preventDefault();
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    try {
      const { secret, key } = await cloud.createKey(form.elements.name.value.trim());
      if (!ctx.isCurrent()) return;
      await load();
      showSecret(key.name, secret);
    } catch (err) {
      ctx.toast(`Couldn’t make the key: ${err.message}`);
      submit.disabled = false;
    }
  });
  box.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-revoke]");
    if (!b) return;
    if (!confirm(`Revoke the key “${b.dataset.name}”? Pushes that use it stop working at once. This cannot be undone.`)) return;
    b.disabled = true;
    try {
      await cloud.revokeKey(b.dataset.revoke);
      ctx.toast(`Revoked “${b.dataset.name}”`);
      await load();
    } catch (err) {
      ctx.toast(`Couldn’t revoke the key: ${err.message}`);
      b.disabled = false;
    }
  });
  await load();
}

/** The new key, once: nothing this page can read keeps it after the dialog closes. */
function showSecret(name, secret) {
  const before = document.activeElement;
  const box = document.createElement("div");
  box.className = "key-dialog-backdrop";
  box.innerHTML = String(html`<div class="key-dialog" role="dialog" aria-modal="true" aria-labelledby="key-dialog-h" aria-describedby="key-dialog-p">
    <h2 id="key-dialog-h">Copy the key “${name}” now</h2>
    <p id="key-dialog-p">It is shown this once: Imitor Cloud keeps only a hash of it. If it is lost, revoke it and make another.</p>
    ${codeBlock([secret])}
    <p>Push a run with it, from the app’s folder or a CI job (keep it in the CI’s secrets):</p>
    ${codeBlock([`IMITOR_CLOUD_URL=${location.origin} IMITOR_TOKEN=${secret} npx imitor push`])}
    <div class="key-dialog-actions">${button("Done", "primary", { attrs: "data-key-done" })}</div>
  </div>`);
  const close = () => {
    box.remove();
    document.removeEventListener("keydown", onKey);
    if (before && document.contains(before)) before.focus();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  box.addEventListener("click", (e) => { if (e.target.closest("[data-key-done]")) close(); });
  document.addEventListener("keydown", onKey);
  document.body.append(box);
  box.querySelector(".copy-btn")?.focus();
}
