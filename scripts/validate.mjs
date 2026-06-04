/**
 * scripts/validate.mjs
 * Validates HTML files for common issues and checks data freshness.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PUBLIC_DIR = 'public';
const HTML_FILES = readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'));
const DATA_FILES = [
  'public/data/cases.json',
  'public/data/news.json',
  'public/data/meta.json',
  'public/data/pledges.json',
  'public/data/mlas.json',
  'public/data/assets.json',
  'public/data/constituencies.json',
];

let errors = 0;
let warnings = 0;

function logError(msg) { console.error('  ✗ ' + msg); errors++; }
function logWarn(msg)  { console.warn('  ⚠ ' + msg); warnings++; }
function logOk(msg)    { console.log('  ✓ ' + msg); }

console.log('\n=== HTML Validation ===\n');

for (const file of HTML_FILES) {
  const html = readFileSync(join(PUBLIC_DIR, file), 'utf-8');
  const issues = [];

  // Critical checks
  if (!html.includes('<!DOCTYPE html>')) issues.push('Missing DOCTYPE');
  if (!html.includes('<html lang=')) issues.push('Missing lang attribute');
  if (!html.includes('<meta charset=')) issues.push('Missing charset meta');
  if (!html.includes('<meta name="viewport"')) issues.push('Missing viewport meta');
  if (!html.includes('<title>')) issues.push('Missing <title>');
  if (!html.includes('</title>')) issues.push('Unclosed <title>');

  // SEO checks
  if (!html.includes('name="description"')) logWarn(`${file}: Missing meta description`);
  if (!html.includes('property="og:title"')) logWarn(`${file}: Missing og:title`);
  if (!html.includes('property="og:description"')) logWarn(`${file}: Missing og:description`);
  if (!html.includes('property="og:image"')) logWarn(`${file}: Missing og:image`);

  // Accessibility
  if (!html.includes('<main')) logWarn(`${file}: Missing <main> landmark`);
  // Flag onclick on non-interactive elements (div/span/td etc.) that lack role= in the same tag.
  // Buttons and anchors with onclick are semantically correct and do not need role.
  const nonInteractiveOnclick = /<(?:div|span|td|th|li|p|section|article|header|footer)\b(?:(?!role=)[^>])*\bonclick=[^>]*>/i;
  if (nonInteractiveOnclick.test(html)) {
    logWarn(`${file}: onclick on non-interactive element without role (add role and tabindex)`);
  }

  if (issues.length) {
    issues.forEach(i => logError(`${file}: ${i}`));
  } else {
    logOk(`${file}: structure valid`);
  }
}

console.log('\n=== Data Freshness ===\n');

for (const file of DATA_FILES) {
  try {
    const stat = statSync(file);
    const ageDays = (Date.now() - stat.mtime.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > 7) {
      logWarn(`${file}: ${Math.round(ageDays)} days old — consider updating`);
    } else {
      logOk(`${file}: ${Math.round(ageDays)} days old`);
    }
  } catch {
    logError(`${file}: not found`);
  }
}

console.log('\n=== Meta.json Check ===\n');

try {
  const meta = JSON.parse(readFileSync('public/data/meta.json', 'utf-8'));
  const lastUpdated = meta.lastUpdated;
  const autoChecked = meta.autoChecked;
  if (lastUpdated) {
    const days = (Date.now() - new Date(lastUpdated).getTime()) / (1000 * 60 * 60 * 24);
    if (days > 7) logWarn(`meta.json lastUpdated: ${lastUpdated} (${Math.round(days)} days ago)`);
    else logOk(`meta.json lastUpdated: ${lastUpdated}`);
  }
  if (autoChecked) {
    const days = (Date.now() - new Date(autoChecked).getTime()) / (1000 * 60 * 60 * 24);
    if (days > 1) logWarn(`meta.json autoChecked: ${autoChecked} (${Math.round(days * 24)}h ago)`);
    else logOk(`meta.json autoChecked: ${autoChecked}`);
  }
} catch (e) {
  logError(`meta.json: ${e.message}`);
}

console.log('\n=== constituencies.json Check ===\n');

try {
  const cd = JSON.parse(readFileSync('public/data/constituencies.json', 'utf-8'));
  const seats     = cd.seats     || [];
  const districts = cd.districts || [];

  if (seats.length === 0)     logError('constituencies.json: seats array is empty');
  else                        logOk(`constituencies.json: ${seats.length} seats`);

  if (districts.length === 0) logWarn('constituencies.json: districts array is empty');
  else                        logOk(`constituencies.json: ${districts.length} districts`);

  const verified   = seats.filter(s => s.verified).length;
  const unverified = seats.length - verified;
  if (unverified > 0) logWarn(`constituencies.json: ${unverified} seats still unverified`);
  else                logOk('constituencies.json: all seats verified');

  // Check for duplicate AC numbers
  const acNos  = seats.map(s => s.ac);
  const unique = new Set(acNos);
  if (unique.size !== acNos.length)
    logWarn(`constituencies.json: ${acNos.length - unique.size} duplicate AC numbers detected`);
  else
    logOk('constituencies.json: no duplicate AC numbers');
} catch (e) {
  logError(`constituencies.json: ${e.message}`);
}

console.log('\n=== pledges.json Check ===\n');

try {
  const pd = JSON.parse(readFileSync('public/data/pledges.json', 'utf-8'));
  const categories = pd.categories || [];
  const pledges    = pd.pledges    || [];

  if (categories.length === 0) logError('pledges.json: categories array is empty');
  else                         logOk(`pledges.json: ${categories.length} categories`);

  if (pledges.length === 0) logError('pledges.json: pledges array is empty');
  else                      logOk(`pledges.json: ${pledges.length} total pledges`);

  // Duplicate ID check
  const ids     = pledges.map((p) => p.id);
  const seen    = new Set();
  const dupes   = ids.filter((id) => { if (seen.has(id)) return true; seen.add(id); return false; });
  if (dupes.length > 0) logError(`pledges.json: duplicate pledge IDs — ${dupes.join(', ')}`);
  else                  logOk('pledges.json: no duplicate pledge IDs');

  // Required fields
  const REQUIRED = ['id', 'category', 'title', 'status'];
  const missing  = pledges.filter((p) => REQUIRED.some((f) => !p[f]));
  if (missing.length > 0)
    logError(`pledges.json: ${missing.length} pledges missing required fields (${missing.map((p) => p.id || '?').join(', ')})`);
  else
    logOk('pledges.json: all pledges have required fields');

  // Category consistency — every pledge.category must exist in categories
  const catIds    = new Set(categories.map((c) => c.id));
  const badCat    = pledges.filter((p) => !catIds.has(p.category));
  if (badCat.length > 0)
    logError(`pledges.json: ${badCat.length} pledges reference unknown category — ${[...new Set(badCat.map((p) => p.category))].join(', ')}`);
  else
    logOk('pledges.json: all pledge categories are defined');

  // Valid status values
  const VALID_STATUS = new Set(['watching', 'partial', 'fulfilled', 'evaded', 'delayed', 'in-progress']);
  const badStatus = pledges.filter((p) => !VALID_STATUS.has(p.status));
  if (badStatus.length > 0)
    logError(`pledges.json: ${badStatus.length} pledges have invalid status values`);
  else
    logOk('pledges.json: all pledge statuses are valid');

  // Per-category summary
  const byCat = {};
  for (const p of pledges) byCat[p.category] = (byCat[p.category] || 0) + 1;
  for (const c of categories) {
    const count = byCat[c.id] || 0;
    if (count === 0) logWarn(`pledges.json: category "${c.id}" has no pledges`);
    else             logOk(`pledges.json: ${c.id} — ${count} pledges`);
  }
} catch (e) {
  logError(`pledges.json: ${e.message}`);
}

console.log('\n=== mlas.json Check ===\n');

try {
  const mlasData = JSON.parse(readFileSync('public/data/mlas.json', 'utf-8'));
  const mlas = Array.isArray(mlasData) ? mlasData : (mlasData.mlas || []);
  logOk(`mlas.json: ${mlas.length} MLA records`);

  // Integrity model: every published record MUST carry source provenance.
  // Unsourced records are a hard error — they must never reach the live site.
  const unsourced = mlas.filter((m) => !m.sourceUrl);
  if (unsourced.length > 0)
    logError(
      `mlas.json: ${unsourced.length} record(s) lack a sourceUrl — unsourced data must not be published ` +
        `(e.g. ${unsourced.slice(0, 3).map((m) => m.name || '?').join(', ')})`
    );
  else if (mlas.length > 0) logOk('mlas.json: all records carry source provenance');

  if (mlas.length === 0)
    logOk('mlas.json: empty — awaiting verified data from the ADR/MyNeta scraper (expected until first CI run)');
  else if (mlas.length < 294)
    logWarn(`mlas.json: ${294 - mlas.length} of 294 MLAs not yet sourced (${mlas.length}/294 published)`);
  else logOk('mlas.json: full 294 MLA coverage achieved');
} catch (e) {
  logError(`mlas.json: ${e.message}`);
}

console.log(`\n=== Result: ${errors} errors, ${warnings} warnings ===\n`);
process.exit(errors > 0 ? 1 : 0);
