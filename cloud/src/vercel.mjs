// Imitor Cloud as Vercel functions on the site's own Vercel project (root api/cloud.mjs and api/cron-retention.mjs
// are one-line shims for these). The cloud answers only on its own host, PUBLIC_URL's (imitor-app.vercel.app, a
// separate site from imitor.vercel.app because vercel.app is on the Public Suffix List), only in production: a
// preview deployment or the site's host gets 404. The root vercel.json rewrites the app host's paths to /api/cloud
// with the original path in ?__imitor_path=, because a rewrite may change the URL the function sees.
import { failure, handle, retention } from "./api.mjs";
import { fail, json, safeEqual, secure } from "./http.mjs";
import { depsFromEnv } from "./server.mjs";

export const PATH_PARAM = "__imitor_path";
const NO_STORE = "private, no-store";

/**
 * The request as the client sent it: the host from x-forwarded-host, the path from ?__imitor_path= when a rewrite
 * moved it there (else the URL's own), without a trailing slash (the site's trailingSlash adds one to every path).
 */
export function originalRequest(request) {
  const url = new URL(request.url);
  const moved = url.searchParams.get(PATH_PARAM);
  if (moved != null) {
    url.searchParams.delete(PATH_PARAM);
    url.pathname = moved.startsWith("/") ? moved : `/${moved}`;
  }
  const host = request.headers.get("x-forwarded-host");
  if (host) url.host = host;
  url.protocol = "https:";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return new Request(url, request);
}

/** Every answer of these functions: never cached anywhere, with the security headers. */
const finish = (response) => {
  response.headers.set("cache-control", NO_STORE);
  return secure(response, { https: true });
};

/** Why this deployment must not answer as the cloud, or null: only production, only on PUBLIC_URL's host. */
function refused(request, env) {
  if (env.VERCEL_ENV !== "production" || !env.PUBLIC_URL) return true;
  const host = request.headers.get("x-forwarded-host") || new URL(request.url).host;
  return host !== new URL(env.PUBLIC_URL).host;
}

/** A production deployment keeps nothing in memory: it needs the database and the bucket. */
function configured(env) {
  const missing = ["DATABASE_URL", "S3_BUCKET", "PUBLIC_URL"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Imitor Cloud on Vercel needs ${missing.join(", ")}`);
  return depsFromEnv(env, { poolMax: 1 });
}

/**
 * The cloud's function. opts: { deps } to use instead of the environment's (tests). deps are built once per instance,
 * so the database pool and Google's signing keys are reused across requests.
 */
export function cloudFunction(env = process.env, { deps = null } = {}) {
  return {
    async fetch(request) {
      if (refused(request, env)) return finish(fail(404, "not found"));
      try {
        deps ||= configured(env);
      } catch (error) {
        console.error(error);
        return finish(fail(500, "this server is not configured yet"));
      }
      return finish(await handle(originalRequest(request), deps));
    },
  };
}

/**
 * The daily retention run (Vercel Cron: GET with Authorization: Bearer <CRON_SECRET>), production only. It answers on
 * any path: vercel.json's cron calls /api/cron-retention/, since trailingSlash answers the bare path with a 308 that
 * Vercel Cron does not follow.
 */
export function cronFunction(env = process.env, { deps = null } = {}) {
  return {
    async fetch(request) {
      if (env.VERCEL_ENV !== "production" || !env.CRON_SECRET) return finish(fail(404, "not found"));
      const auth = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") || "");
      if (!auth || !safeEqual(auth[1], env.CRON_SECRET)) return finish(fail(401, "this call needs Authorization: Bearer <CRON_SECRET>"));
      try {
        deps ||= configured(env);
      } catch (error) {
        console.error(error);
        return finish(fail(500, "this server is not configured yet"));
      }
      try {
        return finish(json(200, await retention(deps)));
      } catch (error) {
        console.error(error);
        return finish(failure(request, error));
      }
    },
  };
}

export default cloudFunction();
