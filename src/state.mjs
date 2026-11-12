// State for flows: what a flow starts from. "after" runs other flows' steps first; "state", "seed" and "clock" are put in
// place before the app's first script runs. The same page script (the prelude) serves the runs, where Playwright adds
// it to every page of a flow's browser context, and the live preview, where `imitor app` adds it to the preview's pages.
//
// What the prelude does on each page, before any app code:
//   globalThis.__imitor.state  the flow's state label, or null
//   globalThis.__imitor.seed   { sql: [...], database } for the sqljs stand-in (src/shims/expo-sqlite.js), or null
//   localStorage               seed.storage written once per browser-tab session (sessionStorage "imitor:seeded")
// Seed problems are kept in sessionStorage "imitor:seed-errors" so they survive reloads; readSeedProblems collects them.

import { secretsUsed } from "./secrets.mjs";

/** A flow's setup: what the page starts with. */
export function flowSetup(flow) {
  const seed = flow.seed || null;
  return {
    state: flow.state ?? null,
    storage: seed?.storage || null,
    sql: seed?.sql || null,
    database: seed?.database || null,
    clock: flow.clock ?? null,
  };
}

/** True when the flow starts from invented data: a state label or a seed. */
export const isSeeded = (flow) => Boolean(flow.seed && (flow.seed.storage || flow.seed.sql));

/** What a manifest, describe and the project API say about a flow's state. */
export function stateInfo(flow) {
  return { after: flow.after ?? null, state: flow.state ?? null, seeded: isSeeded(flow), clock: flow.clock ?? null };
}

/**
 * Where a flow really starts and the steps run before its own: the steps of the flows it runs after (shots skipped),
 * outermost first. The chain starts at the first flow's start; each later flow's own "start", if it has one, is opened
 * (a full reload) after the flows before it. Each entry is { flow, index, step }; index 0 is that "open the start" step.
 */
export function flowChain(config, flow) {
  const lineage = [];
  for (let f = flow; f.after; ) {
    f = config.flows.find((x) => x.name === f.after);
    if (!f || lineage.includes(f)) break; // loadConfig rejects both; stay safe on hand-made configs
    lineage.unshift(f);
  }
  if (!lineage.length) return { start: flow.start || "/", before: [] };
  const before = [];
  for (const [i, f] of [...lineage, flow].entries()) {
    if (i > 0 && f.start) before.push({ flow: f.name, index: 0, step: { goto: f.start } });
    if (f === flow) break;
    (f.steps || []).forEach((step, j) => {
      if (!step.shot) before.push({ flow: f.name, index: j + 1, step });
    });
  }
  return { start: lineage[0].start || "/", before };
}

/** The environment variables a flow fills from ({ "env": "NAME" }), its own steps and those of the flows it runs after. */
export function flowSecrets(config, flow) {
  return secretsUsed([...flowChain(config, flow).before.map((b) => b.step), ...(flow.steps || [])]);
}

/**
 * The prelude's source (no <script> tags). `setups` maps flow names to flowSetup() values. With `pick` set it applies
 * that flow's setup. With pick null (the live preview) it reads the flow from ?imitor-flow=<name> in the address (kept
 * in sessionStorage for the tab's session, removed from the address before the app reads it; an empty value clears it),
 * and also shifts the page's Date to the flow's clock, since there is no Playwright there to do it.
 */
export function preludeSource(setups, { pick = null } = {}) {
  const data = JSON.stringify({ setups, pick }).replace(/</g, "\\u003c");
  return `(function(){var D=${data},S=D.setups,pick=D.pick,live=pick===null,ss=null;try{ss=window.sessionStorage}catch(e){}
function get(k){try{return ss.getItem(k)}catch(e){return null}}function put(k,v){try{ss.setItem(k,v)}catch(e){}}
if(live){var u=new URL(location.href),q=u.searchParams.get("imitor-flow");if(q!==null){u.searchParams.delete("imitor-flow");if(q)put("imitor-flow",q);else try{ss.removeItem("imitor-flow")}catch(e){}
try{history.replaceState(history.state,"",u.pathname+u.search+u.hash)}catch(e){}pick=q||null}else pick=get("imitor-flow")}
var s=pick&&Object.prototype.hasOwnProperty.call(S,pick)?S[pick]:null;
var g=globalThis.__imitor||{};try{Object.defineProperty(globalThis,"__imitor",{configurable:true,get:function(){return g},set:function(v){if(v&&v!==g)for(var k in v)g[k]=v[k]}})}catch(e){globalThis.__imitor=g}
g.flow=s?pick:null;g.state=s?s.state:null;g.seed=s&&s.sql?{sql:s.sql,database:s.database}:null;g.clock=s?s.clock:null;
if(!s)return;
if(s.storage&&get("imitor:seeded")!==pick){var errs=[];for(var k in s.storage){try{localStorage.setItem(k,s.storage[k])}catch(e){errs.push({statement:"localStorage "+k,error:String(e&&e.message||e)})}}
if(errs.length)put("imitor:seed-errors",JSON.stringify(JSON.parse(get("imitor:seed-errors")||"[]").concat(errs)));}
if(s.storage)put("imitor:seeded",pick);
if(live&&s.clock){var RD=Date,at=RD.parse(s.clock),off=Number(get("imitor:clock"));if(!get("imitor:clock")||isNaN(off)){off=at-RD.now();put("imitor:clock",String(off))}
var FD=function(){var a=[].slice.call(arguments);if(!(this instanceof FD))return new RD(RD.now()+off).toString();return a.length?new(Function.prototype.bind.apply(RD,[null].concat(a)))():new RD(RD.now()+off)};
FD.prototype=RD.prototype;FD.now=function(){return RD.now()+off};FD.parse=RD.parse;FD.UTC=RD.UTC;window.Date=FD}
})();`;
}

/** Set up a Playwright browser context for a flow: the clock, then the prelude on every page. Before the first page. */
export async function prepareContext(context, flow, name = flow.name || "ad hoc") {
  const setup = flowSetup(flow);
  if (setup.clock) await context.clock.install({ time: setup.clock });
  await context.addInitScript({ content: preludeSource({ [name]: setup }, { pick: name }) });
  return setup;
}

/**
 * Problems with the seed, as messages: statements that failed (named), and a SQL seed that was never applied because the
 * app did not open the database. Read from the page's sessionStorage at the end of a flow.
 */
export async function readSeedProblems(page, setup) {
  if (!setup.storage && !setup.sql) return [];
  let found;
  try {
    found = await page.evaluate(() => ({ errors: JSON.parse(sessionStorage.getItem("imitor:seed-errors") || "[]"), sql: sessionStorage.getItem("imitor:sqlite-seeded") }));
  } catch {
    return [];
  }
  const out = found.errors.map((e) => `seed statement failed: ${oneLine(e.statement)}: ${e.error}${e.skippedRest ? " (the statements after it in the same entry did not run)" : ""}`);
  if (setup.sql && !found.sql) out.push(`the SQL seed was not applied: the app never opened ${setup.database ? `the database "${setup.database}"` : "a database"} through expo-sqlite (or this build predates seeding: run imitor build)`);
  return out;
}

const oneLine = (s) => {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > 160 ? t.slice(0, 157) + "..." : t;
};
