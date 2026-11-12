// Everything people use, as opposed to the upload API under /v1 (api.mjs): sign-in, projects and their access keys,
// and each project's review interface with its read API and files, all under /p/<slug>/.
//
//   GET  /login, /login/token, POST /login/token     sign-in page; the admin token form (IMITOR_ADMIN_TOKEN only)
//   GET  /auth/google, /auth/google/callback          Google sign-in (OIDC code flow with PKCE, state and nonce)
//   POST /logout, /logout/everywhere                  end this session, or every session of the person
//   GET  /, GET /projects, POST /projects             the person's projects (HTML; JSON), create one
//   /p/<slug>/api/...                                 the interface's API (read.mjs) and the project's access keys
//   GET  /p/<slug>/files/runs/<run>/<path>            302 to a 5-minute storage URL for a file of a ready run
//   GET  /p/<slug>/...                                the interface (src/app), marked as cloud mode under that base
//
// Every route below /p/ checks that the signed-in person is a member of the project; run ids are not access control.
// Every request that changes something must come from a page of this server (Origin or Referer is PUBLIC_URL).
import crypto from "node:crypto";
import path from "node:path";
import { markIndex } from "../../src/export.mjs";
import { loadAssets, typeOf } from "./assets.mjs";
import { OidcError } from "./auth/oidc.mjs";
import { cookieNames, currentUser, endSession, sameOrigin, startSession, clearSessionCookie } from "./auth/session.mjs";
import { cookie, cookies, fail, json, page, randomToken, readFields, redirect, safeEqual } from "./http.mjs";
import { inviteOnlyPage, loginPage, noticePage, PAGE_CSS, projectsPage, tokenPage } from "./pages.mjs";
import { problemRun, readRoute } from "./read.mjs";

export const FILE_URL_SECONDS = 5 * 60;
const SIGNIN_SECONDS = 10 * 60;

const nowOf = (deps) => deps.now?.() || new Date();
const withCookies = (response, ...values) => {
  for (const v of values) if (v) response.headers.append("set-cookie", v);
  return response;
};
/** A path on this server to return to after signing in, or "/". */
export const safeNext = (next) => (typeof next === "string" && /^\/(?![/\\])[^\s\\]*$/.test(next) ? next : "/");

const publicKey = ({ id, name, prefix, createdAt, lastUsedAt, revokedAt, expiresAt }) => ({ id, name, prefix, createdAt, lastUsedAt, revokedAt, expiresAt });
const publicProject = ({ id, name, slug, createdAt, role }) => ({ id, name, slug, createdAt, role });

export async function handleWeb(request, deps) {
  const url = new URL(request.url);
  const p = url.pathname;
  const { method } = request;
  const read = method === "GET" || method === "HEAD";
  const isApi = /^\/p\/[^/]+\/api(\/|$)/.test(p) || p === "/projects";

  if (!read && !sameOrigin(request, deps.publicUrl)) {
    return isApi ? fail(403, "this request did not come from a page of this server") : noticePage(403, "Request refused", "This form was sent from somewhere other than this server, so it was not acted on. Go back, reload the page and try again.");
  }

  if (p.startsWith("/static/")) return read ? staticFile(p) : fail(405, "method not allowed");
  if (p === "/login") return read ? login(request, deps, url) : fail(405, "method not allowed");
  if (p === "/login/token") return tokenLogin(request, deps, url);
  if (p === "/auth/google") return read ? googleStart(deps, url) : fail(405, "method not allowed");
  if (p === "/auth/google/callback") return read ? googleCallback(request, deps, url) : fail(405, "method not allowed");

  const auth = await currentUser(request, deps);
  const done = (response) => withCookies(response, auth.setCookie);
  const { user } = auth;

  if (p === "/logout" || p === "/logout/everywhere") {
    if (method !== "POST") return done(fail(405, "sign out with POST"));
    if (user) {
      if (p === "/logout") await endSession(request, deps);
      else await deps.db.deleteUserSessions(user.id);
      await deps.db.addAudit({ userId: user.id, action: p === "/logout" ? "user.signout" : "user.signout-everywhere" });
    }
    return withCookies(redirect("/login", 303), clearSessionCookie(deps));
  }
  if (p === "/") {
    if (!read) return done(fail(405, "method not allowed"));
    if (!user) return done(redirect("/login"));
    return done(projectsPage({ user, projects: await deps.db.listUserProjects(user.id) }));
  }
  if (p === "/projects") return done(await projects(request, deps, user));

  const m = /^\/p\/([a-z0-9-]{1,64})(\/.*)?$/.exec(p);
  if (m) return done(await projectRoute(request, deps, user, m[1], m[2] || "", url));
  return done(noticePage(404, "Not found", `There is no page at ${p}.`, { link: { href: "/", label: "Your projects" } }));
}

