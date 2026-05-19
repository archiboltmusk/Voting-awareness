// middleware.ts — Aether OS Edge Rate Limiter
// Place this file in the root of the Next.js project.
// Executes at Vercel's edge network; never touches the database.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Public tier: 50 req/min, sliding window (immune to timing attacks)
const publicLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(50, '1 m'),
  analytics: true,
  prefix: '@aether/public',
});

// Press tier: 500 req/min, identified by Authorization: Bearer <press-key>
const pressLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(500, '1 m'),
  analytics: true,
  prefix: '@aether/press',
});

const PRESS_KEYS = new Set((process.env.PRESS_API_KEYS ?? '').split(',').filter(Boolean));

export async function middleware(req: NextRequest) {
  const ip = req.ip ?? '127.0.0.1';
  const authHeader = req.headers.get('authorization') ?? '';
  const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const isPress = bearerKey !== null && PRESS_KEYS.has(bearerKey);

  const limiter = isPress ? pressLimit : publicLimit;
  const identifier = isPress ? `press:${bearerKey}` : `ip:${ip}`;

  const { success, limit, reset, remaining } = await limiter.limit(identifier);

  const rateLimitHeaders = {
    'X-RateLimit-Limit':     limit.toString(),
    'X-RateLimit-Remaining': remaining.toString(),
    'X-RateLimit-Reset':     reset.toString(),
    'X-RateLimit-Tier':      isPress ? 'press' : 'public',
    'Access-Control-Allow-Origin': '*',
  };

  if (!success) {
    return NextResponse.json(
      {
        error:      'Rate limit exceeded.',
        tier:       isPress ? 'press' : 'public',
        reset_at:   new Date(reset).toISOString(),
        docs:       'https://aetheros.in/docs/api#rate-limits',
      },
      { status: 429, headers: rateLimitHeaders }
    );
  }

  const res = NextResponse.next();
  Object.entries(rateLimitHeaders).forEach(([k, v]) => res.headers.set(k, v));
  return res;
}

// Apply only to the public API. Never block the dashboard UI or static assets.
export const config = {
  matcher: '/api/v1/:path*',
};
