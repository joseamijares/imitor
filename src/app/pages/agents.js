// Agents: how to connect an agent (per client) and CI, the MCP tools agents can call, which agents
// called Imitor in the last 7 days, and their recent activity. Refreshes every 5 seconds while open.
import { api } from "../api.js";
import { html, icon, pill, avatar, button, skeletonRows, errorState } from "../components.js";
import { ago, plural } from "../format.js";
import { pageHeader } from "./common.js";

const DOCS_URL = "https://github.com/joseamijares/imitor#readme";
const REFRESH_MS = 5000;
const CLIENT_NOTE = {
  "Claude Code": (p) => `Run in the ${p} folder`,
  Cursor: () => "Paste as the server command in Cursor’s MCP settings",
  Codex: (p) => `Run in the ${p} folder`,
  Other: () => "Use as the MCP server command (stdio)",
};

export async function mount(ctx) {
  const { main } = ctx;
  document.title = "Agents · Imitor";
  const header = pageHeader(html`<h1>Agents</h1>`, button("Docs", "secondary", { icon: "docs", href: DOCS_URL, attrs: 'target="_blank" rel="noopener"' }));
  main.innerHTML = String(html`${header}<div class="content">${skeletonRows(6)}</div>`);

  let data;
  try { data = await api.agents(); } catch (e) {
    if (!ctx.isCurrent()) return;
    main.querySelector(".content").innerHTML = String(errorState("agents", e));
    return;
  }
  if (!ctx.isCurrent()) return;
  await ctx.projectReady();
  if (!ctx.isCurrent()) return;

  const commands = data.commands || {};
  const clients = Object.keys(commands).filter((k) => k !== "CI");
  let client = clients.includes(ctx.url.searchParams.get("client")) ? ctx.url.searchParams.get("client") : clients[0];

  main.innerHTML = String(html`${header}<div class="content agents-page">
    <div class="agents-main">
      <section class="agents-section" aria-labelledby="connect-h" data-part="connect"></section>
      <section class="agents-section" aria-labelledby="tools-h" data-part="tools"></section>
    </div>
    <aside class="agents-side" aria-label="Connected agents and activity" data-part="side"></aside>
  </div>`);
  const parts = Object.fromEntries([...main.querySelectorAll("[data-part]")].map((el) => [el.dataset.part, el]));

  // Only touch the DOM when the markup changed, so the 5-second refresh never flickers or drops focus.
  const last = new Map();
  const put = (el, markup) => { const s = String(markup); if (last.get(el) !== s) { el.innerHTML = s; last.set(el, s); } };

  function renderConnect() {
    const cmd = commands[client] || "";
    put(parts.connect, html`
      <div class="sec-head"><h2 id="connect-h">Connect</h2><span class="t3 sec-note">Agents talk to Imitor over MCP. No one has to open this app.</span></div>
      <div class="client-row">
        <div class="seg client-seg" role="group" aria-label="Agent client" data-seg="client">${clients.map((c) => html`<button type="button" data-value="${c}" aria-pressed="${c === client ? "true" : "false"}">${c === "Other" ? "" : avatar(c, 14)}${c}</button>`)}</div>
        <span class="t3 sec-note">${(CLIENT_NOTE[client] || CLIENT_NOTE.Other)(ctx.projectName())}</span>
      </div>
      ${command(cmd)}
      ${commands.CI ? html`<div class="ci-head"><span class="ci-label">In CI</span><span class="t3">Builds the preview and runs every flow; the shots and problems go to the output folder</span></div>${command(commands.CI)}` : ""}`);
  }

  function renderTools() {
    const tools = data.tools || [];
    put(parts.tools, html`
      <div class="sec-head"><h2 id="tools-h">What agents can do</h2><span class="mono t3">${plural(tools.length, "tool")}</span></div>
      ${tools.length ? html`<ul class="tool-list">${tools.map((t) => html`<li><span class="mono tool-name">${t.name}</span><span class="tool-desc">${ticks(t.description)}</span></li>`)}</ul>`
        : html`<p class="t3">The MCP server did not report any tools.</p>`}`);
  }

  function renderSide() {
    const conns = data.connections || [];
    const acts = data.activity || [];
    put(parts.side, html`
      <section aria-labelledby="conn-h">
        <div class="sec-head"><h2 id="conn-h">Connected</h2><span class="mono t3">${conns.length ? plural(conns.length, "agent") : ""}</span></div>
        ${conns.length ? html`<ul class="conn-list">${conns.map(connection)}</ul>` : html`<div class="agents-empty">
          <p><strong>Nothing connected yet.</strong> Agents that call Imitor’s MCP tools show up here within a few seconds. To connect Claude Code, run this in the ${ctx.projectName()} folder:</p>
          ${command(commands["Claude Code"] || "claude mcp add imitor -- npx imitor mcp")}
        </div>`}
      </section>
      <section aria-labelledby="act-h" class="act-section">
        <div class="sec-head"><h2 id="act-h">Recent activity</h2><span class="mono t3">${acts.length ? `last ${acts.length}` : ""}</span></div>
        ${acts.length ? html`<ol class="act-list">${acts.map(activity)}</ol>` : html`<p class="t3">No tool calls yet.</p>`}
      </section>`);
  }

  parts.connect.addEventListener("click", (e) => {
    const b = e.target.closest("[data-seg=client] button");
    if (!b) return;
    client = b.dataset.value;
    const u = new URL(location.href);
    client === clients[0] ? u.searchParams.delete("client") : u.searchParams.set("client", client);
    history.replaceState(null, "", u);
    renderConnect();
    parts.connect.querySelector("[data-seg=client] [aria-pressed=true]")?.focus();
  });

  renderConnect(); renderTools(); renderSide();

  // Poll while this page is the current one; a navigation ends the loop.
  const tick = async () => {
    if (!ctx.isCurrent()) return;
    if (!document.hidden) {
      try {
        const next = await api.agents();
        if (!ctx.isCurrent()) return;
        data = next;
        renderTools(); renderSide();
      } catch { /* keep the last data; the next tick tries again */ }
    }
    if (ctx.isCurrent()) setTimeout(tick, REFRESH_MS);
  };
  setTimeout(tick, REFRESH_MS);
}

