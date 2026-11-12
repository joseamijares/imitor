// A small in-memory count of failures per key (a client address) within a window, for the admin token form. It lives
// in one process: on a serverless platform every instance counts on its own, so it slows guessing down rather than
// capping it exactly (the token's 32+ random characters are what make guessing hopeless).

/**
 * opts: { limit (failures allowed per window), windowMs, now: () => Date, maxKeys (entries kept at most) }.
 * blocked(key) -> ms until the key may try again, or 0. fail(key) -> failures in the current window. clear(key).
 */
export function throttle({ limit = 5, windowMs = 10 * 60 * 1000, now = () => new Date(), maxKeys = 10000 } = {}) {
  const entries = new Map(); // key -> { count, since }
  const t = () => now().getTime();
  const live = (key) => {
    const e = entries.get(key);
    if (e && t() - e.since >= windowMs) {
      entries.delete(key);
      return null;
    }
    return e || null;
  };
  return {
    limit,
    windowMs,
    blocked(key) {
      const e = live(key);
      return e && e.count >= limit ? e.since + windowMs - t() : 0;
    },
    fail(key) {
      const e = live(key);
      if (e) return ++e.count;
      if (entries.size >= maxKeys) {
        for (const [k, v] of entries) if (t() - v.since >= windowMs) entries.delete(k);
        if (entries.size >= maxKeys) entries.delete(entries.keys().next().value); // the oldest
      }
      entries.set(key, { count: 1, since: t() });
      return 1;
    },
    clear(key) {
      entries.delete(key);
    },
  };
}

/** The client's address as the platform or proxy in front reports it (x-forwarded-for's first entry), or "unknown". */
export function clientAddress(request) {
  const forwarded = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}
