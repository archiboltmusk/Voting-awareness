/**
 * scripts/scrape-mlas.mjs
 * Scrapes ECI affidavits for all 294 West Bengal MLAs (2026 election)
 * Extracts: criminal cases, asset declarations, party affiliation
 * Runs automatically via GitHub Actions daily (after scrape-results.mjs completes)
 *
 * Data sources:
 *   1. ECI Affidavit portal: https://affidavits.eci.gov.in/
 *   2. MLA candidate JSON: https://affidavits.eci.gov.in/api/candidates/{state_id}/{election_id}
 *   3. Individual affidavits cached locally: public/data/affidavits/
 *
 * Output: public/data/mlas.json (294 MLAs, complete coverage)
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';

const AFFIDAVIT_DIR = './public/data/affidavits';
const OUTPUT_FILE = './public/data/mlas.json';
const DIFFS_FILE = './public/data/affidavit-diffs.json';
const DELAY_MS = 300; // Rate limit: ~3 requests/sec

// West Bengal election: State ID = 18, Election ID for 2026 assembly = 1026
const STATE_ID = 18;
const ELECTION_ID = 1026;

// ECI API endpoints
const API_BASE = 'https://affidavits.eci.gov.in/api';
const CANDIDATES_URL = `${API_BASE}/candidates/${STATE_ID}/${ELECTION_ID}`;

// Criminal IPC sections flagged as "serious"
const SERIOUS_IPC = [
  '302', // murder
  '307', // attempt to murder
  '365', // kidnapping
  '376', // rape
  '397', // robbery
  '498', // cruelty to spouse
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Fetch with exponential backoff ────────────────────────────────────────────
async function fetchRetry(url, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': 'https://affidavits.eci.gov.in/',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) return res.json();
      if (res.status === 429 || res.status >= 500) {
        const wait = Math.pow(2, attempt) * 1000;
        console.warn(`    Retry ${attempt}/${maxRetries} after ${wait}ms (HTTP ${res.status})`);
        await sleep(wait);
        continue;
      }
      return null;
    } catch (e) {
      if (attempt === maxRetries) return null;
      const wait = Math.pow(2, attempt) * 1000;
      console.warn(`    Retry ${attempt}/${maxRetries} after ${wait}ms (${e.message})`);
      await sleep(wait);
    }
  }
  return null;
}

// ── Parse criminal cases from affidavit JSON ─────────────────────────────────
function parseCriminalCases(affidavitData) {
  if (!affidavitData || !affidavitData.criminal_case) return { cases: 0, serious: false, ipc: '' };

  const cases = affidavitData.criminal_case;
  if (!Array.isArray(cases) || cases.length === 0) {
    return { cases: 0, serious: false, ipc: '' };
  }

  const ipcSections = [];
  let isSerious = false;

  cases.forEach(c => {
    if (c.ipc_sections) {
      const sections = c.ipc_sections.split(',').map(s => s.trim());
      ipcSections.push(...sections);
      sections.forEach(section => {
        SERIOUS_IPC.forEach(serious => {
          if (section.includes(serious)) isSerious = true;
        });
      });
    }
  });

  const uniqueIPC = [...new Set(ipcSections)].slice(0, 5).join(', ');

  return {
    cases: cases.length,
    serious: isSerious,
    ipc: uniqueIPC || '',
  };
}

// ── Parse asset declaration ──────────────────────────────────────────────────
function parseAssets(affidavitData) {
  if (!affidavitData || !affidavitData.assets) return '₹0 cr';

  const assets = affidavitData.assets;
  const total = (assets.immovable_value || 0) + (assets.movable_value || 0);
  const crores = (total / 10000000).toFixed(1);

  return `₹${crores} cr`;
}

// ── Affidavit diff detection ─────────────────────────────────────────────────
const DIFF_FIELDS = ['cases', 'serious', 'ipc', 'assets', 'party'];

function loadExistingMlas() {
  try {
    const raw = readFileSync(OUTPUT_FILE, 'utf8');
    const arr = JSON.parse(raw);
    const map = {};
    arr.forEach(m => { if (m.name) map[m.name] = m; });
    return map;
  } catch {
    return {};
  }
}

function loadExistingDiffs() {
  try {
    return JSON.parse(readFileSync(DIFFS_FILE, 'utf8'));
  } catch {
    return { lastUpdated: '', diffs: [] };
  }
}

function diffMla(oldRecord, newRecord) {
  const changes = [];
  DIFF_FIELDS.forEach(field => {
    const oldVal = String(oldRecord[field] ?? '');
    const newVal = String(newRecord[field] ?? '');
    if (oldVal !== newVal) {
      changes.push({ field, from: oldVal, to: newVal });
    }
  });
  return changes;
}

// ── Main scraper ─────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(AFFIDAVIT_DIR, { recursive: true });

  console.log('Fetching MLA candidate list from ECI...');
  const candidateList = await fetchRetry(CANDIDATES_URL);

  if (!candidateList || !Array.isArray(candidateList)) {
    console.error('Failed to fetch candidate list. Using cached data.');
    try {
      const cached = JSON.parse(readFileSync(OUTPUT_FILE, 'utf8'));
      console.log(`Loaded ${cached.length} cached MLAs.`);
      return;
    } catch {
      console.error('No cached data available.');
      process.exit(1);
    }
  }

  console.log(`Found ${candidateList.length} candidates. Filtering winners...`);

  // Only process winners (elected MLAs)
  const winners = candidateList.filter(c => c.election_status === 'Won');
  console.log(`Processing ${winners.length} elected MLAs...\n`);

  const existingMlas = loadExistingMlas();
  const existingDiffs = loadExistingDiffs();
  const today = new Date().toISOString().slice(0, 10);
  const sessionDiffs = [];

  const mlas = [];
  let processed = 0;
  let failed = 0;

  for (const candidate of winners) {
    await sleep(DELAY_MS);
    process.stdout.write(`  [${String(processed + 1).padStart(3, '0')}] ${candidate.name || 'Unknown'}: `);

    try {
      // Fetch affidavit for this candidate
      const affidavitUrl = `${API_BASE}/affidavit/${candidate.affidavit_id}`;
      const affidavitData = await fetchRetry(affidavitUrl);

      if (!affidavitData) {
        console.log('(affidavit fetch failed)');
        failed++;
        continue;
      }

      // Cache affidavit locally
      const cacheFile = `${AFFIDAVIT_DIR}/${candidate.affidavit_id}.json`;
      writeFileSync(cacheFile, JSON.stringify(affidavitData, null, 2), 'utf8');

      // Extract fields
      const criminal = parseCriminalCases(affidavitData);
      const assets = parseAssets(affidavitData);

      const mlaRecord = {
        name: candidate.name || '',
        constituency: candidate.constituency_name || '',
        district: candidate.district_name || '',
        party: candidate.party || '',
        cases: criminal.cases,
        serious: criminal.serious,
        ipc: criminal.ipc,
        assets: assets,
        verified: true,
        affidavitId: candidate.affidavit_id,
      };

      // Detect changes vs existing record
      const oldRecord = existingMlas[mlaRecord.name];
      if (oldRecord) {
        const changes = diffMla(oldRecord, mlaRecord);
        if (changes.length > 0) {
          sessionDiffs.push({
            date: today,
            name: mlaRecord.name,
            constituency: mlaRecord.constituency,
            party: mlaRecord.party,
            changes,
          });
          console.log(`✓ ${criminal.cases} cases, ${assets} [CHANGED: ${changes.map(c => c.field).join(', ')}]`);
        } else {
          console.log(`✓ ${criminal.cases} cases, ${assets}`);
        }
      } else {
        console.log(`✓ ${criminal.cases} cases, ${assets} [NEW]`);
      }

      mlas.push(mlaRecord);
      processed++;
    } catch (e) {
      console.log(`(error: ${e.message})`);
      failed++;
    }
  }

  // Sort by party, then alphabetically
  mlas.sort((a, b) => {
    if (a.party !== b.party) return a.party.localeCompare(b.party);
    return a.name.localeCompare(b.name);
  });

  // Write consolidated file
  writeFileSync(OUTPUT_FILE, JSON.stringify(mlas, null, 2), 'utf8');

  // Merge and write diffs log
  if (sessionDiffs.length > 0) {
    const mergedDiffs = [...existingDiffs.diffs, ...sessionDiffs];
    writeFileSync(DIFFS_FILE, JSON.stringify({
      lastUpdated: today,
      totalDiffs: mergedDiffs.length,
      diffs: mergedDiffs,
    }, null, 2), 'utf8');
    console.log(`\n  Affidavit changes detected: ${sessionDiffs.length} MLAs`);
    sessionDiffs.forEach(d => {
      console.log(`    ${d.name} (${d.constituency}): ${d.changes.map(c => `${c.field} ${c.from}→${c.to}`).join(', ')}`);
    });
  } else {
    console.log('\n  No affidavit changes detected vs previous run.');
  }

  console.log(`\n✓ Scraped ${processed} MLAs (${failed} failed). Written to ${OUTPUT_FILE}`);
  console.log(`  Total records: ${mlas.length}/294`);
  console.log(`  Coverage: ${((mlas.length / 294) * 100).toFixed(1)}%`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
