// The waitlist for the hosted service, as a Vercel function of the site's project (root api/waitlist.mjs is a
// one-line shim for it). The pricing page of the public site posts an address here, from the site's own host; the
// address goes into the waitlist table and nowhere else. It sends the person no email, makes no user and admits
// nobody. With mail on and WAITLIST_NOTIFY_TO set, the operator gets a notice that the list grew, without the address
// in it. Production only, POST only, same origin only, and a few tries per client address in ten minutes.
import { fail, json, readFields, redirect, secure } from "./http.mjs";
import { pgDb } from "./db/pg.mjs";
import { mailFromEnv, notify } from "./mail/index.mjs";
import { clientAddress, throttle } from "./throttle.mjs";

export const MAX_EMAIL_LENGTH = 254;
/** Where a plain form post (no script) lands afterwards: the pricing page shows the matching message for each. */
export const JOINED = "/pricing/#joined";
export const NOT_JOINED = "/pricing/#not-joined";

/** The address trimmed and in lower case, or null when it is not one address of a plausible shape. */
export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH) return null;
  return /^[^\s@<>(),;:"\\]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email) ? email : null;
}

/** Whether the browser says the post came from another site (Origin, or Sec-Fetch-Site where it is sent). */
function crossSite(request) {
  const host = request.headers.get("x-forwarded-host") || new URL(request.url).host;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  // The whole origin, scheme included: the function only answers in production, which is https.
  return origin !== `https://${host}`;
}

const finish = (response) => {
  response.headers.set("cache-control", "private, no-store");
  return secure(response, { https: true });
};

/**
 * The waitlist's function. opts: { db (instead of the environment's Postgres, for tests), limiter (a throttle), mail
 * (deps.mail instead of the environment's, for tests) }.
 * JSON in, JSON out: 200 { ok: true } whether the address is new or already listed, so it tells nobody who is on
 * the list. A plain form post is answered with a redirect back to the pricing page instead.
 */
export function waitlistFunction(env = process.env, { db = null, limiter = throttle({ limit: 5, windowMs: 10 * 60 * 1000 }), mail = null } = {}) {
  // Tell the operator the list grew. Only for an address that is new (a repeat join, or a script posting one address
  // again and again, sends nothing), and never in the way of the join: a mail setting that is wrong is logged, and
  // notify() itself never throws. It is awaited because a function's work ends with its response.
  const tellOperator = async () => {
    const to = normalizeEmail(env.WAITLIST_NOTIFY_TO);
    if (!to) return;
    try {
      mail ??= mailFromEnv(env);
      await notify({ db, mail, log: (error) => console.error(error) }, "waitlist", { to });
    } catch (cause) {
      console.error(cause);
    }
  };
  return {
    async fetch(request) {
      if (env.VERCEL_ENV !== "production") return finish(fail(404, "not found"));
      if (request.method !== "POST") return finish(fail(405, "the waitlist takes a POST", {}, { allow: "POST" }));
      if (crossSite(request)) return finish(fail(403, "the waitlist is joined from the pricing page"));
      const { fields, form, error } = await readFields(request, 4 * 1024);
      const answer = (status, message) => finish(form ? redirect(status === 200 ? JOINED : NOT_JOINED, 303) : status === 200 ? json(200, { ok: true }) : fail(status, message));
      if (error) return answer(400, error);
      const address = clientAddress(request);
      const wait = limiter.blocked(address);
      if (wait) return form ? answer(429) : finish(fail(429, "too many tries from this address: try again in a few minutes", {}, { "retry-after": String(Math.ceil(wait / 1000)) }));
      limiter.fail(address);
      // A field people never see: only a script filling every field writes in it. It is told it worked.
      if (fields.website) return answer(200);
      const email = normalizeEmail(fields.email);
      if (!email) return answer(400, "that does not look like an email address");
      let added = false;
      try {
        if (!db) {
          if (!env.DATABASE_URL) throw new Error("the waitlist needs DATABASE_URL");
          db = pgDb({ connectionString: env.DATABASE_URL, max: 1 });
        }
        added = (await db.addWaitlist(email)).added;
      } catch (cause) {
        console.error(cause);
        return answer(503, "the waitlist cannot be reached right now");
      }
      if (added) await tellOperator();
      return answer(200);
    },
  };
}

export default waitlistFunction();
