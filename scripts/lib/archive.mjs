/**
 * scripts/lib/archive.mjs
 * Wayback Machine URL archiving utilities.
 */

import { withConcurrency } from './fetch.mjs';

/**
 * Submit a URL to the Wayback Machine save endpoint.
 * Fire-and-forget: never throws, never blocks the pipeline.
 * Returns the archive URL string if saved, or null on failure.
 */
export async function archiveUrl(url) {
  if (!url || !url.startsWith('http')) return null;
  try {
    const res = await fetch(`https://web.archive.org/save/${url}`, {
      method: 'GET',
      headers: { 'User-Agent': 'BengalReader/1.0 (public transparency archive)' },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
    if (res.ok || res.status === 302) {
      const loc = res.headers.get('Content-Location') || res.headers.get('location') || '';
      return loc ? `https://web.archive.org${loc}` : `https://web.archive.org/web/*/${url}`;
    }
  } catch {
    /* timeout or network failure — silently skip */
  }
  return null;
}

/**
 * Factory that creates an archive queue instance.
 *
 * Returns:
 *   { queue: Set, add(url), flush(concurrency) }
 *
 * - add(url): enqueue a URL for archiving (no-op for non-http URLs)
 * - flush(concurrency): submit all queued URLs to Wayback Machine in parallel,
 *   returns array of { url, archived } results
 */
export function createArchiveQueue() {
  const queue = new Set();

  function add(url) {
    if (url && url.startsWith('http')) queue.add(url);
  }

  async function flush(concurrency = 3) {
    if (queue.size === 0) return [];
    const results = await withConcurrency([...queue], concurrency, async (url) => {
      const archived = await archiveUrl(url);
      return { url, archived };
    });
    return results;
  }

  return { queue, add, flush };
}
