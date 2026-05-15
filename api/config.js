/**
 * api/config.js — Public client-side config (safe to expose)
 *
 * Returns the OneSignal App ID so shared.js can initialise the SDK
 * without hardcoding it in committed source.
 *
 * GET /api/config → { onesignalAppId: "..." }
 */

export const config = { runtime: 'edge' };

export default function handler() {
  return new Response(
    JSON.stringify({ onesignalAppId: process.env.ONESIGNAL_APP_ID || '' }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=3600' } }
  );
}
