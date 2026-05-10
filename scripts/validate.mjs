/**
 * scripts/validate.mjs
 * Validates HTML files for common issues and checks data freshness.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';

const HTML_FILES = readdirSync('.').filter(f => f.endsWith('.html'));
const DATA_FILES = ['data/cases.json', 'data/news.json', 'data/meta.json', 'data/pledges.json'];

let errors = 0;
let warnings = 0;

function logError(msg) { console.error('  ✗ ' + msg); errors++; }
function logWarn(msg)  { console.warn('  ⚠ ' + msg); warnings++; }
function logOk(msg)    { console.log('  ✓ ' + msg); }

console.log('\n=== HTML Validation ===\n');

for (const file of HTML_FILES) {
  const html = readFileSync(file, 'utf-8');
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
  if (html.includes('onclick=') && !html.includes('role=')) {
    logWarn(`${file}: onclick without role (accessibility)`);
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
  const meta = JSON.parse(readFileSync('data/meta.json', 'utf-8'));
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

console.log(`\n=== Result: ${errors} errors, ${warnings} warnings ===\n`);
process.exit(errors > 0 ? 1 : 0);
