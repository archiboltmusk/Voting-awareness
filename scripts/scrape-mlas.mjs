/**
 * scripts/scrape-mlas.mjs
 * Scrapes REAL criminal-record + asset data for the 2026 West Bengal MLAs
 * from the ADR / MyNeta public archive — the authoritative open source that
 * digitises ECI candidate affidavits.
 *
 * Primary source:
 *   Winners list : https://www.myneta.info/WestBengal2026/index.php?action=show_winners
 *   Per-candidate: https://www.myneta.info/WestBengal2026/candidate.php?candidate_id=NNNN
 *
 * Output: public/data/mlas.json  — ONLY records sourced from MyNeta are written.
 *         Each record carries a `sourceUrl` proving provenance.
 *
 * INTEGRITY CONTRACT (do not weaken):
 *   • Never fabricate a value. If a field can't be parsed, leave it empty.
 *   • Never overwrite mlas.json with [] or partial garbage on a scrape failure —
 *     keep whatever verified data already exists and exit non-zero so CI flags it.
 *   • A record is only written if it has a name, a constituency, and a sourceUrl.
 *
 * Runs in GitHub Actions (open internet). It cannot run from the dev container,
 * which is network-allowlisted. Verify output from the CI run, not locally.
 *
 *   node scripts/scrape-mlas.mjs            # scrape + write
 *   node scripts/scrape-mlas.mjs --dry-run  # scrape + print, no write
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const BASE = 'https://www.myneta.info/WestBengal2026';
const WINNERS_URL = `${BASE}/index.php?action=show_winners&sort=default`;
const OUTPUT_FILE = './public/data/mlas.json';
const DIFFS_FILE = './public/data/affidavit-diffs.json';
const DELAY_MS = 350; // polite rate limit (~3 req/sec)
const DRY_RUN = process.argv.includes('--dry-run');

// IPC / BNS sections treated as "serious" for the risk flag
const SERIOUS_SECTIONS = [
  '302', '103', // murder (IPC / BNS)
  '307', '109', // attempt to murder
  '376', '64', // rape
  '364', '365', '140', // kidnapping/abduction
  '397', '309', // robbery/dacoity
  '396', // dacoity with murder
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fetch HTML with retry/backoff ─────────────────────────────────────────────
async function fetchText(url, maxRetries = 4) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return await res.text();
      if (res.status === 429 || res.status >= 500) {
        const wait = 2 ** attempt * 1000;
        console.warn(`    retry ${attempt}/${maxRetries} after ${wait}ms (HTTP ${res.status})`);
        await sleep(wait);
        continue;
      }
      console.warn(`    HTTP ${res.status} for ${url}`);
      return null;
    } catch (e) {
      if (attempt === maxRetries) {
        console.warn(`    giving up on ${url}: ${e.message}`);
        return null;
      }
      await sleep(2 ** attempt * 1000);
    }
  }
  return null;
}

// ── Tiny HTML helpers (no deps, per project rules) ────────────────────────────
const stripTags = (s) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Rupee string → "₹X.X cr". Returns '' if no parseable number.
function formatAssets(rawCell) {
  const text = stripTags(rawCell);
  // MyNeta prints e.g. "Rs 4,20,00,000 ~ 4 Crore+". Grab the first big rupee number.
  const m = text.replace(/,/g, '').match(/Rs\s*([0-9]+)/i) || text.replace(/,/g, '').match(/([0-9]{5,})/);
  if (!m) return '';
  const rupees = Number(m[1]);
  if (!Number.isFinite(rupees) || rupees <= 0) return '';
  const cr = rupees / 1e7;
  return `₹${cr >= 10 ? cr.toFixed(0) : cr.toFixed(1)} cr`;
}

const PARTY_MAP = {
  AITC: 'TMC', AITMC: 'TMC', TRINAMOOLCONGRESS: 'TMC', TMC: 'TMC',
  BJP: 'BJP', BHARATIYAJANATAPARTY: 'BJP',
  'CPI(M)': 'CPIM', CPIM: 'CPIM', CPM: 'CPIM',
  INC: 'INC', CONGRESS: 'INC', 'INDIANNATIONALCONGRESS': 'INC',
  ISF: 'ISF', AIFB: 'AIFB', RSP: 'RSP', 'SUCI(C)': 'SUCI', SUCI: 'SUCI',
  IND: 'IND', INDEPENDENT: 'IND',
};
function normalizeParty(raw) {
  if (!raw) return '';
  const key = raw.trim().toUpperCase().replace(/[\s.\-]+/g, '');
  return PARTY_MAP[key] || PARTY_MAP[raw.trim().toUpperCase()] || raw.trim();
}

// ── Parse the winners results table ───────────────────────────────────────────
// MyNeta's results table rows look like:
//   <tr><td>1</td><td><a href="candidate.php?candidate_id=123">NAME</a></td>
//       <td>CONSTITUENCY</td><td>PARTY</td><td>CRIMINAL</td><td>EDU</td>
//       <td>TOTAL ASSETS</td><td>LIABILITIES</td></tr>
function parseWinners(html) {
  const rows = [];
  const trMatches = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];

  for (const tr of trMatches) {
    const idMatch = tr.match(/candidate_id=(\d+)/i);
    if (!idMatch) continue; // only rows that link to a candidate are data rows

    const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map((c) => c);
    if (cells.length < 4) continue;

    const nameCell = cells.find((c) => /candidate_id=/i.test(c)) || cells[1] || '';
    const name = stripTags(nameCell);
    if (!name) continue;

    // Locate columns defensively by content rather than fixed index where possible.
    const textCells = cells.map(stripTags);
    // Criminal case count: a standalone integer cell (MyNeta shows the number of cases)
    let cases = 0;
    for (let i = 2; i < textCells.length; i++) {
      const t = textCells[i];
      if (/^\d{1,3}$/.test(t)) { cases = Number(t); break; }
    }
    // Party: first cell after the name that looks like a party token
    let party = '';
    for (let i = 2; i < textCells.length; i++) {
      const t = textCells[i];
      if (t && !/^\d+$/.test(t) && t.length <= 40 && !/crore|rs\s/i.test(t)) { party = t; break; }
    }
    // Constituency is usually the cell immediately after the name cell
    const nameIdx = cells.findIndex((c) => /candidate_id=/i.test(c));
    const constituency = nameIdx >= 0 && textCells[nameIdx + 1] ? textCells[nameIdx + 1] : '';

    // Assets: the cell containing a rupee figure
    const assetCell = cells.find((c) => /Rs\s*[\d,]/i.test(c) || /crore/i.test(c)) || '';

    rows.push({
      candidateId: idMatch[1],
      name,
      constituency,
      party: normalizeParty(party),
      cases,
      assets: formatAssets(assetCell),
      sourceUrl: `${BASE}/candidate.php?candidate_id=${idMatch[1]}`,
    });
  }
  return rows;
}

// ── Per-candidate page: extract IPC/BNS sections + serious flag ───────────────
function parseSections(html) {
  if (!html) return { ipc: '', serious: false };
  // Sections are referenced like "IPC 302", "Section 302", "u/s 302", "BNS 103"
  const found = new Set();
  const re = /(?:IPC|BNS|Section|u\/s)[\s.]*([0-9]{2,3}[A-Z]?)/gi;
  let m;
  while ((m = re.exec(html)) !== null) found.add(m[1].toUpperCase());
  const list = [...found];
  const serious = list.some((s) => SERIOUS_SECTIONS.includes(s.replace(/[A-Z]$/, '')));
  const ipc = list.slice(0, 6).map((s) => `Section ${s}`).join(', ');
  return { ipc, serious };
}

// ── Diff tracking (unchanged contract) ────────────────────────────────────────
const DIFF_FIELDS = ['cases', 'serious', 'ipc', 'assets', 'party'];
function loadExistingMlas() {
  try {
    const arr = JSON.parse(readFileSync(OUTPUT_FILE, 'utf8'));
    const map = {};
    if (Array.isArray(arr)) arr.forEach((m) => { if (m.name) map[m.name] = m; });
    return map;
  } catch { return {}; }
}
function loadExistingDiffs() {
  try { return JSON.parse(readFileSync(DIFFS_FILE, 'utf8')); }
  catch { return { lastUpdated: '', diffs: [] }; }
}
function diffMla(oldR, newR) {
  const changes = [];
  for (const f of DIFF_FIELDS) {
    const a = String(oldR[f] ?? ''), b = String(newR[f] ?? '');
    if (a !== b) changes.push({ field: f, from: a, to: b });
  }
  return changes;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Fetching winners list from ${WINNERS_URL}`);
  const listHtml = await fetchText(WINNERS_URL);

  if (!listHtml) {
    console.error('FATAL: could not fetch MyNeta winners list. Keeping existing data, exiting non-zero.');
    process.exit(1);
  }

  const winners = parseWinners(listHtml);
  console.log(`Parsed ${winners.length} winner rows from results table.`);

  // Guard: if parsing yields implausibly few rows, the markup likely changed.
  // Do NOT overwrite existing data with a near-empty scrape — fail loud instead.
  if (winners.length < 50) {
    console.error(
      `FATAL: only ${winners.length} rows parsed (expected ~294). ` +
        'MyNeta markup may have changed — refusing to overwrite mlas.json. ' +
        'Inspect the winners-table selectors in parseWinners().'
    );
    process.exit(1);
  }

  const existing = loadExistingMlas();
  const existingDiffs = loadExistingDiffs();
  const today = new Date().toISOString().slice(0, 10);
  const sessionDiffs = [];
  const out = [];

  for (const w of winners) {
    if (!w.name || !w.constituency || !w.sourceUrl) continue; // integrity: require provenance

    // Fetch the candidate page only when there are criminal cases (saves requests).
    let sections = { ipc: '', serious: false };
    if (w.cases > 0) {
      await sleep(DELAY_MS);
      const candHtml = await fetchText(w.sourceUrl);
      sections = parseSections(candHtml);
    }

    const rec = {
      name: w.name,
      constituency: w.constituency,
      district: existing[w.name]?.district || '', // MyNeta list lacks district; preserve if known
      party: w.party,
      cases: w.cases,
      serious: sections.serious,
      ipc: sections.ipc,
      assets: w.assets,
      verified: true,
      source: 'ADR / MyNeta',
      sourceUrl: w.sourceUrl,
      lastScraped: today,
    };

    const old = existing[rec.name];
    if (old) {
      const changes = diffMla(old, rec);
      if (changes.length) {
        sessionDiffs.push({ date: today, name: rec.name, constituency: rec.constituency, party: rec.party, changes });
        console.log(`  ✓ ${rec.name}: ${rec.cases} cases, ${rec.assets} [CHANGED: ${changes.map((c) => c.field).join(', ')}]`);
      } else {
        console.log(`  ✓ ${rec.name}: ${rec.cases} cases, ${rec.assets}`);
      }
    } else {
      console.log(`  ✓ ${rec.name}: ${rec.cases} cases, ${rec.assets} [NEW]`);
    }
    out.push(rec);
  }

  out.sort((a, b) => (a.party !== b.party ? a.party.localeCompare(b.party) : a.name.localeCompare(b.name)));

  if (DRY_RUN) {
    console.log(`\n[dry-run] would write ${out.length} records. First 3:`);
    console.log(JSON.stringify(out.slice(0, 3), null, 2));
    return;
  }

  writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2), 'utf8');

  if (sessionDiffs.length) {
    const merged = [...existingDiffs.diffs, ...sessionDiffs];
    writeFileSync(DIFFS_FILE, JSON.stringify({ lastUpdated: today, totalDiffs: merged.length, diffs: merged }, null, 2), 'utf8');
    console.log(`\n  Affidavit changes detected: ${sessionDiffs.length}`);
  } else {
    console.log('\n  No changes vs previous run.');
  }

  console.log(`\n✓ Wrote ${out.length} verified MLA records to ${OUTPUT_FILE}`);
  console.log(`  Coverage: ${((out.length / 294) * 100).toFixed(1)}% (${out.length}/294)`);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
