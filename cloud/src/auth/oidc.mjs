// Google sign-in with OpenID Connect, on fetch and node:crypto alone: the authorization code flow with PKCE, state and
// nonce. Discovery and the signing keys (JWKS) are fetched from the provider and cached; an ID token is accepted only
// when its RS256 signature checks against a published key and its iss, aud, exp, iat and nonce are as expected.
import crypto from "node:crypto";

export const GOOGLE_DISCOVERY = "https://accounts.google.com/.well-known/openid-configuration";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
export const SCOPES = "openid email profile";
const DISCOVERY_TTL = 3600 * 1000;
const JWKS_TTL = 3600 * 1000;
const JWKS_REFETCH_GAP = 60 * 1000; // an unknown kid refetches at most this often, so bad tokens cannot flood Google
const SKEW = 60; // seconds of clock difference tolerated on exp and iat

export class OidcError extends Error {}

const b64json = (part) => {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new OidcError("the ID token is not a JWT");
  }
};

/** S256 code challenge for a PKCE verifier. */
export const codeChallenge = (verifier) => crypto.createHash("sha256").update(verifier).digest("base64url");

/**
 * opts: { clientId, clientSecret, redirectUri, discoveryUrl (default Google's), issuers (default Google's two forms),
 * fetch, now: () => Date }.
 */
export function oidcClient({ clientId, clientSecret, redirectUri, discoveryUrl = GOOGLE_DISCOVERY, issuers = GOOGLE_ISSUERS, fetch = globalThis.fetch, now = () => new Date() }) {
  for (const [name, value] of Object.entries({ clientId, clientSecret, redirectUri })) if (!value) throw new Error(`Google sign-in needs ${name}`);
  let discovery = null;
  let jwks = null; // { keys: Map(kid -> KeyObject), at, tried }

  const getJson = async (url, what) => {
    let res;
    try {
      res = await fetch(url, { headers: { accept: "application/json" } });
    } catch (error) {
      throw new OidcError(`could not reach the sign-in provider for ${what}: ${error.cause?.message || error.message}`);
    }
    if (!res.ok) throw new OidcError(`the sign-in provider answered ${res.status} for ${what}`);
    return res.json();
  };

  async function config() {
    if (discovery && now().getTime() - discovery.at < DISCOVERY_TTL) return discovery.value;
    const value = await getJson(discoveryUrl, "its configuration");
    for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) if (typeof value[k] !== "string") throw new OidcError(`the provider's configuration has no ${k}`);
    discovery = { value, at: now().getTime() };
    return value;
  }

  async function loadKeys() {
    const { keys = [] } = await getJson((await config()).jwks_uri, "its signing keys");
    const map = new Map();
    for (const jwk of keys) {
      if (jwk.kty !== "RSA" || !jwk.kid || (jwk.use && jwk.use !== "sig")) continue;
      try {
        map.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: "jwk" }));
      } catch {} // a key this runtime cannot read is skipped, not fatal
    }
    jwks = { keys: map, at: now().getTime(), tried: now().getTime() };
  }

  /** The public key for `kid`: from the cache, refetched when stale or when the kid is new to it. */
  async function keyFor(kid) {
    const t = now().getTime();
    if (!jwks || t - jwks.at > JWKS_TTL) await loadKeys();
    else if (!jwks.keys.has(kid) && t - jwks.tried > JWKS_REFETCH_GAP) await loadKeys();
    return jwks.keys.get(kid) || null;
  }

  return {
    /** Where to send the browser. */
    async authorizationUrl({ state, nonce, verifier }) {
      const url = new URL((await config()).authorization_endpoint);
      const params = { response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: SCOPES, state, nonce, code_challenge: codeChallenge(verifier), code_challenge_method: "S256", prompt: "select_account" };
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      return url.href;
    },

    /** Trade the code for tokens; returns the ID token (a JWT string). */
    async exchange(code, verifier) {
      const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret, code_verifier: verifier });
      let res;
      try {
        res = await fetch((await config()).token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
      } catch (error) {
        throw new OidcError(`could not reach the sign-in provider: ${error.cause?.message || error.message}`);
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.id_token !== "string") throw new OidcError(`the sign-in provider refused the code (${res.status}${data.error ? `: ${data.error}` : ""})`);
      return data.id_token;
    },

    /** The claims of a valid ID token for this client and `nonce`; throws OidcError otherwise. */
    async verify(token, { nonce }) {
      const parts = String(token).split(".");
      if (parts.length !== 3) throw new OidcError("the ID token is not a JWT");
      const [h, p, s] = parts;
      const header = b64json(h);
      if (header.alg !== "RS256") throw new OidcError(`the ID token is signed with ${header.alg}, not RS256`);
      const key = await keyFor(header.kid);
      if (!key) throw new OidcError("the ID token is signed with a key the provider does not publish");
      let signed = false;
      try {
        signed = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"));
      } catch {} // a malformed signature is a wrong one
      if (!signed) throw new OidcError("the ID token's signature does not match");
      const claims = b64json(p);
      if (!issuers.includes(claims.iss)) throw new OidcError(`the ID token was issued by ${claims.iss}, not the sign-in provider`);
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      // azp (the party the token was issued to) must be this client whenever it is present, and must be present when
      // the token has more than one audience.
      if (!aud.includes(clientId) || ((aud.length > 1 || claims.azp !== undefined) && claims.azp !== clientId)) throw new OidcError("the ID token is for another application");
      const t = Math.floor(now().getTime() / 1000);
      if (typeof claims.exp !== "number" || claims.exp < t - SKEW) throw new OidcError("the ID token has expired");
      if (typeof claims.iat !== "number" || claims.iat > t + SKEW) throw new OidcError("the ID token was issued in the future");
      if (typeof claims.nonce !== "string" || !nonce || claims.nonce !== nonce) throw new OidcError("the ID token does not belong to this sign-in");
      if (typeof claims.sub !== "string" || !claims.sub) throw new OidcError("the ID token names no account");
      return claims;
    },
  };
}
