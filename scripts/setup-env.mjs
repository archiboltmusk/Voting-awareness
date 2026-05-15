#!/usr/bin/env node
/**
 * scripts/setup-env.mjs
 *
 * Generates the secrets needed for The Bengal Reader and writes .env.local.
 * Run once, then paste the file into Vercel's Environment Variables UI.
 *
 *   node scripts/setup-env.mjs
 *
 * You only need to fill in 3 values manually — all from FREE accounts:
 *
 *   GEMINI_API_KEY    → aistudio.google.com  (free, no credit card)
 *   ONESIGNAL_APP_ID  → onesignal.com        (free, up to 10k subscribers)
 *   ONESIGNAL_API_KEY → onesignal.com        (same app, Keys & IDs tab)
 *
 * Everything else (NOTIFY_SECRET) is auto-generated.
 */

import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve(process.cwd(), '.env.local');

// Preserve any values the user already filled in
const existing = {};
if (existsSync(OUT)) {
  readFileSync(OUT, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) existing[m[1]] = m[2];
  });
}

const NOTIFY_SECRET = existing.NOTIFY_SECRET || randomBytes(32).toString('hex');

const env = {
  GEMINI_API_KEY:    existing.GEMINI_API_KEY    || 'PASTE_KEY_FROM_AISTUDIO_GOOGLE_COM',
  ONESIGNAL_APP_ID:  existing.ONESIGNAL_APP_ID  || 'PASTE_APP_ID_FROM_ONESIGNAL_COM',
  ONESIGNAL_API_KEY: existing.ONESIGNAL_API_KEY || 'PASTE_REST_API_KEY_FROM_ONESIGNAL_COM',
  NOTIFY_SECRET,
};

const lines = [
  '# The Bengal Reader — environment variables',
  '# Run:  node scripts/setup-env.mjs',
  '# Then: paste everything below into Vercel → Settings → Environment Variables',
  '',
  '# ── 1. Google Gemini AI (powers the /ask page) ──────────────────────────',
  '# Free at: https://aistudio.google.com → Get API Key → Create API key',
  `GEMINI_API_KEY=${env.GEMINI_API_KEY}`,
  '',
  '# ── 2. OneSignal (powers push notifications — free up to 10k subscribers) ─',
  '# Free at: https://onesignal.com → New App → Web → Keys & IDs',
  `ONESIGNAL_APP_ID=${env.ONESIGNAL_APP_ID}`,
  `ONESIGNAL_API_KEY=${env.ONESIGNAL_API_KEY}`,
  '',
  '# ── 3. Notify secret (auto-generated — also add to GitHub Actions secrets) ─',
  `NOTIFY_SECRET=${env.NOTIFY_SECRET}`,
];

writeFileSync(OUT, lines.join('\n') + '\n');

const needsFilling = [
  env.GEMINI_API_KEY.startsWith('PASTE'),
  env.ONESIGNAL_APP_ID.startsWith('PASTE'),
  env.ONESIGNAL_API_KEY.startsWith('PASTE'),
].filter(Boolean).length;

console.log('\n✅  .env.local written\n');

if (needsFilling > 0) {
  console.log(`Fill in ${needsFilling} value${needsFilling > 1 ? 's' : ''} marked PASTE_… then come back:\n`);
  if (env.GEMINI_API_KEY.startsWith('PASTE')) {
    console.log('  GEMINI_API_KEY');
    console.log('  → https://aistudio.google.com → "Get API Key" → "Create API key in new project"');
    console.log('  → Takes 30 seconds. Free. No credit card.\n');
  }
  if (env.ONESIGNAL_APP_ID.startsWith('PASTE') || env.ONESIGNAL_API_KEY.startsWith('PASTE')) {
    console.log('  ONESIGNAL_APP_ID + ONESIGNAL_API_KEY');
    console.log('  → https://onesignal.com → "New App/Website" → name it "Bengal Reader"');
    console.log('  → Choose "Web" → skip the setup wizard → go to Settings → Keys & IDs');
    console.log('  → Copy "OneSignal App ID" → ONESIGNAL_APP_ID');
    console.log('  → Copy "REST API Key"     → ONESIGNAL_API_KEY');
    console.log('  → Free for up to 10,000 subscribers.\n');
  }
} else {
  console.log('All values filled. Next steps:\n');
  console.log('  1. Vercel → your project → Settings → Environment Variables');
  console.log('     Paste every non-comment line from .env.local\n');
  console.log('  2. GitHub repo → Settings → Secrets → Actions → New secret');
  console.log(`     Name: NOTIFY_SECRET   Value: ${NOTIFY_SECRET}\n`);
  console.log('  3. Push any commit — Vercel redeploys automatically.\n');
  console.log('  Done. AI Q&A and push notifications will be live.\n');
}
