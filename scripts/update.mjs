/**
 * scripts/update.mjs
 * Auto-update for The Bengal Reader — runs every 6 hours via GitHub Actions.
 *
 * Sources:
 *   1. Google News RSS  — per-case keyword queries (primary)
 *   2. enforcement.gov.in — ED press releases (Bengal-filtered)
 *   3. cbi.gov.in       — CBI press releases (Bengal-filtered)
 *
 * Writes:
 *   data/news.json  — rolling fresh headlines per case (overwritten every run)
 *   data/cases.json — permanent timeline entries for significant developments
 *   data/meta.json  — autoChecked timestamp
 *   sitemap.xml     — lastmod dates kept current
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// ── Keywords per case ─────────────────────────────────────────────────────────
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

// ── Step summary helper ───────────────────────────────────────────────────────
const summaryLines = [];
function summaryWrite(line) {
  summaryLines.push(line);
  console.log(line.replace(/[*#`_]/g, '').trim());
}
function flushSummary() {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) {
    try { writeFileSync(path, summaryLines.join('\n') + '\n', { flag: 'a' }); } catch { /**/ }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtMonthYear(d) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getFullYear()} ${months[d.getMonth()]}`;
}
function today()     { return new Date().toISOString().slice(0, 10); }
function thisMonth() { return today().slice(0, 7); }
function nowISO()    { return new Date().toISOString(); }

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
    const body  = m[1];
    const title = (/<title><!\[CDATA\[([\s\S]*?)\]\]>/.exec(body) || /<title>([\s\S]*?)<\/title>/.exec(body) || [])[1];
    const pub   = (/<pubDate>([\s\S]*?)<\/pubDate>/.exec(body) || [])[1];
    const link  = (/<link>([\s\S]*?)<\/link>/.exec(body)  || [])[1];
    const src   = (/<source[^>]*>([\s\S]*?)<\/source>/.exec(body) || [])[1];
    if (title && pub) {
      const date = new Date(pub);
      if (!isNaN(date)) {
        items.push({
          title:  title.replace(/<[^>]+>/g, '').trim(),
          date,
          pubDate: date.toISOString().slice(0, 10),
          url:    (link || '').trim(),
          source: (src  || 'Google News').replace(/<[^>]+>/g, '').trim(),
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

// ── Dedup helpers ─────────────────────────────────────────────────────────────
// For press releases: exact URL match
function urlSeen(timeline, url) {
  return url && timeline.some(t => t.autoFrom === url);
}

// For news: check if we already logged a news summary today
function newsSummaryAddedToday(timeline) {
  const t = today();
  return timeline.some(e => e.autoAdded === t && e.source === 'Google News RSS');
}

// Check if a headline is novel vs what's already in the timeline this week
function headlineIsFresh(timeline, title) {
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const fp = title.toLowerCase().slice(0, 50);
  return !timeline.some(t =>
    t.autoAdded >= weekAgo &&
    t.event && t.event.toLowerCase().includes(fp)
  );
}

// ── Sitemap updater ───────────────────────────────────────────────────────────
function updateSitemap(dateStr) {
  const path = 'public/sitemap.xml';
  if (!existsSync(path)) return;
  try {
    const xml = readFileSync(path, 'utf-8');
    writeFileSync(path, xml.replace(/<lastmod>[^<]+<\/lastmod>/g, `<lastmod>${dateStr}</lastmod>`));
  } catch (e) { console.warn('sitemap update failed:', e.message); }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const runDate = today();
  const runISO  = nowISO();
  summaryWrite(`# Bengal Reader — Auto-Update ${runISO}`);
  summaryWrite('');

  const cases = JSON.parse(readFileSync('public/data/cases.json', 'utf-8'));
  const meta  = JSON.parse(readFileSync('public/data/meta.json',  'utf-8'));
  const now   = new Date();
  const cutoff24h = new Date(now - 24  * 3600_000);   // articles in last 24 h
  const cutoff7d  = new Date(now - 7   * 86400_000);  // articles in last 7 d

  let timelineAdded = 0;
  const errors = [];

  // news.json accumulator — fresh every run
  const newsFeed = {};
  for (const c of cases) newsFeed[c.id] = { articles: [], count24h: 0, count7d: 0 };

  // ── 1. ED press releases ──────────────────────────────────────────────────
  summaryWrite('## Enforcement Directorate');
  let edReleases = [];
  try {
    edReleases = await fetchEDReleases();
    summaryWrite(`Found **${edReleases.length}** Bengal-relevant ED releases.`);
  } catch (e) {
    errors.push(`ED fetch: ${e.message}`);
    summaryWrite(`⚠️ ED fetch failed: ${e.message}`);
  }
  for (const c of cases) {
    try {
      const kws = CASE_KEYWORDS[c.id] || [];
      for (const r of edReleases) {
        const matchKw = kws.find(kw => r.title.toLowerCase().includes(kw.toLowerCase().split(' ')[0]));
        if (matchKw && !urlSeen(c.timeline, r.url)) {
          c.timeline.push({ date: fmtMonthYear(now), event: `ED: ${r.title}`, autoAdded: runDate, autoFrom: r.url, source: 'ED press release' });
          c.lastUpdated = thisMonth();
          timelineAdded++;
          summaryWrite(`- ✅ **${c.id}** (ED): ${r.title.slice(0, 70)}…`);
        }
      }
    } catch (e) { errors.push(`ED match ${c.id}: ${e.message}`); }
  }
  summaryWrite('');

  // ── 2. CBI press releases ─────────────────────────────────────────────────
  summaryWrite('## Central Bureau of Investigation');
  let cbiReleases = [];
  try {
    cbiReleases = await fetchCBIReleases();
    summaryWrite(`Found **${cbiReleases.length}** Bengal-relevant CBI releases.`);
  } catch (e) {
    errors.push(`CBI fetch: ${e.message}`);
    summaryWrite(`⚠️ CBI fetch failed: ${e.message}`);
  }
  for (const c of cases) {
    try {
      const kws = CASE_KEYWORDS[c.id] || [];
      for (const r of cbiReleases) {
        const matchKw = kws.find(kw => r.title.toLowerCase().includes(kw.toLowerCase().split(' ')[0]));
        if (matchKw && !urlSeen(c.timeline, r.url)) {
          c.timeline.push({ date: fmtMonthYear(now), event: `CBI: ${r.title}`, autoAdded: runDate, autoFrom: r.url, source: 'CBI press release' });
          c.lastUpdated = thisMonth();
          timelineAdded++;
          summaryWrite(`- ✅ **${c.id}** (CBI): ${r.title.slice(0, 70)}…`);
        }
      }
    } catch (e) { errors.push(`CBI match ${c.id}: ${e.message}`); }
  }
  summaryWrite('');

  // ── 3. Google News RSS per case ───────────────────────────────────────────
  summaryWrite('## Google News — per case');
  for (const c of cases) {
    const kws = CASE_KEYWORDS[c.id];
    if (!kws) { summaryWrite(`- ⏭️ **${c.id}**: no keywords`); continue; }

    try {
      const items = await fetchGoogleNews(kws[0]);

      // Populate news feed (always fresh — latest 6 per case)
      const sorted = items.sort((a, b) => b.date - a.date);
      newsFeed[c.id].articles  = sorted.slice(0, 6).map(({ title, pubDate, url, source }) => ({ title, pubDate, url, source }));
      newsFeed[c.id].count24h  = items.filter(n => n.date > cutoff24h).length;
      newsFeed[c.id].count7d   = items.filter(n => n.date > cutoff7d).length;

      // Add timeline entry if: 2+ articles in last 24 h AND headline is novel AND not already added today
      const recent24h = items.filter(n => n.date > cutoff24h);
      if (recent24h.length >= 2 && !newsSummaryAddedToday(c.timeline)) {
        const top = recent24h[0];
        if (headlineIsFresh(c.timeline, top.title)) {
          c.timeline.push({
            date:      fmtMonthYear(now),
            event:     `${recent24h.length} news reports in last 24 h. Latest: "${top.title.slice(0, 110)}"`,
            autoAdded: runDate,
            source:    'Google News RSS',
          });
          c.lastUpdated = thisMonth();
          timelineAdded++;
          summaryWrite(`- ✅ **${c.id}**: ${recent24h.length} articles today — timeline entry added`);
        } else {
          summaryWrite(`- · **${c.id}**: ${recent24h.length} articles today — headline seen, skipping`);
        }
      } else {
        summaryWrite(`- · **${c.id}**: ${recent24h.length} in 24 h / ${newsFeed[c.id].count7d} in 7 d`);
      }
    } catch (e) {
      errors.push(`News ${c.id}: ${e.message}`);
      summaryWrite(`- ⚠️ **${c.id}**: ${e.message}`);
    }
  }
  summaryWrite('');

  // ── 4. Pledge tracker update ──────────────────────────────────────────────
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
    for (const p of pledgesObj.pledges) {
      // Auto-mark as delayed when deadline passes with status still 'watching'
      if (p.deadlineDate && p.status === 'watching' && p.deadlineDate < runDate) {
        p.status = 'delayed';
        pledgesUpdated++;
        summaryWrite(`- 🔴 **${p.id}** auto-marked DELAYED (deadline ${p.deadlineDate} passed)`);
      }

      // Search for latest news on this pledge
      if (p.keywords && p.keywords.length) {
        try {
          const items = await fetchGoogleNews(p.keywords[0]);
          const recent = items.filter(n => n.date > cutoff7d).sort((a,b) => b.date - a.date);
          if (recent.length > 0) {
            const top = recent[0];
            if (p.newsHeadline !== top.title) {
              p.newsHeadline = top.title;
              p.newsDate     = top.pubDate;
              p.newsUrl      = top.url || null;
              pledgesUpdated++;
              summaryWrite(`- 📰 **${p.id}**: new headline — "${top.title.slice(0, 70)}"`);
            } else {
              summaryWrite(`- · **${p.id}**: ${recent.length} articles (headline unchanged)`);
            }
          } else {
            summaryWrite(`- · **${p.id}**: no recent news`);
          }
        } catch (e) {
          errors.push(`pledge news ${p.id}: ${e.message}`);
          summaryWrite(`- ⚠️ **${p.id}**: fetch error`);
        }
        await new Promise(r => setTimeout(r, 400));
      }
    }
    pledgesObj.lastUpdated = runDate;
    writeFileSync('public/data/pledges.json', JSON.stringify(pledgesObj, null, 2));
    summaryWrite(`- **${pledgesUpdated}** pledge records updated`);
  }
  summaryWrite('');

  // ── 5. Write data files ───────────────────────────────────────────────────
  meta.autoChecked = runISO;

  const newsDoc = { generated: runISO, cases: newsFeed };

  writeFileSync('public/data/cases.json', JSON.stringify(cases, null, 2));
  writeFileSync('public/data/meta.json',  JSON.stringify(meta,  null, 2));
  writeFileSync('public/data/news.json',  JSON.stringify(newsDoc, null, 2));

  updateSitemap(runDate);

  // ── 5. Summary footer ────────────────────────────────────────���────────────
  summaryWrite('## Result');
  summaryWrite(`- **${timelineAdded}** permanent timeline entries added`);
  summaryWrite(`- \`data/news.json\` refreshed with latest headlines for all ${cases.length} cases`);
  summaryWrite(`- \`meta.autoChecked\` → \`${runISO}\``);
  if (errors.length) {
    summaryWrite('\n### ⚠️ Non-fatal errors');
    errors.forEach(e => summaryWrite(`- ${e}`));
  } else {
    summaryWrite('- No errors');
  }

  flushSummary();
  process.exit(0);
}

main().catch(err => {
  summaryWrite(`\n## ❌ Script crashed\n\`\`\`\n${err.stack}\n\`\`\``);
  flushSummary();
  console.error('Update script crashed:', err);
  process.exit(1);
});
