/**
 * sw.js — The Bengal Reader service worker
 *
 * Strategy:
 *   - Static shell (CSS, JS, fonts, images): cache-first, update in background
 *   - Data JSON files: network-first, fall back to cache
 *   - HTML pages: network-first, fall back to cache
 */

const VERSION = 'bengal-v3';

const PRECACHE = [
  '/shared.css',
  '/fonts.css',
  '/shared.js',
  '/analytics.js',
  '/favicon.svg',
  '/manifest.json',
  '/',
  '/corruption',
  '/constituencies',
  '/accountability',
  '/mlas',
  '/assets',
  '/parties',
  '/bonds',
  '/demonetisation',
  '/methodology',
  '/search',
  '/compare',
  '/corrections',
  '/rti',
  '/ask',
  '/map',
];

const DATA_FILES = [
  '/data/meta.json',
  '/data/news.json',
  '/data/cases.json',
  '/data/pledges.json',
  '/data/mlas.json',
  '/data/assets.json',
  '/data/constituencies.json',
  '/data/parties.json',
];

// ── Install: precache the shell ───────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

// ── Activate: delete old caches ───────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  const isData = url.pathname.startsWith('/data/');
  const isStatic = /\.(css|js|svg|png|woff2|woff|ttf)$/.test(url.pathname);

  if (isData) {
    // Network-first for data files — always try to get fresh data
    event.respondWith(networkFirst(request));
  } else if (isStatic) {
    // Cache-first for static assets — fast loads, update in background
    event.respondWith(cacheFirst(request));
  } else {
    // Network-first for HTML pages — keeps content current
    event.respondWith(networkFirst(request));
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    // Refresh cache in background
    fetch(request).then(res => {
      if (res.ok) caches.open(VERSION).then(c => c.put(request, res));
    }).catch(() => {});
    return cached;
  }
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(VERSION);
    cache.put(request, response.clone());
  }
  return response;
}

// Push notifications are handled by OneSignalSDKWorker.js at the site root.
// This service worker only handles caching.

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Offline fallback for navigation requests
    if (request.mode === 'navigate') {
      const fallback = await caches.match('/');
      if (fallback) return fallback;
    }
    return new Response('Offline — cached version unavailable', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}