// ---------- static pieces of the pages ----------

async function staticFile(p) {
  const assets = await loadAssets();
  if (p === "/static/cloud.css") return new Response(assets.tokens + PAGE_CSS, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=300" } });
  if (p === "/static/icon.svg") return new Response(assets.app.get("assets/imitor-icon-32.svg"), { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" } });
  return fail(404, "not found");
}

// ---------- signing in ----------

async function login(request, deps, url) {
  const next = safeNext(url.searchParams.get("next"));
  if ((await currentUser(request, deps)).user) return redirect(next);
  return loginPage({ google: !!deps.oidc, adminToken: !!deps.adminToken, next });
}

/** The person to sign in for verified Google claims, or null when they may not. Creates nothing for someone not allowed. */
export async function admit(deps, claims) {
  const { db } = deps;
  const known = await db.findIdentity("google", claims.sub);
  if (known) {
    const user = await db.getUser(known.userId);
    return user?.allowed ? user : null;
  }
  const email = String(claims.email || "").toLowerCase();
  if (!email || !deps.allowedEmails?.has(email)) return null;
  let user = await db.findUserByEmail(email);
  if (user) {
    // The address is someone's who signed in with another Google account: an address can change hands, so the owner decides.
    if ((await db.listIdentities(user.id)).some((i) => i.provider === "google")) return null;
    user = await db.updateUser(user.id, { allowed: true, ...(user.name ? {} : { name: claims.name ?? null }) });
  } else {
    user = await db.createUser({ email: claims.email, name: claims.name ?? null, allowed: true });
    await db.addAudit({ userId: user.id, action: "user.create", detail: { email: user.email, via: "google" } });
  }
  await db.addIdentity("google", claims.sub, user.id);
  return user;
}

async function googleStart(deps, url) {
  if (!deps.oidc) return noticePage(404, "Google sign-in is off", "This server has no Google client configured (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).");
  const flow = { state: randomToken(32), nonce: randomToken(32), verifier: randomToken(48), next: safeNext(url.searchParams.get("next")) };
  let location;
  try {
    location = await deps.oidc.authorizationUrl(flow);
  } catch (error) {
    deps.log?.(error);
    return noticePage(502, "Google did not answer", "This server could not reach Google to start signing in. Try again in a moment.");
  }
  const names = cookieNames(deps.publicUrl);
  return redirect(location, 302, { "set-cookie": cookie(names.signin, Buffer.from(JSON.stringify(flow)).toString("base64url"), { maxAge: SIGNIN_SECONDS, secure: names.secure }) });
}

function readFlow(request, deps) {
  const value = cookies(request)[cookieNames(deps.publicUrl).signin];
  if (!value) return null;
  try {
    const flow = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return ["state", "nonce", "verifier"].every((k) => typeof flow[k] === "string" && flow[k]) ? flow : null;
  } catch {
    return null;
  }
}

async function googleCallback(request, deps, url) {
  const names = cookieNames(deps.publicUrl);
  const clear = cookie(names.signin, "", { maxAge: 0, secure: names.secure }); // one use, whatever happens
  const out = (response) => withCookies(response, clear);
  if (!deps.oidc) return out(noticePage(404, "Google sign-in is off", "This server has no Google client configured."));
  const flow = readFlow(request, deps);
  const stale = () => out(noticePage(400, "Start signing in again", "This sign-in was not started from this browser, or took longer than 10 minutes."));
  if (!flow) return stale();
  const error = url.searchParams.get("error");
  if (error) return out(loginPage({ google: true, adminToken: !!deps.adminToken, next: flow.next, error: error === "access_denied" ? "Google sign-in was cancelled." : `Google did not sign you in (${error}).` }, 400));
  if (!safeEqual(url.searchParams.get("state") || "", flow.state)) return stale();
  const code = url.searchParams.get("code");
  if (!code) return stale();

  let claims;
  try {
    claims = await deps.oidc.verify(await deps.oidc.exchange(code, flow.verifier), { nonce: flow.nonce });
  } catch (e) {
    if (!(e instanceof OidcError)) throw e;
    deps.log?.(e);
    return out(noticePage(400, "Sign-in could not be verified", `Google's answer was not accepted: ${e.message}. Try again.`));
  }
  if (claims.email_verified !== true) return out(noticePage(403, "Address not verified", "Google has not verified the address of this account, so it cannot be used to sign in here."));
  const user = await admit(deps, claims);
  if (!user) return out(inviteOnlyPage());
  await deps.db.addAudit({ userId: user.id, action: "user.signin", detail: { email: user.email, via: "google" } });
  return out(redirect(safeNext(flow.next), 303, { "set-cookie": await startSession(deps, user.id) }));
}

async function tokenLogin(request, deps, url) {
  if (!deps.adminToken) return noticePage(404, "Not found", "The admin token is not set on this server.");
  if (request.method === "GET" || request.method === "HEAD") return tokenPage({ next: safeNext(url.searchParams.get("next")) });
  if (request.method !== "POST") return fail(405, "method not allowed");
  const { fields = {} } = await readFields(request);
  const next = safeNext(fields.next);
  if (!safeEqual(String(fields.token ?? ""), deps.adminToken)) {
    await deps.db.addAudit({ action: "user.signin-refused", detail: { via: "admin-token" } });
    return tokenPage({ next, error: "That is not the admin token." }, 401);
  }
  const email = deps.adminEmail || "admin";
  let user = await deps.db.findUserByEmail(email);
  if (!user) {
    user = await deps.db.createUser({ email, name: "Admin", allowed: true });
    await deps.db.addAudit({ userId: user.id, action: "user.create", detail: { email, via: "admin-token" } });
  } else if (!user.allowed) user = await deps.db.updateUser(user.id, { allowed: true });
  await deps.db.addAudit({ userId: user.id, action: "user.signin", detail: { email, via: "admin-token" } });
  return redirect(next, 303, { "set-cookie": await startSession(deps, user.id) });
}

// ---------- projects ----------

async function projects(request, deps, user) {
  if (request.method === "GET" || request.method === "HEAD") {
    if (!user) return fail(401, "sign in first");
    return json(200, { projects: (await deps.db.listUserProjects(user.id)).map(publicProject) });
  }
  if (request.method !== "POST") return fail(405, "method not allowed");
  const { fields, form, error } = await readFields(request);
  if (!user) return form ? redirect("/login", 303) : fail(401, "sign in first");
  if (error) return fail(400, error);
  const name = typeof fields.name === "string" ? fields.name.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > 80) {
    const problem = "A project needs a name of 1 to 80 characters.";
    return form ? projectsPage({ user, projects: await deps.db.listUserProjects(user.id), error: problem, name: fields.name || "" }, 400) : fail(400, problem);
  }
  const project = await deps.db.createProject({ name, ownerId: user.id });
  await deps.db.addAudit({ projectId: project.id, userId: user.id, action: "project.create", detail: { name, slug: project.slug } });
  return form ? redirect(`/p/${project.slug}/settings#access-keys`, 303) : json(201, { project: publicProject({ ...project, role: "owner" }) });
}

async function projectRoute(request, deps, user, slug, rest, url) {
  const api = rest === "/api" || rest.startsWith("/api/");
  const files = rest.startsWith("/files/");
  if (!user) return api || files ? fail(401, "sign in first") : redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  const project = await deps.db.getProjectBySlug(slug);
  const member = project && (await deps.db.getMember(project.id, user.id));
  // Not a member reads exactly as no such project, so slugs of other people's projects cannot be probed.
  if (!member) return api || files ? fail(404, `no project ${slug}`) : noticePage(404, "No such project", `There is no project ${slug} among yours.`, { link: { href: "/", label: "Your projects" } });
  if (api) return projectApi(request, deps, user, project, member, rest.slice("/api".length));
  if (request.method !== "GET" && request.method !== "HEAD") return fail(405, "method not allowed");
  if (files) return file(deps, project, rest.slice("/files/".length));
  return interfaceFile(deps, project, rest.slice(1));
}

async function projectApi(request, deps, user, project, member, route) {
  const { db } = deps;
  const owner = member.role === "owner";
  if (request.method === "GET" || request.method === "HEAD") {
    if (route === "/me") return json(200, { user: { email: user.email, name: user.name }, project: { name: project.name, slug: project.slug, role: member.role } });
    if (route === "/keys") return json(200, { keys: (await db.listAccessKeys(project.id)).map(publicKey), canManage: owner });
    const answer = await readRoute(db, project, user.id, `/api${route}`, { now: nowOf(deps) });
    return answer ? json(answer.status, answer.body) : fail(404, `no endpoint ${request.method} /api${route}`);
  }
  if (request.method !== "POST") return fail(405, "method not allowed");
  const { fields, error } = await readFields(request);
  if (error) return fail(400, error);

  const seen = /^\/problems\/([^/]+)\/seen$/.exec(route);
  if (seen) {
    if (typeof fields.seen !== "boolean") return fail(400, 'body must be JSON like {"seen": true}');
    const problemId = decodeURIComponent(seen[1]);
    const run = await problemRun(db, project, problemId);
    if (!run) return fail(404, `no problem ${problemId}`);
    await db.setSeen({ projectId: project.id, runId: run.id, userId: user.id, problemId, seen: fields.seen });
    return json(200, { ok: true });
  }
  if (route === "/keys" || /^\/keys\/[^/]+\/revoke$/.test(route)) {
    if (!owner) return fail(403, "only an owner of this project can create or revoke its keys");
    if (route === "/keys") {
      const name = fields.name == null ? "default" : typeof fields.name === "string" ? fields.name.trim().replace(/\s+/g, " ") : "";
      if (!name || name.length > 60) return fail(400, "a key needs a name of 1 to 60 characters");
      const key = await db.createAccessKey(project.id, { name });
      await db.addAudit({ projectId: project.id, userId: user.id, action: "key.create", detail: { keyId: key.id, name } });
      return json(201, { key: publicKey(key), secret: key.secret });
    }
    const id = decodeURIComponent(route.split("/")[2]);
    const key = await db.getAccessKey(id);
    if (!key || key.projectId !== project.id) return fail(404, `no key ${id} in this project`);
    if (!key.revokedAt) {
      await db.revokeAccessKey(id);
      await db.addAudit({ projectId: project.id, userId: user.id, action: "key.revoke", detail: { keyId: id, name: key.name } });
    }
    return json(200, { key: publicKey(await db.getAccessKey(id)) });
  }
  return fail(404, `no endpoint POST /api${route}`);
}

// ---------- files and the interface ----------

/** A file of a ready run of this project: a redirect to storage, which serves it from its own origin. */
async function file(deps, project, rel) {
  let parts;
  try {
    parts = rel.split("/").map(decodeURIComponent);
  } catch {
    return fail(404, "not found");
  }
  const [runs, runId, ...rest] = parts;
  const filePath = rest.join("/");
  if (runs !== "runs" || !runId || !filePath || rest.some((s) => !s || s === "." || s === "..")) return fail(404, "not found");
  const run = await deps.db.getRun(runId);
  const found = run?.projectId === project.id && run.status === "ready" ? run.files.find((f) => f.path === filePath) : null;
  if (!found) return fail(404, "not found");
  return redirect(await deps.storage.presignGet(found.key, { expiresIn: FILE_URL_SECONDS }), 302, { "cache-control": "private, no-store" });
}

const scriptHashes = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, body]) => `'sha256-${crypto.createHash("sha256").update(body).digest("base64")}'`);

