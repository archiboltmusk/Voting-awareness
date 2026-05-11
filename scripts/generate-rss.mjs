/**
 * scripts/generate-rss.mjs
 * Auto-generates rss.xml from data/news.json
 * Run: node scripts/generate-rss.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';

const DOMAIN = process.env.SITE_DOMAIN
  ? `https://${process.env.SITE_DOMAIN}`
  : 'https://voting-awareness.vercel.app';
const NEWS = JSON.parse(readFileSync('public/data/news.json', 'utf-8'));
const META = JSON.parse(readFileSync('public/data/meta.json', 'utf-8'));

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toRfc822(iso) {
  const d = new Date(iso);
  return d.toUTCString();
}

let items = '';
for (const [caseId, data] of Object.entries(NEWS.cases || {})) {
  for (const art of (data.articles || []).slice(0, 5)) {
    items += `    <item>\n`;
    items += `      <title>${escapeXml(art.title)}</title>\n`;
    items += `      <link>${escapeXml(art.url)}</link>\n`;
    items += `      <pubDate>${toRfc822(art.pubDate)}</pubDate>\n`;
    items += `      <source>${escapeXml(art.source)}</source>\n`;
    items += `      <category>${escapeXml(caseId)}</category>\n`;
    items += `      <content:encoded>\n`;
    items += `        <![CDATA[\n`;
    items += `          <p>${escapeXml(art.title)}</p>\n`;
    items += `          <p>Read more at <a href="${DOMAIN}/corruption">Bengal Corruption Dossier</a>.</p>\n`;
    items += `        ]]\u003e\n`;
    items += `      </content:encoded>\n`;
    items += `    </item>\n`;
  }
}

const lastBuild = toRfc822(META.autoChecked || new Date().toISOString());

let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
xml += `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">\n`;
xml += `  <channel>\n`;
xml += `    <title>The Bengal Reader — Live News Feed</title>\n`;
xml += `    <link>${DOMAIN}</link>\n`;
xml += `    <description>Latest headlines on Bengal corruption cases, court hearings, and political accountability — updated every 6 hours.</description>\n`;
xml += `    <language>en</language>\n`;
xml += `    <lastBuildDate>${lastBuild}</lastBuildDate>\n`;
xml += `    <atom:link href="${DOMAIN}/rss.xml" rel="self" type="application/rss+xml" />\n`;
xml += `    <image>\n`;
xml += `      <url>${DOMAIN}/favicon.svg</url>\n`;
xml += `      <title>The Bengal Reader</title>\n`;
xml += `      <link>${DOMAIN}</link>\n`;
xml += `    </image>\n`;
xml += items;
xml += `  </channel>\n`;
xml += `</rss>\n`;

writeFileSync('public/rss.xml', xml, 'utf-8');
console.log(`✓ Generated rss.xml with ${NEWS.cases ? Object.keys(NEWS.cases).length : 0} case feeds`);
