// The Vercel functions (cloud/src/vercel.mjs, behind the root api/ shims) with fake Requests: only production, only
// the app host, nothing cached, the path restored from the rewrite, and the cron run behind its secret.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSite } from "../../site/build.mjs";
import { cloudFunction, cronFunction, originalRequest } from "../src/vercel.mjs";
import { HOME } from "../src/web.mjs";
import { cloud } from "./helpers.mjs";

const APP = "https://app.imitor.dev";
const SECRET = crypto.randomBytes(32).toString("base64url");
const ENV = { VERCEL_ENV: "production", PUBLIC_URL: APP, DATABASE_URL: "postgres://unused", S3_BUCKET: "unused", CRON_SECRET: SECRET };
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** A request as Vercel hands it to /api/cloud after the root vercel.json's rewrite. */
const rewritten = (path, { host = "app.imitor.dev", method = "GET", headers = {}, body } = {}) => {
  const [p, q = ""] = path.split("?");
  return new Request(`https://${host}/api/cloud/?__imitor_path=${encodeURIComponent(p)}${q ? `&${q}` : ""}`, { method, headers: { "x-forwarded-host": host, ...headers }, body });
};

function setup(env = ENV) {
  const c = cloud({ adminToken: SECRET });
  c.deps.publicUrl = APP;
  return { ...c, fn: cloudFunction(env, { deps: c.deps }) };
}

