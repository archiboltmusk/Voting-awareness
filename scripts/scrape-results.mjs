/**
 * scripts/scrape-results.mjs
 * Scrapes ECI constituency-wise results for West Bengal (S25) and updates
 * public/data/constituencies.json for any entries still marked verified:false.
 *
 * Run locally : node scripts/scrape-results.mjs
 * CI          : .github/workflows/scrape-results.yml  (cron 3×/day)
 *
 * ECI URL pattern:
 *   https://results.eci.gov.in/ResultAcGenMay2026/ConstituencywiseS25{N}.htm
 *   N = AC serial number (1–294 for West Bengal)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname }                            from 'node:path';
import { fileURLToPath }                            from 'node:url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ROOT       = join(__dirname, '..');
const JSON_FILE  = join(ROOT, 'public', 'data', 'constituencies.json');
const ECI_BASE   = 'https://results.eci.gov.in/ResultAcGenMay2026/ConstituencywiseS25';
const DELAY_MS   = 400; // ~2.5 req/sec — polite rate limit

// ── Party normalisation ───────────────────────────────────────────────────────
const PARTY_MAP = {
  'AITC':      'TMC',
  'AITMC':     'TMC',
  'TRINAMC':   'TMC',
  'CPI(M)':    'CPIM',
  'CPIM':      'CPIM',
  'CPM':       'CPIM',
  'CPI-M':     'CPIM',
  'BJP':       'BJP',
  'INC':       'INC',
  'CONGRESS':  'INC',
  'RSP':       'RSP',
  'AIFB':      'AIFB',
  'SUCI(C)':   'SUCI',
  'SUCI':      'SUCI',
  'ISF':       'ISF',
  'AIMIM':     'AIMIM',
  'SP':        'SP',
  'BSP':       'BSP',
  'IND':       'IND',
  'INDEPENDENT': 'IND',
  'NCP':       'NCP',
  'NCPSP':     'NCP(SP)',
  'JMM':       'JMM',
  'AAP':       'AAP',
  'NOTA':      'NOTA',
  'AJSU':      'AJUP',
  'AJSUP':     'AJUP',
  'AJUP':      'AJUP',
  'AGJP':      'AJUP',
  'AIUDF':     'AIUDF',
  'TMC(N)':    'TMC',
  'AITMC(N)':  'TMC',
};

function normalizeParty(raw) {
  if (!raw) return 'IND';
  const key = raw.trim().toUpperCase().replace(/[\s\-\.]+/g, '');
  return PARTY_MAP[key] ?? raw.trim().slice(0, 8);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── ECI fetch with browser-like headers ──────────────────────────────────────
async function fetchECI(acNo) {
  const url = `${ECI_BASE}${acNo}.htm`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,hi;q=0.5',
        'Referer':         'https://results.eci.gov.in/',
        'DNT':             '1',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      console.warn(`  AC${acNo}: HTTP ${res.status} — ${url}`);
      return null;
    }
    return await res.text();
  } catch (e) {
    console.warn(`  AC${acNo}: fetch error — ${e.message}`);
    return null;
  }
}

// ── HTML parser ───────────────────────────────────────────────────────────────
/**
 * ECI table columns (typical):
 *   S.No | Candidate | Party | EVM Votes | Postal Votes | Total Votes | Status
 *
 * Returns { winner, winParty, runnerUp, runnerParty, margin } or null.
 */
