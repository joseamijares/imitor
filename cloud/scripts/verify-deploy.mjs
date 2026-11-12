#!/usr/bin/env node
// Checks a production deployment of the site and Imitor Cloud from the outside, without signing in: the routes the
// Vercel configuration is meant to produce, and the answers the cloud gives a stranger. Read-only: it sends GETs, and
// one POST /v1/runs with no key (answered 401 before anything is stored).
//
//   node cloud/scripts/verify-deploy.mjs [app URL] [site URL]
//   CRON_SECRET=... node cloud/scripts/verify-deploy.mjs      # also runs the retention job once and expects 200
//
// Defaults: https://app.imitor.dev and https://imitor.dev. Exits 1 if any check fails.

const app = new URL(process.argv[2] || "https://app.imitor.dev").origin;
const site = new URL(process.argv[3] || "https://imitor.dev").origin;
const results = [];

async function get(url, init = {}) {
  return fetch(url, { redirect: "manual", ...init, headers: { "user-agent": "imitor-verify-deploy", ...(init.headers || {}) } });
}

/** Follows at most `hops` redirects that keep the method (307/308), as `imitor push` does. */
async function follow(url, init, hops = 2) {
  let res = await get(url, init);
  while (hops-- > 0 && (res.status === 307 || res.status === 308)) res = await get(new URL(res.headers.get("location"), url), init);
  return res;
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, name, detail });
  } catch (error) {
    results.push({ ok: false, name, detail: error.message });
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const where = (res) => res.headers.get("location") || "";
const isJson = (res) => /application\/json/.test(res.headers.get("content-type") || "");

await check("site home answers 200", async () => {
  const res = await get(`${site}/`);
  expect(res.status === 200, `got ${res.status}`);
});

await check("demo answers 200, deep links included", async () => {
  for (const p of ["/demo/", "/demo/runs/"]) {
    const res = await follow(`${site}${p}`, {});
    expect(res.status === 200, `${p} got ${res.status}`);
  }
});

await check("cloud routes do not exist on the site host", async () => {
  for (const p of ["/login", "/projects/", "/v1/runs"]) {
    const res = await follow(`${site}${p}`, {});
    expect(res.status === 404, `${p} got ${res.status}`);
  }
});

await check("app host: / redirects to /projects/", async () => {
  const res = await get(`${app}/`);
  expect([301, 302, 307, 308].includes(res.status), `got ${res.status}`);
  expect(/\/projects\/?$/.test(where(res)), `to ${where(res)}`);
});

await check("app host: /projects/ sends a stranger to sign in (rewrite, path recovery and bundle work)", async () => {
  const res = await follow(`${app}/projects/`, { headers: { accept: "text/html" } });
  const why = { 404: " (the function refuses to run without DATABASE_URL and S3_BUCKET, or outside production)", 503: " (the database or storage cannot be reached)" };
  expect([302, 303].includes(res.status), `got ${res.status}${why[res.status] || ""}`);
  expect(/\/login/.test(where(res)), `to ${where(res)}`);
  expect(/private/.test(res.headers.get("cache-control") || ""), `cache-control is ${res.headers.get("cache-control")}`);
  return where(res);
});

await check("app host: the sign-in page renders with its CSP and styles", async () => {
  const res = await follow(`${app}/login`, {});
  expect(res.status === 200, `got ${res.status}`);
  const csp = res.headers.get("content-security-policy") || "";
  expect(/frame-ancestors 'none'/.test(csp), `CSP is "${csp}"`);
  const html = await res.text();
  expect(/Continue with Google/.test(html), "no Google button: is GOOGLE_CLIENT_ID set?");
  const css = await follow(`${app}/static/cloud.css`, {});
  expect(css.status === 200, `/static/cloud.css got ${css.status}`);
});

await check("app host: site pages redirect to the site", async () => {
  const res = await get(`${app}/how-to-use/`);
  expect([301, 302, 307, 308].includes(res.status) && where(res).startsWith(site), `got ${res.status} to ${where(res)}`);
});

await check("app host: POST /v1/runs without a key is a JSON 401 (trailing-slash redirect kept the method)", async () => {
  const res = await follow(`${app}/v1/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(res.status === 401, `got ${res.status}`);
  expect(isJson(res), `content-type is ${res.headers.get("content-type")}`);
});

await check("app host: the interface API refuses a stranger with JSON", async () => {
  const res = await follow(`${app}/p/nothing-here/api/project`, {});
  expect(res.status === 401 && isJson(res), `got ${res.status} ${res.headers.get("content-type")}`);
});

await check("retention cron refuses a call without the secret", async () => {
  const res = await follow(`${app}/api/cron-retention/`, {});
  expect(res.status === 401 || res.status === 404, `got ${res.status}`);
});

if (process.env.CRON_SECRET) {
  await check("retention cron runs with the secret", async () => {
    const res = await follow(`${app}/api/cron-retention/`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
    expect(res.status === 200, `got ${res.status}`);
    return JSON.stringify(await res.json());
  });
}

for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name}${r.detail ? `: ${r.detail}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} of ${results.length} checks failed.` : `\nAll ${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
