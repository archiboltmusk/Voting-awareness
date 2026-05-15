/**
 * scripts/update.mjs
 * Auto-update for The Bengal Reader — runs every hour via GitHub Actions.
 *
 * Sources:
 *   1. Google News RSS  — per-case keyword queries (primary)
 *   2. enforcement.gov.in — ED press releases (Bengal-filtered)
 *   3. cbi.gov.in       — CBI press releases (Bengal-filtered)
 *
 * ED + CBI fetches run in parallel.
 * Google News and pledge news fetches use a concurrency pool (3 at once).
 *
 * Writes:
 *   data/news.json  — rolling fresh headlines per case (overwritten every run)
 *   data/cases.json — permanent timeline entries for significant developments
 *   data/meta.json  — autoChecked timestamp
 *   sitemap.xml     — lastmod dates kept current
 *
 * New URLs added to timeline entries are asynchronously submitted to the
 * Internet Archive Wayback Machine (fire-and-forget, never blocks the run).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { safeFetch, withConcurrency } from './lib/fetch.mjs';
import { urlSeen, newsSummaryAddedToday, headlineIsFresh, today, thisMonth, nowISO, fmtMonthYear } from './lib/dedup.mjs';
import { createArchiveQueue } from './lib/archive.mjs';
import { createLogger } from './lib/logger.mjs';

// ── Keywords per case ─────────────────────────────────────────────────────────
const CASE_KEYWORDS = {
  saradha: ['Saradha chit fund', 'Saradha scam court', 'Madan Mitra Saradha', 'Kunal Ghosh Saradha'],
  'rose-valley': ['Rose Valley ponzi', 'Rose Valley court', 'Sudip Bandyopadhyay court'],
  narada: ['Narada sting case', 'Narada case Calcutta', 'Firhad Hakim court'],
  'ssc-scam': [
    'SSC recruitment scam Bengal',
    'Partha Chatterjee court SSC',
    'Manik Bhattacharya SSC',
    'school job scam Bengal',
  ],
  'cattle-trafficking': ['Anubrata Mondal court', 'cattle smuggling Bengal CBI', 'Sukanya Mondal court'],
  'coal-mafia': ['Vinay Mishra coal Bengal', 'coal mafia Bengal ED', 'Anup Majee Bengal'],
  'ration-scam': ['Jyoti Priya Mallick court', 'ration scam Bengal ED', 'PDS scam Bengal'],
  'post-poll-violence-2021': ['post poll violence Bengal 2021 CBI', 'Bengal violence 2021 court', 'NHRC Bengal 2021'],
};

// ── Step summary logger ───────────────────────────────────────────────────────
const logger = createLogger();
const summaryWrite = (line) => logger.write(line);
const flushSummary = () => logger.flush();

// ── Archive queue ─────────────────────────────────────────────────────────────
const archiver = createArchiveQueue();
const queueArchive = (url) => archiver.add(url);

// ── Google News RSS ───────────────────────────────────────────────────────────
async function fetchGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
  const xml = await safeFetch(url);
  if (!xml) return [];
  if (!xml.includes('<item>')) {
    console.warn(`  Google News: no <item> elements for query "${query}" — empty feed or changed format`);
    return [];
  }

  const items = [];
  const rx = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = rx.exec(xml)) !== null) {
    const body = m[1];
    const title =
      (/<title><!\[CDATA\[([\s\S]*?)\]\]>/.exec(body) || /<title>([\s\S]*?)<\/title>/.exec(body) || [])[1];
    const pub = (/<pubDate>([\s\S]*?)<\/pubDate>/.exec(body) || [])[1];
    const link = (/<link>([\s\S]*?)<\/link>/.exec(body) || [])[1];
    const src = (/<source[^>]*>([\s\S]*?)<\/source>/.exec(body) || [])[1];
    if (title && pub) {
      const date = new Date(pub);
      if (!isNaN(date)) {
        items.push({
          title: title.replace(/<[^>]+>/g, '').trim(),
          date,
          pubDate: date.toISOString().slice(0, 10),
          url: (link || '').trim(),
          source: (src || 'Google News').replace(/<[^>]+>/g, '').trim(),
        });
      }
    }
  }
  return items;
}

// ── ED press releases ─────────────────────────────────────────────────────────
async function fetchEDReleases() {
  const html = await safeFetch('https://enforcement.gov.in/press-releases');
  if (!html) return [];

  const results = [];
  const anchorRx = /<a\s[^>]*href=["']([^"']*(?:press|release|attachment)[^"']*)["'][^>]*>([\s\S]{1,400}?)<\/a>/gi;
  let m;
  while ((m = anchorRx.exec(html)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const href = m[1].trim();
    if (
      text.length > 15 &&
      /Bengal|Kolkata|Calcutta|Saradha|SSC|Narada|Rose Valley|Mallick|Mondal|Mishra|coal|cattle|ration/i.test(text)
    ) {
      results.push({ url: href, title: text.slice(0, 200) });
    }
  }
  if (results.length === 0) {
    console.warn('  ED: zero results — page structure may have changed');
  }
  return results;
}

// ── CBI press releases ────────────────────────────────────────────────────────
async function fetchCBIReleases() {
  const html = await safeFetch('https://cbi.gov.in/press-release');
  if (!html) return [];

  const results = [];
  const anchorRx = /<a\s[^>]*href=["']([^"']*press[^"']*)["'][^>]*>([\s\S]{1,400}?)<\/a>/gi;
  let m;
  while ((m = anchorRx.exec(html)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const href = m[1].trim();
    if (
      text.length > 15 &&
      /Bengal|Kolkata|Saradha|SSC|Narada|Rose Valley|Mondal|cattle|coal|ration/i.test(text)
    ) {
      results.push({ url: href, title: text.slice(0, 200) });
    }
  }
  if (results.length === 0) {
    console.warn('  CBI: zero results — page structure may have changed');
  }
  return results;
}

// ── Sitemap updater ───────────────────────────────────────────────────────────
function updateSitemap(dateStr) {
  const path = 'public/sitemap.xml';
  if (!existsSync(path)) return;
  try {
    const xml = readFileSync(path, 'utf-8');
    writeFileSync(path, xml.replace(/<lastmod>[^<]+<\/lastmod>/g, `<lastmod>${dateStr}</lastmod>`));
  } catch (e) {
    console.warn('sitemap update failed:', e.message);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const runDate = today();
  const runISO = nowISO();
  summaryWrite(`# Bengal Reader — Auto-Update ${runISO}`);
  summaryWrite('');

  const cases = JSON.parse(readFileSync('public/data/cases.json', 'utf-8'));
  const meta = JSON.parse(readFileSync('public/data/meta.json', 'utf-8'));
  const now = new Date();
  const cutoff24h = new Date(now - 24 * 3600_000);
  const cutoff7d = new Date(now - 7 * 86400_000);

  let timelineAdded = 0;
  const errors = [];

  // news.json accumulator — fresh every run
  const newsFeed = {};
  for (const c of cases) newsFeed[c.id] = { articles: [], count24h: 0, count7d: 0 };

  // ── 1+2. ED + CBI press releases (parallel) ───────────────────────────────
  summaryWrite('## Enforcement Directorate + CBI');
  let edReleases = [],
    cbiReleases = [];
  const [edResult, cbiResult] = await Promise.allSettled([fetchEDReleases(), fetchCBIReleases()]);

  if (edResult.status === 'fulfilled') {
    edReleases = edResult.value;
    summaryWrite(`Found **${edReleases.length}** Bengal-relevant ED releases.`);
  } else {
    errors.push(`ED fetch: ${edResult.reason.message}`);
    summaryWrite(`⚠️ ED fetch failed: ${edResult.reason.message}`);
  }
  if (cbiResult.status === 'fulfilled') {
    cbiReleases = cbiResult.value;
    summaryWrite(`Found **${cbiReleases.length}** Bengal-relevant CBI releases.`);
  } else {
    errors.push(`CBI fetch: ${cbiResult.reason.message}`);
    summaryWrite(`⚠️ CBI fetch failed: ${cbiResult.reason.message}`);
  }

  for (const c of cases) {
    try {
      const kws = CASE_KEYWORDS[c.id] || [];
      for (const r of edReleases) {
        const matchKw = kws.find((kw) => r.title.toLowerCase().includes(kw.toLowerCase().split(' ')[0]));
        if (matchKw && !urlSeen(c.timeline, r.url)) {
          c.timeline.push({
            date: fmtMonthYear(now),
            event: `ED: ${r.title}`,
            autoAdded: runDate,
            autoFrom: r.url,
            source: 'ED press release',
          });
          c.lastUpdated = thisMonth();
          timelineAdded++;
          queueArchive(r.url);
          summaryWrite(`- ✅ **${c.id}** (ED): ${r.title.slice(0, 70)}…`);
        }
      }
      for (const r of cbiReleases) {
        const matchKw = kws.find((kw) => r.title.toLowerCase().includes(kw.toLowerCase().split(' ')[0]));
        if (matchKw && !urlSeen(c.timeline, r.url)) {
          c.timeline.push({
            date: fmtMonthYear(now),
            event: `CBI: ${r.title}`,
            autoAdded: runDate,
            autoFrom: r.url,
            source: 'CBI press release',
          });
          c.lastUpdated = thisMonth();
          timelineAdded++;
          queueArchive(r.url);
          summaryWrite(`- ✅ **${c.id}** (CBI): ${r.title.slice(0, 70)}…`);
        }
      }
    } catch (e) {
      errors.push(`press release match ${c.id}: ${e.message}`);
    }
  }
  summaryWrite('');

  // ── 3. Google News RSS per case (concurrency = 3) ─────────────────────────
  summaryWrite('## Google News — per case');
  const caseLines = new Array(cases.length);
  await withConcurrency(cases, 3, async (c, i) => {
    const kws = CASE_KEYWORDS[c.id];
    if (!kws) {
      caseLines[i] = `- ⏭️ **${c.id}**: no keywords`;
      return;
    }
    try {
      const items = await fetchGoogleNews(kws[0]);
      const sorted = items.sort((a, b) => b.date - a.date);
      newsFeed[c.id].articles = sorted
        .slice(0, 6)
        .map(({ title, pubDate, url, source }) => ({ title, pubDate, url, source }));
      newsFeed[c.id].count24h = items.filter((n) => n.date > cutoff24h).length;
      newsFeed[c.id].count7d = items.filter((n) => n.date > cutoff7d).length;

      const recent24h = items.filter((n) => n.date > cutoff24h);
      // Archive the URLs of the most recent articles
      sorted.slice(0, 3).forEach((n) => {
        if (n.url) queueArchive(n.url);
      });
      if (recent24h.length >= 2 && !newsSummaryAddedToday(c.timeline)) {
        const top = recent24h[0];
        if (headlineIsFresh(c.timeline, top.title)) {
          c.timeline.push({
            date: fmtMonthYear(now),
            event: `${recent24h.length} news reports in last 24 h. Latest: "${top.title.slice(0, 110)}"`,
            autoAdded: runDate,
            source: 'Google News RSS',
          });
          c.lastUpdated = thisMonth();
          timelineAdded++;
          caseLines[i] = `- ✅ **${c.id}**: ${recent24h.length} articles today — timeline entry added`;
        } else {
          caseLines[i] = `- · **${c.id}**: ${recent24h.length} articles today — headline seen, skipping`;
        }
      } else {
        caseLines[i] = `- · **${c.id}**: ${newsFeed[c.id].count24h} in 24 h / ${newsFeed[c.id].count7d} in 7 d`;
      }
    } catch (e) {
      errors.push(`News ${c.id}: ${e.message}`);
      caseLines[i] = `- ⚠️ **${c.id}**: ${e.message}`;
    }
  });
  caseLines.forEach((l) => summaryWrite(l));
  summaryWrite('');

  // ── 4. Pledge tracker update (concurrency = 3) ────────────────────────────
  summaryWrite('## Accountability Pledges');
  let pledgesObj;
  let pledgesUpdated = 0;
  try {
    pledgesObj = JSON.parse(readFileSync('public/data/pledges.json', 'utf-8'));
  } catch (e) {
    errors.push(`pledges.json load: ${e.message}`);
    summaryWrite(`- ⚠️ Could not load pledges.json: ${e.message}`);
    pledgesObj = null;
  }

  if (pledgesObj) {
    // Synchronous pass: mark overdue pledges (no fetch needed)
    for (const p of pledgesObj.pledges) {
      if (p.deadlineDate && p.status === 'watching' && p.deadlineDate < runDate) {
        p.status = 'delayed';
        pledgesUpdated++;
        summaryWrite(`- 🔴 **${p.id}** auto-marked DELAYED (deadline ${p.deadlineDate} passed)`);
      }
    }

    // Parallel news fetch for pledges that have keywords (concurrency = 3)
    const pledgesWithKw = pledgesObj.pledges.filter((p) => p.keywords && p.keywords.length);
    const pledgeLines = new Array(pledgesWithKw.length);
    await withConcurrency(pledgesWithKw, 3, async (p, i) => {
      try {
        const items = await fetchGoogleNews(p.keywords[0]);
        const recent = items.filter((n) => n.date > cutoff7d).sort((a, b) => b.date - a.date);
        if (recent.length > 0) {
          const top = recent[0];
          if (p.newsHeadline !== top.title) {
            p.newsHeadline = top.title;
            p.newsDate = top.pubDate;
            p.newsUrl = top.url || null;
            pledgesUpdated++;
            pledgeLines[i] = `- 📰 **${p.id}**: new headline — "${top.title.slice(0, 70)}"`;
          } else {
            pledgeLines[i] = `- · **${p.id}**: ${recent.length} articles (headline unchanged)`;
          }
        } else {
          pledgeLines[i] = `- · **${p.id}**: no recent news`;
        }
      } catch (e) {
        errors.push(`pledge news ${p.id}: ${e.message}`);
        pledgeLines[i] = `- ⚠️ **${p.id}**: fetch error`;
      }
    });
    pledgeLines.forEach((l) => summaryWrite(l));

    // Validate before write — never corrupt pledges.json
    const invalidPledges = pledgesObj.pledges.filter((p) => !p.id || !p.category || !p.title || !p.status);
    if (invalidPledges.length > 0) {
      errors.push(`pledges.json write aborted: ${invalidPledges.length} pledges have missing required fields`);
      summaryWrite(`- ⚠️ pledges.json NOT written — ${invalidPledges.length} invalid pledge objects`);
    } else {
      pledgesObj.lastUpdated = runDate;
      writeFileSync('public/data/pledges.json', JSON.stringify(pledgesObj, null, 2));
      summaryWrite(`- **${pledgesUpdated}** pledge records updated`);
    }
  }
  summaryWrite('');

  // ── 5. Archive queued URLs to Wayback Machine (fire-and-forget, parallel) ──
  let archivedCount = 0;
  if (archiver.queue.size > 0) {
    summaryWrite(`## Wayback Machine archiving (${archiver.queue.size} URLs)`);
    const archiveResults = await archiver.flush(3);
    archiveResults.forEach((r) => {
      if (r && r.archived) {
        archivedCount++;
        summaryWrite(`- ✅ Archived: ${r.url.slice(0, 80)}`);
      }
    });
    summaryWrite('');
  }

  // ── 6. Write data files ───────────────────────────────────────────────────
  meta.autoChecked = runISO;

  const newsDoc = { generated: runISO, cases: newsFeed };

  writeFileSync('public/data/cases.json', JSON.stringify(cases, null, 2));
  writeFileSync('public/data/meta.json', JSON.stringify(meta, null, 2));
  writeFileSync('public/data/news.json', JSON.stringify(newsDoc, null, 2));

  updateSitemap(runDate);

  // ── Summary footer ────────────────────────────────────────────────────────
  summaryWrite('## Result');
  summaryWrite(`- **${timelineAdded}** permanent timeline entries added`);
  summaryWrite(`- \`data/news.json\` refreshed with latest headlines for all ${cases.length} cases`);
  summaryWrite(`- \`meta.autoChecked\` → \`${runISO}\``);
  if (archivedCount > 0) summaryWrite(`- **${archivedCount}** source URLs archived to Wayback Machine`);
  if (errors.length) {
    summaryWrite('\n### ⚠️ Non-fatal errors');
    errors.forEach((e) => summaryWrite(`- ${e}`));
  } else {
    summaryWrite('- No errors');
  }

  flushSummary();
  process.exit(0);
}

main().catch((err) => {
  summaryWrite(`\n## ❌ Script crashed\n\`\`\`\n${err.stack}\n\`\`\``);
  flushSummary();
  console.error('Update script crashed:', err);
  process.exit(1);
});
