/**
 * scripts/update.mjs
 * Weekly auto-update for The Bengal Reader.
 * Run by GitHub Actions every Sunday night.
 *
 * Sources checked:
 *   1. enforcement.gov.in — ED press releases (Bengal-filtered)
 *   2. Google News RSS — per-case keyword queries
 *   3. cbi.gov.in — CBI press releases (Bengal-filtered)
 *
 * What it does:
 *   - Adds timeline entries for confirmed new developments
 *   - Updates lastUpdated field on matched cases
 *   - Bumps meta.json autoChecked timestamp
 *   - Never deletes existing data — only appends
 *
 * To add a new case to auto-tracking: add its id and keywords to CASE_KEYWORDS below.
 */

import { readFileSync, writeFileSync } from 'node:fs';

// ── Keywords per case ─────────────────────────────────────────────────────────
// Each array: first item is the primary Google News search query.
// All items are checked against ED/CBI press release text.
const CASE_KEYWORDS = {
  'saradha':              ['Saradha chit fund', 'Saradha scam court', 'Madan Mitra Saradha', 'Kunal Ghosh Saradha'],
  'rose-valley':          ['Rose Valley ponzi', 'Rose Valley court', 'Sudip Bandyopadhyay court'],
  'narada':               ['Narada sting case', 'Narada case Calcutta', 'Firhad Hakim court'],
  'ssc-scam':             ['SSC recruitment scam Bengal', 'Partha Chatterjee court SSC', 'Manik Bhattacharya SSC', 'school job scam Bengal'],
  'cattle-trafficking':   ['Anubrata Mondal court', 'cattle smuggling Bengal CBI', 'Sukanya Mondal court'],
  'coal-mafia':           ['Vinay Mishra coal Bengal', 'coal mafia Bengal ED', 'Anup Majee Bengal'],
  'ration-scam':          ['Jyoti Priya Mallick court', 'ration scam Bengal ED', 'PDS scam Bengal'],
  'post-poll-violence-2021': ['post poll violence Bengal 2021 CBI', 'Bengal violence 2021 court', 'NHRC Bengal 2021'],
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtMonthYear(d) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getFullYear()} ${months[d.getMonth()]}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function thisMonth() {
  return today().slice(0, 7);
}

async function safeFetch(url, opts = {}) {
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

// ── Google News RSS ───────────────────────────────────────────────────────────
async function fetchGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
  const xml = await safeFetch(url);
  if (!xml) return [];

  const items = [];
  const rx = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = rx.exec(xml)) !== null) {
    const body = m[1];
    const title = (/<title><!\[CDATA\[([\s\S]*?)\]\]>/.exec(body) || /<title>([\s\S]*?)<\/title>/.exec(body) || [])[1];
    const pub   = (/<pubDate>([\s\S]*?)<\/pubDate>/.exec(body) || [])[1];
    if (title && pub) {
      const date = new Date(pub);
      if (!isNaN(date)) items.push({ title: title.replace(/<[^>]+>/g, '').trim(), date });
    }
  }
  return items;
}

// ── ED press releases ─────────────────────────────────────────────────────────
async function fetchEDReleases() {
  const html = await safeFetch('https://enforcement.gov.in/press-releases');
  if (!html) return [];

  const results = [];
  // Extract links + text from the press releases list
  const rx = /href="([^"]*(?:press|release|attachment)[^"]*)"[^>]*>([\s\S]{10,300}?)<\/a>/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (text.length > 15 && /Bengal|Kolkata|Calcutta|Saradha|SSC|Narada|Rose Valley|Mallick|Mondal|Mishra|coal|cattle|ration/i.test(text)) {
      results.push({ url: m[1], title: text.slice(0, 200) });
    }
  }
  return results;
}

// ── CBI press releases ────────────────────────────────────────────────────────
async function fetchCBIReleases() {
  const html = await safeFetch('https://cbi.gov.in/press-release');
  if (!html) return [];

  const results = [];
  const rx = /href="([^"]*press[^"]*)"[^>]*>([\s\S]{10,300}?)<\/a>/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (text.length > 15 && /Bengal|Kolkata|Saradha|SSC|Narada|Rose Valley|Mondal|cattle|coal|ration/i.test(text)) {
      results.push({ url: m[1], title: text.slice(0, 200) });
    }
  }
  return results;
}

