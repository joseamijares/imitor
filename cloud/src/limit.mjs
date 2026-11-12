// Storage calls for a run's files (up to 5000) go out a few at a time: not one by one, not all at once.
export const CONCURRENCY = 16;

/** fn over items with at most `limit` calls in flight; results in the order of items. */
export async function mapLimit(items, fn, limit = CONCURRENCY) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
