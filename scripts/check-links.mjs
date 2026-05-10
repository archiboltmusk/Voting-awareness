import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PUBLIC_DIR = 'public';

function stripHashQuery(path) {
  const q = path.indexOf('?');
  const h = path.indexOf('#');
  const cut = q === -1 ? h : h === -1 ? q : Math.min(q, h);
  return cut === -1 ? path : path.slice(0, cut);
}

function readRewrites() {
  const vercel = JSON.parse(readFileSync('vercel.json', 'utf-8'));
  return new Set((vercel.rewrites || []).map(r => r.source));
}

function extractUrls(html) {
  const urls = [];
  const rx = /\b(?:href|src)\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = rx.exec(html)) !== null) urls.push(m[1]);
  return urls;
}

function isExternal(u) {
  return (
    u.startsWith('http://') ||
    u.startsWith('https://') ||
    u.startsWith('mailto:') ||
    u.startsWith('tel:') ||
    u.startsWith('data:') ||
    u.startsWith('javascript:') ||
    u.startsWith('//')
  );
}

function isSkippable(u) {
  return u === '' || u === '#' || u.startsWith('#') || u.startsWith('/_vercel/') || u.startsWith('/_next/');
}

const htmlFiles = readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'));
const rewrites = readRewrites();
const broken = [];

for (const file of htmlFiles) {
  const html = readFileSync(join(PUBLIC_DIR, file), 'utf-8');
  for (const raw of extractUrls(html)) {
    if (isExternal(raw) || isSkippable(raw)) continue;

    if (raw.startsWith('/')) {
      const path = stripHashQuery(raw);
      if (path === '/') continue;

      const directFile = join(PUBLIC_DIR, path.slice(1));
      const htmlFile = join(PUBLIC_DIR, path.replace(/\/$/, '').slice(1) + '.html');
      if (existsSync(directFile) || existsSync(htmlFile) || rewrites.has(path)) continue;

      broken.push({ file, url: raw });
    }
  }
}

if (broken.length) {
  console.error(`Broken internal links: ${broken.length}`);
  for (const b of broken.slice(0, 50)) console.error(`- ${b.file}: ${b.url}`);
  process.exit(1);
}

console.log(`✓ Link check passed (${htmlFiles.length} HTML files)`);
