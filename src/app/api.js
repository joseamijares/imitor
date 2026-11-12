// Fetch wrapper for the app server's JSON API. Errors carry a readable message.
// A site written by `imitor export` carries <meta name="imitor-mode" content="static"> ("static demo" for the demo):
// it reads each endpoint from the same path plus .json, and keeps what it would write in this browser instead.

const MODE = (document.querySelector('meta[name="imitor-mode"]')?.content || "").split(/\s+/);
export const isStatic = MODE.includes("static");
export const isDemo = isStatic && MODE.includes("demo");
export const LIVE_NEEDS_APP = "The live preview needs Imitor running locally (npx imitor app).";

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function request(method, path, body) {
  let res;
  if (isStatic) path = `${path}.json`;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(isStatic ? `This site did not answer (${path}). Check the connection and retry.` : `The Imitor app server did not answer (${method} ${path}). Is \`imitor app\` still running?`, 0);
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
