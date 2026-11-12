// Fetch wrapper for the app server's JSON API. Errors carry a readable message.
// A site written by `imitor export` carries <meta name="imitor-mode" content="static"> ("static demo" for the demo):
// it reads each endpoint from the same path plus .json, and keeps what it would write in this browser instead.
// Imitor Cloud serves the interface with content="cloud" under /p/<project>: it reads the same API under that base,
// keeps "seen" on the server for the signed-in person, and sends a signed-out browser to /login.

import { withBase } from "./base.js";

const MODE = (document.querySelector('meta[name="imitor-mode"]')?.content || "").split(/\s+/);
export const isStatic = MODE.includes("static");
export const isDemo = isStatic && MODE.includes("demo");
export const isCloud = MODE.includes("cloud");
/** No local server behind this page: nothing here can start a run or serve a live preview. */
export const isRemote = isStatic || isCloud;
export const LIVE_NEEDS_APP = "The live preview needs Imitor running locally (npx imitor app).";
export const LIVE_NOT_IN_CLOUD = "Imitor Cloud keeps runs and their shots, not a build of the app, so it has no live preview. Run npx imitor app where the app is to use it.";
/** Why this page has no live preview, when it has none. */
export const LIVE_UNAVAILABLE = isCloud ? LIVE_NOT_IN_CLOUD : LIVE_NEEDS_APP;

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/** Imitor Cloud's own pages, outside the project's base: the router leaves links to them to the browser. */
export const CLOUD_PAGES = { projects: "/", signOut: "/logout", signOutEverywhere: "/logout/everywhere" };

/** Off to the sign-in page, coming back here afterwards. */
function signIn() {
  location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
}

async function request(method, path, body) {
  let res;
  if (isStatic) path = `${path}.json`;
  path = withBase(path);
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(isRemote ? `${isCloud ? "Imitor Cloud" : "This site"} did not answer (${path}). Check the connection and retry.` : `The Imitor app server did not answer (${method} ${path}). Is \`imitor app\` still running?`, 0);
  }
  if (isCloud && res.status === 401) {
    signIn();
    throw new ApiError("You are signed out. Taking you to the sign-in page…", 401);
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(`${method} ${path} returned ${res.status}${data?.error ? `: ${data.error}` : ""}`, res.status);
  if (data == null) throw new ApiError(`${method} ${path} did not return JSON`, res.status);
  return data;
}

/* Static sites keep "seen" marks in this browser: { [problemId]: true | false }, laid over the exported state. */
const SEEN_KEY = "imitor.static.seen";
function localSeen() {
  try { const v = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
function withLocalSeen(problems) {
  const marks = localSeen();
  for (const p of problems || []) if (typeof marks[p.id] === "boolean") p.seen = marks[p.id];
  return problems;
}
async function setLocalSeen(id, seen) {
  const marks = localSeen();
  marks[id] = seen;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(marks)); } catch { throw new ApiError("this browser does not allow the site to store anything", 0); }
  return { ok: true };
}

export const api = {
  project: () => request("GET", "/api/project"),
  runs: () => request("GET", "/api/runs"),
  run: (id) => request("GET", `/api/runs/${encodeURIComponent(id)}`).then((d) => (isStatic ? { ...d, problems: withLocalSeen(d.problems) } : d)),
  problems: () => request("GET", "/api/problems").then((d) => (isStatic ? { ...d, problems: withLocalSeen(d.problems) } : d)),
  setSeen: (id, seen) => (isStatic ? setLocalSeen(id, seen) : request("POST", `/api/problems/${encodeURIComponent(id)}/seen`, { seen })),
  captures: () => request("GET", "/api/captures"),
  // An exported site is a snapshot: nobody is "active now" in it, whenever it is opened.
  agents: () => request("GET", "/api/agents").then((d) => (isStatic ? { ...d, connections: (d.connections || []).map((c) => ({ ...c, active: false })) } : d)),
};

/** Imitor Cloud only: the signed-in person and the project's upload keys. */
export const cloud = {
  me: () => request("GET", "/api/me"),
  keys: () => request("GET", "/api/keys"),
  createKey: (name) => request("POST", "/api/keys", { name }),
  revokeKey: (id) => request("POST", `/api/keys/${encodeURIComponent(id)}/revoke`, {}),
};
