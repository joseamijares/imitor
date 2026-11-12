// A small History-API router. Routes are patterns like "/runs/:id/:tab".

import { stripBase, withBase } from "./base.js";

export function createRouter(routes, onRoute) {
  const compiled = routes.map((r) => {
    const keys = [];
    const re = new RegExp("^" + r.path.replace(/\/:([a-z]+)/gi, (_, k) => { keys.push(k); return "/([^/]+)"; }) + "/?$");
    return { ...r, re, keys };
  });

  function match(pathname) {
    for (const r of compiled) {
      const m = pathname.match(r.re);
      if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }

  function resolve() {
    const url = new URL(location.href);
    onRoute(match(stripBase(url.pathname)), url);
  }

  function navigate(to, { replace = false } = {}) {
    const url = new URL(withBase(to), location.href);
    if (url.href === location.href && !replace) return;
    history[replace ? "replaceState" : "pushState"](null, "", url);
    resolve();
  }

  // Same-origin links navigate without a reload; modified clicks and target=_blank keep browser behaviour.
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest("a[href]");
    if (!a || a.target || a.hasAttribute("download")) return;
    const url = new URL(a.href, location.href);
    const p = stripBase(url.pathname);
    if (url.origin !== location.origin || p.startsWith("/files/") || p.startsWith("/preview/") || p.startsWith("/api/")) return;
    e.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  });
  addEventListener("popstate", resolve);

  return { navigate, resolve };
}
