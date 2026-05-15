/**
 * scripts/lib/dedup.mjs
 * Date helpers and deduplication utilities for timeline entries.
 */

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Format a Date as "YYYY Mon" (e.g. "2026 Apr"). */
export function fmtMonthYear(d) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getFullYear()} ${months[d.getMonth()]}`;
}

/** Today's date as YYYY-MM-DD. */
export function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Current year-month as YYYY-MM. */
export function thisMonth() {
  return today().slice(0, 7);
}

/** Current time as a full ISO 8601 string. */
export function nowISO() {
  return new Date().toISOString();
}

// ── Dedup helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true if the given URL already appears as `autoFrom` in any timeline entry.
 * Returns false for null/undefined urls.
 */
export function urlSeen(timeline, url) {
  return url && timeline.some((t) => t.autoFrom === url);
}

/**
 * Returns true if a Google News RSS summary entry was already added today.
 */
export function newsSummaryAddedToday(timeline) {
  const t = today();
  return timeline.some((e) => e.autoAdded === t && e.source === 'Google News RSS');
}

/**
 * Returns true if no entry in the last 7 days contains the first 50 chars of title
 * (case-insensitive). Used to avoid adding duplicate headlines.
 */
export function headlineIsFresh(timeline, title) {
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const fp = title.toLowerCase().slice(0, 50);
  return !timeline.some((t) => t.autoAdded >= weekAgo && t.event && t.event.toLowerCase().includes(fp));
}