/** A one-line shell command with a dim prompt and a working copy button (copies the command only). */
function command(cmd) {
  return html`<pre class="code cmd"><span class="c-dim" aria-hidden="true">$ </span>${cmd}<button type="button" class="copy-btn" data-copy="${cmd}" data-copy-toast="Copied “${cmd}”" aria-label="Copy command" title="Copy">${icon("copy", 14)}</button></pre>`;
}

/** `name` in a tool description -> mono. */
const ticks = (text) => String(text || "").split("`").map((t, i) => (i % 2 ? html`<code class="mono">${t}</code>` : t));

const KIND_NOTE = { agent: "MCP client", ci: "CI", person: "Person, from the CLI" };

function connection(c) {
  const by = { name: c.name, kind: c.kind };
  const since = c.lastAt ? ago(c.lastAt) : "";
  const last = c.active || since === "now" ? "now" : since ? `${since} ago` : "";
  return html`<li class="conn">
    ${avatar(by, 24)}
    <div class="conn-name"><div class="conn-title"><span>${c.name}</span>${c.active ? pill("Active now", "ok") : ""}</div><div class="t3 conn-sub">${KIND_NOTE[c.kind] || c.kind || ""}</div></div>
    <span class="conn-calls"><span>${c.calls24h ?? 0}</span><span class="mono t3">${c.calls24h === 1 ? "call in 24 h" : "calls in 24 h"}</span></span>
    <span class="conn-last t3">${c.lastAt ? html`<time datetime="${c.lastAt}" title="${new Date(c.lastAt).toLocaleString()}">${last}</time>` : ""}</span>
  </li>`;
}

function activity(a) {
  const d = new Date(a.at);
  const time = Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const failed = a.ok === false;
  return html`<li class="act${failed ? " is-failed" : ""}">
    <time class="mono t3" datetime="${a.at}" title="${Number.isNaN(d.getTime()) ? "" : d.toLocaleString()}">${time}</time>
    <div class="act-body">
      <p><span class="act-who">${a.by?.name || "Someone"}</span> <span class="act-text">${a.text}</span></p>
      <p class="mono act-tool">${failed ? html`<span class="act-failed">Failed</span> · ` : ""}${a.tool}</p>
    </div>
  </li>`;
}