// ── Already-seen guard ────────────────────────────────────────────────────────
// Returns true if this timeline entry (by URL or this-week fingerprint) was already added.
function alreadySeen(timeline, sourceUrl, weekKey) {
  return timeline.some(t =>
    (sourceUrl && t.autoFrom === sourceUrl) ||
    (t.autoAdded && t.autoAdded.slice(0, 7) === weekKey)
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const cases = JSON.parse(readFileSync('data/cases.json', 'utf-8'));
  const meta  = JSON.parse(readFileSync('data/meta.json', 'utf-8'));
  const now   = new Date();
  const cutoff = new Date(now - 8 * 86400_000); // 8 days ago

  let totalChanges = 0;

  // 1. ED press releases
  console.log('\n── Fetching ED press releases…');
  const edReleases = await fetchEDReleases();
  console.log(`   Found ${edReleases.length} Bengal-relevant releases`);
  for (const c of cases) {
    const kws = CASE_KEYWORDS[c.id] || [];
    for (const r of edReleases) {
      if (kws.some(kw => r.title.toLowerCase().includes(kw.toLowerCase().split(' ')[0]))) {
        if (!alreadySeen(c.timeline, r.url, thisMonth())) {
          c.timeline.push({
            date: fmtMonthYear(now),
            event: `ED: ${r.title}`,
            autoAdded: today(),
            autoFrom: r.url,
            source: 'ED press release',
          });
          c.lastUpdated = thisMonth();
          totalChanges++;
          console.log(`   + ED → ${c.id}: ${r.title.slice(0, 60)}…`);
        }
      }
    }
  }

  // 2. CBI press releases
  console.log('\n── Fetching CBI press releases…');
  const cbiReleases = await fetchCBIReleases();
  console.log(`   Found ${cbiReleases.length} Bengal-relevant releases`);
  for (const c of cases) {
    const kws = CASE_KEYWORDS[c.id] || [];
    for (const r of cbiReleases) {
      if (kws.some(kw => r.title.toLowerCase().includes(kw.toLowerCase().split(' ')[0]))) {
        if (!alreadySeen(c.timeline, r.url, thisMonth())) {
          c.timeline.push({
            date: fmtMonthYear(now),
            event: `CBI: ${r.title}`,
            autoAdded: today(),
            autoFrom: r.url,
            source: 'CBI press release',
          });
          c.lastUpdated = thisMonth();
          totalChanges++;
          console.log(`   + CBI → ${c.id}: ${r.title.slice(0, 60)}…`);
        }
      }
    }
  }

  // 3. Google News RSS per case
  console.log('\n── Fetching Google News per case…');
  for (const c of cases) {
    const kws = CASE_KEYWORDS[c.id];
    if (!kws) { console.log(`   skip ${c.id} (no keywords)`); continue; }

    const items = await fetchGoogleNews(kws[0]);
    const recent = items.filter(n => n.date > cutoff);

    if (recent.length >= 3 && !alreadySeen(c.timeline, null, thisMonth())) {
      const headline = recent[0].title.slice(0, 120);
      c.timeline.push({
        date: fmtMonthYear(now),
        event: `${recent.length} news reports this week. Latest: "${headline}"`,
        autoAdded: today(),
        source: 'Google News RSS',
      });
      c.lastUpdated = thisMonth();
      totalChanges++;
      console.log(`   + news → ${c.id}: ${recent.length} articles`);
    } else {
      console.log(`   · ${c.id}: ${recent.length} recent articles — no update`);
    }

    await new Promise(r => setTimeout(r, 600)); // rate-limit politeness
  }

  // 4. Update meta
  meta.autoChecked = today();

  // 5. Write files
  writeFileSync('data/cases.json', JSON.stringify(cases, null, 2));
  writeFileSync('data/meta.json',  JSON.stringify(meta,  null, 2));

  console.log(`\n✓ Done. ${totalChanges} timeline entries added. autoChecked: ${meta.autoChecked}`);
  process.exit(0);
}

main().catch(err => { console.error('Update script failed:', err); process.exit(1); });
