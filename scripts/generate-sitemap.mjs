/**
 * scripts/generate-sitemap.mjs
 * Auto-generates sitemap.xml from the vercel.json rewrites + static HTML files.
 * Run manually or via CI: node scripts/generate-sitemap.mjs
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DOMAIN = process.env.SITE_DOMAIN
  ? `https://${process.env.SITE_DOMAIN}`
  : 'https://voting-awareness.vercel.app';
const VERCEL_JSON = 'vercel.json';
const PUBLIC_DIR = 'public';
const OUT = join(PUBLIC_DIR, 'sitemap.xml');

// Priority mapping by path pattern
function getPriority(path) {
  if (path === '/') return '1.0';
  if (/corruption|dossier/.test(path)) return '0.95';
  if (/assets|mlas|mla/.test(path)) return '0.9';
  if (/accountability|pledges|100-day/.test(path)) return '0.85';
  if (/constituenc|results/.test(path)) return '0.75';
  if (/parties|compass/.test(path)) return '0.75';
  if (/bonds|money|electoral/.test(path)) return '0.7';
  if (/demonetisation/.test(path)) return '0.5';
  return '0.6';
}

function getChangefreq(path) {
  if (path === '/') return 'weekly';
  if (/corruption|accountability|mlas|assets/.test(path)) return 'weekly';
  if (/constituencies|parties|bonds/.test(path)) return 'monthly';
  return 'monthly';
}

function getLastmod(filePath) {
  try {
    return statSync(filePath).mtime.toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// Collect routes from vercel.json rewrites
const vercel = JSON.parse(readFileSync(VERCEL_JSON, 'utf-8'));
const rewriteRoutes = (vercel.rewrites || []).map(r => ({
  path: r.source,
  file: join(PUBLIC_DIR, r.destination.replace(/^\//, '')),
}));

// Also scan for any HTML files not in rewrites
const htmlFiles = readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'));
const existingPaths = new Set(rewriteRoutes.map(r => r.path));
const extraRoutes = htmlFiles
  .filter(f => !existingPaths.has('/' + f.replace('.html', '')))
  .map(f => ({
    path: '/' + f.replace('.html', ''),
    file: join(PUBLIC_DIR, f),
  }));

const allRoutes = [...rewriteRoutes, ...extraRoutes];

const today = new Date().toISOString().slice(0, 10);

let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

for (const route of allRoutes) {
  const loc = DOMAIN + route.path;
  const lastmod = getLastmod(route.file);
  const freq = getChangefreq(route.path);
  const prio = getPriority(route.path);
  xml += `  <url>\n`;
  xml += `    <loc>${loc}</loc>\n`;
  xml += `    <lastmod>${lastmod}</lastmod>\n`;
  xml += `    <changefreq>${freq}</changefreq>\n`;
  xml += `    <priority>${prio}</priority>\n`;
  xml += `  </url>\n`;
}

xml += `</urlset>\n`;

writeFileSync(OUT, xml, 'utf-8');
console.log(`✓ Generated ${OUT} with ${allRoutes.length} URLs`);
