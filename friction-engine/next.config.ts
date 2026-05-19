// next.config.ts — Aether OS Next.js Configuration
// Next.js 16+ unified cache architecture + edge CDN headers + security

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Unified Cache Components (Next.js 16)
  cacheComponents: true,

  // Custom cache life profiles for bureaucratic data
  cacheLife: {
    // Hourly revalidation for rankings (friction recalculates nightly)
    frictionRankings: {
      stale:      3_600,    // serve cached data for 1 hour without checking
      revalidate: 86_400,   // background revalidation window: 24 hours
      expire:     604_800,  // hard expire after 1 week
    },
    // Per-inquiry audit trails rarely change; cache aggressively
    inquiryAudit: {
      stale:      86_400,
      revalidate: 604_800,
      expire:     2_592_000,
    },
    // Internal trigger endpoints: never cache
    internal: {
      stale:      0,
      revalidate: 0,
      expire:     0,
    },
  },

  async headers() {
    return [
      // ── Public API endpoints ──────────────────────────────────────────
      {
        source: '/api/v1/:path*',
        headers: [
          // CORS: allow any news outlet or developer to embed the data
          { key: 'Access-Control-Allow-Origin',  value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },

          // Vercel edge-network cache (CDN absorbs repeated requests)
          { key: 'Vercel-CDN-Cache-Control', value: 's-maxage=86400' },

          // Browser cache with stale-while-revalidate for instant loads
          { key: 'Cache-Control', value: 'public, max-age=3600, stale-while-revalidate=86400' },

          // Prevent accidental caching of personal data
          { key: 'Vary', value: 'Accept-Encoding, Authorization' },
        ],
      },

      // ── Internal endpoints: no cache, no robots ───────────────────────
      {
        source: '/api/v1/internal/:path*',
        headers: [
          { key: 'Cache-Control',  value: 'no-store' },
          { key: 'x-robots-tag',   value: 'noindex, nofollow' },
          // Strip from CDN entirely
          { key: 'Vercel-CDN-Cache-Control', value: 'no-store' },
        ],
      },

      // ── Global security headers ───────────────────────────────────────
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options',        value: 'DENY' },
          { key: 'X-XSS-Protection',       value: '1; mode=block' },
          {
            key:   'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key:   'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' cdn.jsdelivr.net", // D3 CDN
              "style-src 'self' 'unsafe-inline' fonts.googleapis.com",
              "font-src 'self' fonts.gstatic.com",
              "connect-src 'self'",
              "img-src 'self' data:",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
