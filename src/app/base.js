// The path the interface is served under. An export made with --base /demo carries <meta name="imitor-base"
// content="/demo">; served at a domain root (imitor app, a plain export) BASE is "". Every app path and API path goes
// through withBase, and the router matches on stripBase, so the same pages work at "/" and under a sub-path.
export const BASE = (document.querySelector('meta[name="imitor-base"]')?.content || "").replace(/\/+$/, "");

const under = (p) => BASE && (p === BASE || p.startsWith(BASE + "/"));

/** "/runs" -> "/demo/runs". Leaves full URLs, protocol-relative URLs and paths already under the base alone. */
export const withBase = (p) => (!BASE || typeof p !== "string" || !p.startsWith("/") || p.startsWith("//") || under(p) ? p : BASE + p);

/** "/demo/runs" -> "/runs". */
export const stripBase = (p) => (under(p) ? p.slice(BASE.length) || "/" : p);