/** The interface's Content-Security-Policy: its own scripts, its inline theme script, fonts, and storage for media. */
export function interfaceCsp(html, storageOrigin) {
  const media = ["'self'", ...(storageOrigin ? [storageOrigin] : [])].join(" ");
  return [
    "default-src 'none'",
    `script-src 'self' ${scriptHashes(html).join(" ")}`.trim(),
    // Inline style attributes are part of the interface's markup (CSS variables on elements); no inline script is.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    `img-src ${media} data:`,
    `media-src ${media}`,
    "connect-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

async function interfaceFile(deps, project, rel) {
  const assets = await loadAssets();
  let name;
  try {
    name = decodeURIComponent(rel);
  } catch {
    return fail(404, "not found");
  }
  // The interface's own files; every other path is a page of it (it routes with the History API).
  if (name && path.posix.extname(name) && !name.endsWith(".html")) {
    const bytes = assets.app.get(name);
    if (!bytes || name.split("/").includes("..")) return fail(404, "not found");
    return new Response(bytes, { headers: { "content-type": typeOf(name), "cache-control": "no-cache" } });
  }
  const html = markIndex(assets.app.get("index.html").toString("utf8"), "cloud", `/p/${project.slug}`);
  return page(200, html, { csp: interfaceCsp(html, deps.storage.origin && deps.storage.origin !== new URL(deps.publicUrl).origin ? deps.storage.origin : null) });
}
