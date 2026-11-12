// Runs: one row per run, grouped Today / Yesterday / Earlier, filtered All / Pull requests / Main.
import { api } from "../api.js";
import { html, raw, icon, statusMark, chip, seg, who, button, skeletonRows, errorState } from "../components.js";
import { ago, dayGroup, isMainBranch, plural } from "../format.js";
import { pageHeader, noRuns } from "./common.js";

const FILTERS = [{ value: "all", label: "All" }, { value: "prs", label: "Pull requests" }, { value: "main", label: "Main" }];
const STATUS_LABEL = { passed: "Passed", "stand-ins": "Passed with stand-ins", failed: "Failed", running: "In progress" };

export async function mount(ctx) {
  const { main } = ctx;
  document.title = "Runs · Imitor";
  let filter = FILTERS.some((f) => f.value === ctx.url.searchParams.get("filter")) ? ctx.url.searchParams.get("filter") : "all";
  const header = pageHeader(html`<h1>Runs</h1>`,
    button("Run now", "secondary", { icon: "play", attrs: 'data-copy="npx imitor" data-copy-toast="Copied “npx imitor”: run it in the project to start a run"', title: "Copy the command that starts a run" }));
  main.innerHTML = String(html`${header}<div class="content">${skeletonRows(8)}</div>`);

  let runs;
  try { ({ runs } = await api.runs()); } catch (e) {
    if (!ctx.isCurrent()) return;
    main.querySelector(".content").innerHTML = String(errorState("runs", e));
    return;
  }
  if (!ctx.isCurrent()) return;
  const content = main.querySelector(".content");
  if (!runs.length) {
    await ctx.projectReady();
    if (!ctx.isCurrent()) return;
    content.innerHTML = String(noRuns(ctx.projectName()));
    content.querySelector(".state")?.insertAdjacentHTML("beforeend", String(button("Set up step by step", "secondary", { href: "/onboarding", icon: "chevron" })));
    return;
  }

  function render() {
    const shown = runs.filter((r) => filter === "all" || (filter === "main" ? isMainBranch(r.branch) : !isMainBranch(r.branch)));
    const groups = new Map();
    for (const r of shown) {
      const g = dayGroup(r.startedAt || r.finishedAt);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(r);
    }
    content.innerHTML = String(html`
      <div class="toolbar">${seg("filter", FILTERS, filter, "Show runs")}<span class="t3" style="font-size:12px">Showing ${plural(shown.length, "run")}</span></div>
      <div class="runs-grid runs-head" role="presentation">
        <span>Pull request</span><span>Branch</span><span>Started by</span><span class="num">Shots</span><span class="num">Problems</span><span class="col-commit">Commit</span><span style="text-align:right">Updated</span>
      </div>
      ${shown.length ? "" : html`<p class="placeholder-page">No runs match this filter.</p>`}
      ${[...groups].map(([name, list]) => html`
        <div class="runs-group"><span>${name}</span><span class="mono t3">${list.length}</span></div>
        ${list.map(row)}`)}`);
  }

  content.addEventListener("click", (e) => {
    const b = e.target.closest("[data-seg=filter] button");
    if (!b) return;
    filter = b.dataset.value;
    const u = new URL(location.href);
    filter === "all" ? u.searchParams.delete("filter") : u.searchParams.set("filter", filter);
    history.replaceState(null, "", u);
    render();
  });
  render();
}

function row(r) {
  const label = `${STATUS_LABEL[r.status] || r.status}`;
  return html`<a class="runs-grid row-link" href="/runs/${encodeURIComponent(r.id)}">
    <span>${statusMark(r.status, label)}</span>
    <span class="pr">${r.pr != null ? `#${r.pr}` : ""}</span>
    <span class="title" title="${r.title || ""}">${r.title || r.id}</span>
    <span class="branch">${icon("branch", 14)}<span>${r.branch || "—"}</span></span>
    ${who(r.by)}
    <span class="num shots">${r.shots ?? "—"}</span>
    <span class="num problems${raw(r.problems ? " has" : "")}">${r.problems ?? 0}</span>
    <span class="col-commit">${r.commit ? chip(r.commit) : ""}</span>
    <span class="updated">${ago(r.finishedAt || r.startedAt)}</span>
  </a>`;
}