test("only production, only the app host: everything else is 404 before the cloud is touched", async () => {
  const { fn } = setup();
  assert.equal((await fn.fetch(rewritten("/login"))).status, 200);
  for (const [why, request, env] of [
    ["the site's host", rewritten("/login", { host: "imitor.dev" }), ENV],
    ["a preview deployment's host", rewritten("/login", { host: "imitor-git-branch-x.vercel.app" }), ENV],
    ["a preview deployment", rewritten("/login"), { ...ENV, VERCEL_ENV: "preview" }],
    ["development", rewritten("/login"), { ...ENV, VERCEL_ENV: "development" }],
    ["no PUBLIC_URL", rewritten("/login"), { ...ENV, PUBLIC_URL: "" }],
  ]) {
    const res = await cloudFunction(env, { deps: setup().deps }).fetch(request);
    assert.equal(res.status, 404, why);
    assert.equal(res.headers.get("cache-control"), "private, no-store", why);
  }
  const unconfigured = await cloudFunction({ VERCEL_ENV: "production", PUBLIC_URL: APP }).fetch(rewritten("/login"));
  assert.equal(unconfigured.status, 500, "production without a database or bucket refuses rather than keep things in memory");
  const db = { VERCEL_ENV: "production", PUBLIC_URL: APP, DATABASE_URL: "postgres://u:p@127.0.0.1:1/x" };
  assert.equal((await cloudFunction(db).fetch(rewritten("/login"))).status, 500, "a database alone is not enough: files need a store");
  const blob = await cloudFunction({ ...db, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_AbC123xyz_s3cr3t" }).fetch(rewritten("/login"));
  assert.equal(blob.status, 200, "a connected Vercel Blob store stands in for S3");
});

test("every answer is private, no-store, with the security headers; the path comes back from the rewrite", async () => {
  const { fn } = setup();
  const answers = [
    await fn.fetch(rewritten("/login/")),
    await fn.fetch(rewritten("/static/cloud.css")),
    await fn.fetch(rewritten("/p/fernwood/")),
    await fn.fetch(rewritten("/v1/runs/", { method: "POST", body: "{}" })),
    await fn.fetch(rewritten("/nope")),
  ];
  assert.deepEqual(answers.map((r) => r.status), [200, 200, 302, 401, 404]);
  assert.equal(answers[2].headers.get("location"), "/login?next=%2Fp%2Ffernwood", "the trailing slash the site adds is dropped");
  for (const r of answers) {
    assert.equal(r.headers.get("cache-control"), "private, no-store");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("referrer-policy"), "same-origin");
    assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  }
  const moved = originalRequest(rewritten("/p/fernwood/runs/?filter=main", { method: "POST", body: "{}" }));
  assert.equal(moved.url, `${APP}/p/fernwood/runs?filter=main`);
  assert.equal(await moved.text(), "{}");
  const direct = originalRequest(new Request("https://x.vercel.app/login", { headers: { "x-forwarded-host": "app.imitor.dev" } }));
  assert.equal(direct.url, `${APP}/login`, "a runtime that shows the original URL works the same");
});

test("a sign-in through the function: cookies and Origin checked against PUBLIC_URL", async () => {
  const { fn, deps } = setup();
  const page = await fn.fetch(rewritten("/login/token", { method: "POST", headers: { origin: APP, "content-type": "application/x-www-form-urlencoded" }, body: `token=${SECRET}` }));
  assert.equal(page.status, 303);
  assert.match(page.headers.getSetCookie()[0], /^__Host-imitor_session=.*; Secure; Max-Age=2592000$/);
  const csrf = await fn.fetch(rewritten("/login/token", { method: "POST", headers: { origin: "https://imitor.dev", "content-type": "application/x-www-form-urlencoded" }, body: `token=${SECRET}` }));
  assert.equal(csrf.status, 403, "the site's origin is another site");
  assert.ok(await deps.db.findUserByEmail("admin"));
});

test("cron: production only, Authorization: Bearer <CRON_SECRET>, runs retention", async () => {
  const { deps } = setup();
  const cron = cronFunction(ENV, { deps });
  const call = (auth, at = "/api/cron-retention/") => cron.fetch(new Request(`https://imitor.dev${at}`, { headers: auth ? { authorization: auth, "user-agent": "vercel-cron/1.0" } : {} }));
  assert.equal((await call(null)).status, 401);
  assert.equal((await call(`Bearer ${SECRET}x`)).status, 401);
  const ok = await call(`Bearer ${SECRET}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { projects: 0, pruned: 0, failed: 0, sessions: 0 });
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  assert.equal((await call(`Bearer ${SECRET}`, "/api/cron-retention")).status, 200, "with or without the trailing slash");
  assert.equal((await cronFunction({ ...ENV, VERCEL_ENV: "preview" }, { deps }).fetch(new Request("https://x/api/cron-retention", { headers: { authorization: `Bearer ${SECRET}` } }))).status, 404);
  assert.equal((await cronFunction({ ...ENV, CRON_SECRET: "" }, { deps }).fetch(new Request("https://x/api/cron-retention"))).status, 404);
});

/** vercel.json's redirect that sends the app host's other paths to the site, as a RegExp. */
const toSite = (v) => {
  const r = v.redirects.find((x) => x.destination.startsWith("https://imitor.dev/"));
  return new RegExp(`^${r.source.replace("/(", "/(?:")}$`);
};
/** The rewrite of the app host's paths to /api/cloud ("/:first(a|b)/:rest*"), as a RegExp. */
const toCloud = (v) => {
  const r = v.rewrites.find((x) => x.destination.startsWith("/api/cloud"));
  return new RegExp(`^${r.source.replace(":first(", "(").replace("/:rest*", "(?:/.*)?")}$`);
};

test("the root shims and vercel.json: two functions, the cloud's rewrites only on its host, a daily cron", async () => {
  const v = JSON.parse(fs.readFileSync(`${ROOT}vercel.json`, "utf8"));
  assert.deepEqual(fs.readdirSync(`${ROOT}api`).sort(), ["cloud.mjs", "cron-retention.mjs"]);
  assert.equal((await import("../../api/cloud.mjs")).default.fetch.constructor.name, "AsyncFunction");
  assert.equal(typeof (await import("../../api/cron-retention.mjs")).default.fetch, "function");
  assert.equal(v.installCommand, "npm ci --prefix cloud --omit=dev --ignore-scripts");
  // trailingSlash answers /api/cron-retention with a 308, and Vercel Cron does not follow redirects.
  assert.equal(v.trailingSlash, true);
  assert.deepEqual(v.crons, [{ path: "/api/cron-retention/", schedule: "17 4 * * *" }]);
  assert.ok(fs.existsSync(`${ROOT}cloud/package-lock.json`));
  const redirect = toSite(v);
  for (const p of ["/", "/login", "/login/", "/logout/", "/p/fernwood/runs/", "/v1/runs/", "/auth/google/callback/", "/projects/", "/static/cloud.css", "/api/cloud"]) assert.ok(!redirect.test(p), `${p} stays on the app host`);
  for (const p of ["/how-to-use/", "/demo/", "/robots.txt"]) assert.ok(redirect.test(p), `${p} goes to the site`);
  const rewrite = toCloud(v);
  for (const p of ["/login/", "/login/token/", "/logout/everywhere/", "/auth/google/callback/", `${HOME}/`, "/p/fernwood/runs/", "/v1/runs/", "/static/cloud.css"]) assert.ok(rewrite.test(p), `${p} reaches the cloud`);
  assert.ok(!rewrite.test("/"), "/ is the site's index.html, which a rewrite cannot reach");
});

test("no path the cloud answers on its host is a file of the site, and / on the app host goes to the projects page", () => {
  const v = JSON.parse(fs.readFileSync(`${ROOT}vercel.json`, "utf8"));
  // Vercel serves the site's files before any rewrite, so a cloud route that is also a file or folder of site/dist
  // would show the site instead. Redirects come before files.
  const out = buildSite({ out: fs.mkdtempSync(path.join(os.tmpdir(), "imitor-site-")) });
  const top = fs.readdirSync(out);
  assert.ok(top.includes("index.html"), "the site has a / of its own");
  const routes = [...new Set(["login", "logout", "auth", "projects", "p", "v1", "static", "api", HOME.slice(1), ...toCloud(v).source.match(/\(([a-z0-9|]+)\)/)[1].split("|")])];
  for (const r of routes) {
    for (const f of [r, `${r}.html`, `${r}/index.html`]) assert.ok(!fs.existsSync(path.join(out, f)), `site/dist/${f} would hide the cloud's /${r}`);
  }
  for (const entry of top) {
    if (entry === "index.html") continue;
    const p = fs.statSync(path.join(out, entry)).isDirectory() ? `/${entry}/` : `/${entry}`;
    assert.ok(toSite(v).test(p), `${p} is the site's: the app host sends it there`);
  }
  const home = v.redirects.find((r) => r.source === "/");
  assert.deepEqual(home, { source: "/", has: [{ type: "host", value: new URL(APP).host }], destination: `${HOME}/`, permanent: false });
  assert.ok(!v.rewrites.some((r) => r.source === "/"), "a rewrite of / would never run: index.html wins");
  fs.rmSync(out, { recursive: true, force: true });
});
