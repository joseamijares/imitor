// The few pages the cloud draws itself, outside the review interface: sign-in, the admin token form, the projects
// list, and plain notices (invite-only, errors). Server-rendered, no script, in the Signal identity (design/tokens.css
// served as /static/cloud.css with the styles below).
import { esc, page } from "./http.mjs";

export const PAGE_CSP = "default-src 'none'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export const PAGE_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--color-bg); color: var(--color-t-1); font: 400 var(--text-13)/var(--leading-13) var(--font-sans); -webkit-font-smoothing: antialiased; min-height: 100vh; }
a { color: inherit; }
.mono { font-family: var(--font-mono); font-size: var(--text-11); line-height: var(--leading-11); }
.t2 { color: var(--color-t-2); } .t3 { color: var(--color-t-3); }
.brand { display: inline-flex; align-items: center; gap: 8px; text-decoration: none; }
.brand img { display: block; }
.wordmark { font-family: var(--font-wordmark); font-style: italic; font-size: 21px; letter-spacing: -0.02em; line-height: 1; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: var(--radius-control); border: 1px solid transparent; background: none; color: inherit; font: 500 var(--text-13)/var(--leading-13) var(--font-sans); text-decoration: none; cursor: pointer; white-space: nowrap; }
.btn-primary { background: var(--color-acc-bg); color: var(--color-on-acc); }
.btn-primary:hover { filter: brightness(1.06); }
.btn-secondary { background: var(--color-panel); border-color: var(--color-line-2); padding: 0 11px; }
.btn-secondary:hover { background: var(--color-raised); }
.btn-ghost { color: var(--color-t-2); } .btn-ghost:hover { color: var(--color-t-1); }
.btn:focus-visible, .field:focus-visible, a:focus-visible { outline: 2px solid var(--color-acc); outline-offset: 2px; }
.field { height: 30px; padding: 0 10px; background: var(--color-panel); border: 1px solid var(--color-line); border-radius: var(--radius-control); color: var(--color-t-1); font: 400 var(--text-13) var(--font-sans); min-width: 0; }
.field::placeholder { color: var(--color-t-3); }
.notice { padding: 8px 12px; border: 1px solid var(--color-line-2); border-radius: var(--radius-control); background: var(--color-panel); color: var(--color-t-2); font-size: var(--text-12); line-height: 18px; }
.notice.bad { border-color: var(--color-bad); color: var(--color-t-1); }

/* Sign-in and notices: one narrow column in the middle of the page. */
.center { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; }
.card { width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 16px; }
.card h1 { margin: 8px 0 0; font-size: var(--text-20); line-height: var(--leading-20); font-weight: 600; letter-spacing: -0.02em; }
.card p { margin: 0; color: var(--color-t-2); }
.card .btn { width: 100%; height: 36px; }
.card form { display: flex; flex-direction: column; gap: 8px; }
.card .field { width: 100%; height: 36px; }
.card .foot { font-size: var(--text-12); color: var(--color-t-3); }