function parseECI(html) {
  if (!html) return null;

  // Strip scripts/styles to avoid false positives in embedded JS
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                   .replace(/<style[\s\S]*?<\/style>/gi, '');

  // Extract all <tr> cells
  const rows = [];
  const rowRx = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRx.exec(body)) !== null) {
    const cells = [];
    const cellRx = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cm;
    while ((cm = cellRx.exec(m[1])) !== null) {
      const txt = cm[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
      cells.push(txt);
    }
    if (cells.length >= 4) rows.push(cells);
  }

  if (rows.length === 0) return null;

  // Locate winner row — ECI uses "Won" but also check "WINNER", "W", "✓", "yes"
  const WINNER_RE = /^(won|winner|w|yes|elected|✓)$/i;
  let winnerRow = null;
  let winnerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const last = rows[i][rows[i].length - 1];
    // Also check second-to-last cell (some ECI layouts have extra columns)
    const prev = rows[i].length > 1 ? rows[i][rows[i].length - 2] : '';
    if (WINNER_RE.test(last) || WINNER_RE.test(prev)) {
      winnerRow = rows[i];
      winnerIdx = i;
      break;
    }
  }

  // Fallback: row with highest vote total is likely the winner
  if (!winnerRow) {
    let maxVotes = 0;
    for (let i = 0; i < rows.length; i++) {
      if (/candidate|s\.?\s*no|party|total|votes/i.test(rows[i][0])) continue;
      for (let c = 2; c < rows[i].length; c++) {
        const v = parseInt((rows[i][c] || '0').replace(/,/g, ''), 10);
        if (v > maxVotes) { maxVotes = v; winnerRow = rows[i]; winnerIdx = i; }
      }
    }
    if (!winnerRow || maxVotes < 1000) return null; // sanity check
  }

  // Resolve column indices by scanning header rows for known labels
  let colCandidate = 1, colParty = 2, colTotal = 5;
  for (let i = 0; i < rows.length && i < winnerIdx; i++) {
    const r = rows[i];
    for (let c = 0; c < r.length; c++) {
      const lc = r[c].toLowerCase();
      if (/candidate|name/i.test(lc))         colCandidate = c;
      if (/^party$|party name|symbol/i.test(lc)) colParty  = c;
      if (/total|total votes|evm\+postal/i.test(lc)) colTotal = c;
    }
  }
  // If colTotal not found in header, use highest-number column heuristic
  if (colTotal === 5 && winnerRow.length < 6) {
    colTotal = winnerRow.length - 2; // second-to-last is usually total before status
  }

  const winner   = (winnerRow[colCandidate] || '').replace(/\s+/g, ' ').trim();
  const winPty   = (winnerRow[colParty]     || '').trim();
  const winVotes = parseInt((winnerRow[colTotal] || '0').replace(/,/g, ''), 10) || 0;

  if (!winner || winVotes === 0) return null;

  // Runner-up = non-header row with highest votes among losers
  let runnerRow   = null;
  let runnerVotes = 0;
  for (let i = 0; i < rows.length; i++) {
    if (i === winnerIdx) continue;
    const r    = rows[i];
    const last = r[r.length - 1];
    if (WINNER_RE.test(last)) continue;                // another winner? skip
    if (/candidate|name|s\.?\s*no/i.test(r[0])) continue; // header row

    const votes = parseInt((r[colTotal] || '0').replace(/,/g, ''), 10);
    if (votes > runnerVotes) { runnerRow = r; runnerVotes = votes; }
  }

  const runnerUp    = runnerRow ? (runnerRow[colCandidate] || '').replace(/\s+/g, ' ').trim() : '';
  const runnerParty = runnerRow ? (runnerRow[colParty] || '').trim() : '';
  const margin      = Math.max(0, winVotes - runnerVotes);

  return {
    winner,
    winParty:    normalizeParty(winPty),
    runnerUp,
    runnerParty: normalizeParty(runnerParty),
    margin,
  };
}

// ── CLI flags ─────────────────────────────────────────────────────────────────
// --force   Re-scrape every seat regardless of verified status
// --reset   Mark all seats verified:false then proceed (implies --force)
const FORCE = process.argv.includes('--force') || process.argv.includes('--reset');
const RESET = process.argv.includes('--reset');

// ── Main ──────────────────────────────────────────────────────────────────────
if (!existsSync(JSON_FILE)) {
  console.error(`ERROR: ${JSON_FILE} not found. Run: node scripts/extract-constituencies.mjs first.`);
  process.exit(1);
}

const data = JSON.parse(readFileSync(JSON_FILE, 'utf8'));

// Ensure meta object exists
if (!data.meta) data.meta = {};

if (RESET) {
  const prev = data.seats.filter(s => s.verified).length;
  data.seats.forEach(s => { s.verified = false; });
  console.log(`--reset: cleared verified flag on ${prev} seats`);
}

const toScrape = FORCE ? data.seats : data.seats.filter(s => !s.verified);

console.log(`Total seats: ${data.seats.length}`);
console.log(`To scrape:   ${toScrape.length}${FORCE ? ' (force mode)' : ''}`);

if (toScrape.length === 0) {
  console.log('All constituencies verified — nothing to do. Pass --force to re-scrape all.');
  process.exit(0);
}

let updated = 0;
let skipped = 0;

for (const seat of toScrape) {
  await sleep(DELAY_MS);
  process.stdout.write(`  AC${String(seat.ac).padStart(3, '0')} ${seat.name.padEnd(28)}: `);

  const raw    = await fetchECI(seat.ac);
  const result = parseECI(raw);

  if (!result) {
    console.log('no data (skipped)');
    skipped++;
    continue;
  }

  seat.winner    = result.winner;
  seat.winParty  = result.winParty;
  seat.loser     = result.runnerUp;
  seat.loseParty = result.runnerParty;
  seat.margin    = result.margin;
  seat.verified  = true;

  console.log(`${result.winner} (${result.winParty})  margin ${result.margin.toLocaleString()}`);
  updated++;
}

// Update metadata
data.meta.generatedAt = new Date().toISOString();
data.meta.source      = 'ECI scraper + manual verification';

writeFileSync(JSON_FILE, JSON.stringify(data, null, 2), 'utf8');
console.log(`\nResult: ${updated} updated, ${skipped} skipped — wrote ${JSON_FILE}`);
