/**
 * scripts/lib/fetch.mjs
 * Network utilities: safeFetch and concurrency pool.
 */

/**
 * Fetch a URL, returning text or null on failure. Never throws.
 * Attaches a 15-second timeout and a consistent User-Agent header.
 */
export async function safeFetch(url, opts = {}) {
  try {
    const res = await fetch(url, {
      ...opts,
      headers: { 'User-Agent': 'BengalReader/1.0 (public transparency project)', ...opts.headers },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    console.warn(`  fetch failed: ${url} — ${e.message}`);
    return null;
  }
}

/**
 * Run async fn over items with at most `limit` concurrent workers.
 * Returns an array of results (same order as items). Errors are caught and
 * stored as { error } objects rather than thrown.
 */
export async function withConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = { error: e };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
