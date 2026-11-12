// Browser sessions: a random 32-byte token in an HttpOnly cookie, of which only the SHA-256 is stored. A session lasts
// 30 days from its last use (refreshed at most once a day, so reads do not write on every request); signing out
// deletes it, and signing out everywhere deletes every session of the person.
import { cookie, cookies, randomToken, sha256 } from "../http.mjs";

export const SESSION_DAYS = 30;
const DAY = 24 * 3600 * 1000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Plain http is only for this machine, where nothing is on the wire. */
export const isLocalHttp = (publicUrl) => {
  const u = new URL(publicUrl);
  return u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname);
};

/**
 * The cookie names and flags for PUBLIC_URL: __Host- and Secure on https; on http://localhost (local development
 * only) plain names without Secure, which a browser would refuse to store over http.
 */
export function cookieNames(publicUrl) {
  const secure = !isLocalHttp(publicUrl);
  const prefix = secure ? "__Host-" : "";
  return { session: `${prefix}imitor_session`, signin: `${prefix}imitor_signin`, secure };
}

const nowOf = (deps) => deps.now?.() || new Date();

/** A new session for `userId`; returns the Set-Cookie header value. */
export async function startSession(deps, userId) {
  const token = randomToken(32);
  const expiresAt = new Date(nowOf(deps).getTime() + SESSION_DAYS * DAY).toISOString();
  await deps.db.createSession({ idHash: sha256(token), userId, expiresAt });
  const names = cookieNames(deps.publicUrl);
  return cookie(names.session, token, { maxAge: SESSION_DAYS * 24 * 3600, secure: names.secure });
}

export const clearSessionCookie = (deps) => {
  const names = cookieNames(deps.publicUrl);
  return cookie(names.session, "", { maxAge: 0, secure: names.secure });
};

/**
 * The signed-in person for a request: { user, session, setCookie } (setCookie when the session was refreshed or must
 * be cleared), or { user: null, setCookie } when there is none. A session of a person no longer allowed is ended.
 */
export async function currentUser(request, deps) {
  const names = cookieNames(deps.publicUrl);
  const token = cookies(request)[names.session];
  if (!token) return { user: null };
  const idHash = sha256(token);
  const session = await deps.db.getSession(idHash);
  const t = nowOf(deps).getTime();
  if (!session) return { user: null, setCookie: clearSessionCookie(deps) };
  if (Date.parse(session.expiresAt) <= t) {
    await deps.db.deleteSession(idHash);
    return { user: null, setCookie: clearSessionCookie(deps) };
  }
  const user = await deps.db.getUser(session.userId);
  if (!user?.allowed) {
    await deps.db.deleteSession(idHash);
    return { user: null, setCookie: clearSessionCookie(deps) };
  }
  let setCookie;
  if (Date.parse(session.expiresAt) - t < (SESSION_DAYS - 1) * DAY) {
    const expiresAt = new Date(t + SESSION_DAYS * DAY).toISOString();
    await deps.db.updateSession(idHash, { expiresAt });
    session.expiresAt = expiresAt;
    setCookie = cookie(names.session, token, { maxAge: SESSION_DAYS * 24 * 3600, secure: names.secure });
  }
  return { user, session, setCookie };
}

/** Delete this request's session (sign out). */
export async function endSession(request, deps) {
  const token = cookies(request)[cookieNames(deps.publicUrl).session];
  if (token) await deps.db.deleteSession(sha256(token));
}

/**
 * Whether a request that changes something came from a page of this server: its Origin, or without one its Referer,
 * must be PUBLIC_URL's origin. Cookies ride along with cross-site form posts; these headers say where they came from.
 */
export function sameOrigin(request, publicUrl) {
  const expected = new URL(publicUrl).origin;
  const origin = request.headers.get("origin");
  if (origin) return origin === expected;
  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === expected;
  } catch {
    return false;
  }
}