/* Projects: a top bar and a list. */
.top { height: 48px; display: flex; align-items: center; gap: 12px; padding: 0 24px; border-bottom: 1px solid var(--color-line); }
.top .who { margin-left: auto; color: var(--color-t-2); font-size: var(--text-12); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.top form { margin: 0; }
.wrap { max-width: 720px; margin: 0 auto; padding: 32px 24px 64px; }
.wrap h1 { margin: 0 0 4px; font-size: var(--text-20); line-height: var(--leading-20); font-weight: 600; letter-spacing: -0.02em; }
.wrap > p { margin: 0 0 20px; color: var(--color-t-2); }
.list { border: 1px solid var(--color-line); border-radius: var(--radius-block); overflow: hidden; }
.row { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 0 14px; text-decoration: none; border-top: 1px solid var(--color-line); }
.row:first-child { border-top: 0; }
a.row:hover { background: var(--color-panel); }
.row .name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .meta { margin-left: auto; color: var(--color-t-3); }
.empty { padding: 20px 14px; color: var(--color-t-2); }
.create { display: flex; gap: 8px; margin-top: 24px; }
.create .field { flex: 1; }
.create-label { display: block; margin: 32px 0 0; font-weight: 600; font-size: var(--text-14); }
@media (max-width: 520px) { .top { padding: 0 16px; } .wrap { padding: 24px 16px 48px; } .create { flex-direction: column; } }
`;

const shell = (title, body) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${esc(title)} · Imitor Cloud</title>
  <link rel="icon" type="image/svg+xml" href="/static/icon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Instrument+Serif:ital@1&display=swap">
  <link rel="stylesheet" href="/static/cloud.css">
</head>
<body>
${body}
</body>
</html>`;

const brand = (size = 28) => `<a class="brand" href="/"><img src="/static/icon.svg" width="${size}" height="${size}" alt=""><span class="wordmark">Imitor</span></a>`;

const html = (status, title, body, headers = {}) => page(status, shell(title, body), { csp: PAGE_CSP, headers });

/** The sign-in page. opts: { google, adminToken, next, error }. */
export function loginPage({ google, adminToken, next = "/", error = null }, status = 200, headers = {}) {
  const q = next && next !== "/" ? `?next=${encodeURIComponent(next)}` : "";
  const ways = [];
  if (google) ways.push(`<a class="btn btn-primary" href="/auth/google${q}">Continue with Google</a>`);
  if (adminToken) ways.push(`<a class="btn btn-secondary" href="/login/token${q}">Sign in with the admin token</a>`);
  return html(status, "Sign in", `<main class="center"><div class="card">
  ${brand()}
  <h1>Sign in to Imitor Cloud</h1>
  <p>Review the runs your agents and CI pushed. This Imitor Cloud is invite-only: sign in with an address its owner allowed.</p>
  ${error ? `<p class="notice bad" role="alert">${esc(error)}</p>` : ""}
  ${ways.length ? ways.join("\n  ") : `<p class="notice">Sign-in is not set up on this server. Its owner sets <span class="mono">GOOGLE_CLIENT_ID</span> and <span class="mono">GOOGLE_CLIENT_SECRET</span>, or <span class="mono">IMITOR_ADMIN_TOKEN</span> for a private instance.</p>`}
</div></main>`, headers);
}

/** The admin token form (only when IMITOR_ADMIN_TOKEN is set). */
export function tokenPage({ next = "/", error = null }, status = 200) {
  return html(status, "Admin token", `<main class="center"><div class="card">
  ${brand()}
  <h1>Sign in with the admin token</h1>
  <p>For a private instance without Google sign-in: paste the value of <span class="mono">IMITOR_ADMIN_TOKEN</span> from the server's environment.</p>
  ${error ? `<p class="notice bad" role="alert">${esc(error)}</p>` : ""}
  <form method="post" action="/login/token">
    <input type="hidden" name="next" value="${esc(next)}">
    <label class="t2" for="token">Admin token</label>
    <input class="field mono" id="token" name="token" type="password" autocomplete="current-password" required autofocus>
    <button class="btn btn-primary" type="submit">Sign in</button>
  </form>
  <a class="foot" href="/login">Other ways to sign in</a>
</div></main>`);
}

/** A short notice with a way on. */
export function noticePage(status, title, text, { link = { href: "/login", label: "Back to sign-in" }, headers = {} } = {}) {
  return html(status, title, `<main class="center"><div class="card">
  ${brand()}
  <h1>${esc(title)}</h1>
  <p>${esc(text)}</p>
  ${link ? `<a class="btn btn-secondary" href="${esc(link.href)}">${esc(link.label)}</a>` : ""}
</div></main>`, headers);
}

export const inviteOnlyPage = (headers = {}) =>
  noticePage(403, "This Imitor Cloud is invite-only", "The Google account you chose is not on this server's list of people who may sign in. Ask its owner to add your address, or sign in with another account.", { headers });

/** The signed-in person's projects, with a form to create one. */
export function projectsPage({ user, projects, error = null, name = "" }, status = 200, headers = {}) {
  const rows = projects.length
    ? projects.map((p) => `<a class="row" href="/p/${encodeURIComponent(p.slug)}/"><span class="name">${esc(p.name)}</span><span class="mono t3">${esc(p.slug)}</span><span class="meta">${p.role === "owner" ? "Owner" : "Member"}</span></a>`).join("\n")
    : `<div class="empty">No projects yet. Create one, then make an upload key for it under Settings, Access keys.</div>`;
  return html(status, "Projects", `<header class="top">
  ${brand(24)}
  <span class="who" title="${esc(user.email)}">${esc(user.name || user.email)}</span>
  <form method="post" action="/logout"><button class="btn btn-ghost" type="submit">Sign out</button></form>
</header>
<main class="wrap">
  <h1>Projects</h1>
  <p>Each project keeps the newest 50 runs pushed to it, for 30 days.</p>
  <div class="list">${rows}</div>
  <form method="post" action="/projects">
    <label class="create-label" for="project-name">New project</label>
    ${error ? `<p class="notice bad" role="alert">${esc(error)}</p>` : ""}
    <div class="create"><input class="field" id="project-name" name="name" maxlength="80" placeholder="fernwood" value="${esc(name)}" required><button class="btn btn-primary" type="submit">Create project</button></div>
  </form>
</main>`, headers);
}
