/**
 * scripts/scrape-results.mjs
 * Scrapes ECI constituency-wise results for West Bengal (S25) and updates
 * constituencies.html in-place for any entries still marked verified:false.
 *
 * Run locally : node scripts/scrape-results.mjs
 * CI          : .github/workflows/scrape-results.yml  (cron 3×/day)
 *
 * ECI URL pattern:
 *   https://results.eci.gov.in/ResultAcGenMay2026/ConstituencywiseS25{N}.htm
 *   N = AC serial number (1–294 for West Bengal)
 */

import { readFileSync, writeFileSync } from 'node:fs';

const ECI_BASE = 'https://results.eci.gov.in/ResultAcGenMay2026/ConstituencywiseS25';
const HTML_FILE = new URL('../public/constituencies.html', import.meta.url).pathname;
const DELAY_MS  = 400; // ~2.5 req/sec — polite rate limit

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

  // Locate winner row (last cell == "Won" case-insensitive)
  let winnerRow = null;
  let winnerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const last = rows[i][rows[i].length - 1];
    if (/^won$/i.test(last)) {
      winnerRow = rows[i];
      winnerIdx = i;
      break;
    }
  }
  if (!winnerRow) return null;

  // Resolve column indices by scanning header row for known labels
  let colCandidate = 1, colParty = 2, colTotal = 5;
  for (let i = 0; i < rows.length && i < winnerIdx; i++) {
    const r = rows[i];
    for (let c = 0; c < r.length; c++) {
      const lc = r[c].toLowerCase();
      if (lc.includes('candidate')) colCandidate = c;
      if (lc.includes('party'))     colParty      = c;
      if (lc.includes('total'))     colTotal      = c;
    }
  }

  const winner   = (winnerRow[colCandidate] || '').replace(/\s+/g, ' ').trim();
  const winPty   = (winnerRow[colParty]     || '').trim();
  const winVotes = parseInt((winnerRow[colTotal] || '0').replace(/,/g, ''), 10) || 0;

  if (!winner || winVotes === 0) return null;

  // Runner-up = non-header row with highest votes among losers
  let runnerRow  = null;
  let runnerVotes = 0;
  for (let i = 0; i < rows.length; i++) {
    if (i === winnerIdx) continue;
    const r = rows[i];
    const last = r[r.length - 1];
    if (/^won$/i.test(last)) continue;               // another winner? skip
    if (/candidate|s\.?\s*no/i.test(r[0])) continue; // header row

    const votes = parseInt((r[colTotal] || '0').replace(/,/g, ''), 10);
    if (votes > runnerVotes) { runnerRow = r; runnerVotes = votes; }
  }

  const runnerUp   = runnerRow ? (runnerRow[colCandidate] || '').replace(/\s+/g, ' ').trim() : '';
  const runnerParty = runnerRow ? (runnerRow[colParty] || '').trim() : '';
  const margin     = Math.max(0, winVotes - runnerVotes);

  return {
    winner,
    winParty:    normalizeParty(winPty),
    runnerUp,
    runnerParty: normalizeParty(runnerParty),
    margin,
  };
}

// ── In-place field setters ────────────────────────────────────────────────────
function setStr(entry, field, value) {
  const safe = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return entry.replace(new RegExp(`(${field}\\s*:\\s*)'[^']*'`), `$1'${safe}'`);
}
function setNum(entry, field, value) {
  return entry.replace(new RegExp(`(${field}\\s*:\\s*)-?\\d+`), `$1${value}`);
}
function setBool(entry, field, value) {
  return entry.replace(new RegExp(`(${field}\\s*:\\s*)(true|false)`), `$1${value}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
let html = readFileSync(HTML_FILE, 'utf8');

// Match every seat entry in the SEATS JS array
const entryRx = /(\{\s*no\s*:\s*(\d+)\s*,[\s\S]*?verified\s*:\s*(true|false)\s*\})/g;

const unverified = [];
let em;
while ((em = entryRx.exec(html)) !== null) {
  if (em[3] === 'false') {
    unverified.push({ acNo: parseInt(em[2], 10), match: em[1] });
  }
}

console.log(`Unverified constituencies: ${unverified.length}`);

if (unverified.length === 0) {
  console.log('All constituencies verified — nothing to do.');
  process.exit(0);
}

let updated = 0;
let skipped = 0;

for (const { acNo, match } of unverified) {
  await sleep(DELAY_MS);
  process.stdout.write(`  AC${String(acNo).padStart(3, '0')}: `);

  const raw    = await fetchECI(acNo);
  const result = parseECI(raw);

  if (!result) {
    console.log('no data (skipped)');
    skipped++;
    continue;
  }

  let newEntry = match;
  newEntry = setStr(newEntry,  'winner',    result.winner);
  newEntry = setStr(newEntry,  'winParty',  result.winParty);
  newEntry = setStr(newEntry,  'loser',     result.runnerUp);
  newEntry = setStr(newEntry,  'loseParty', result.runnerParty);
  newEntry = setNum(newEntry,  'margin',    result.margin);
  newEntry = setBool(newEntry, 'verified',  'true');

  html = html.replace(match, newEntry);
  console.log(`${result.winner} (${result.winParty})  margin ${result.margin.toLocaleString()}`);
  updated++;
}

writeFileSync(HTML_FILE, html, 'utf8');
console.log(`\nResult: ${updated} updated, ${skipped} skipped (no data)`);
if (updated > 0) process.exit(0);
else process.exit(0); // exit 0 even if nothing changed — let git diff decide
