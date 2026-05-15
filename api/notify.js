/**
 * api/notify.js — Send push notifications via OneSignal (free)
 *
 * Called from GitHub Actions after a data refresh:
 *   curl -X POST https://<domain>/api/notify \
 *        -H "Authorization: Bearer $NOTIFY_SECRET" \
 *        -H "Content-Type: application/json" \
 *        -d '{"title":"Data updated","body":"New case data available.","url":"/corruption"}'
 *
 * Required env vars (all free — get at onesignal.com):
 *   ONESIGNAL_APP_ID      — your OneSignal App ID (public)
 *   ONESIGNAL_API_KEY     — your OneSignal REST API key (private)
 *   NOTIFY_SECRET         — shared secret to protect this endpoint
 */

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  const NOTIFY_SECRET    = process.env.NOTIFY_SECRET;
  const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
  const ONESIGNAL_KEY    = process.env.ONESIGNAL_API_KEY;

  const auth = req.headers.get('authorization') || '';
  if (!NOTIFY_SECRET || auth !== `Bearer ${NOTIFY_SECRET}`) return new Response('Unauthorized', { status: 401 });
  if (!ONESIGNAL_APP_ID || !ONESIGNAL_KEY) return new Response(JSON.stringify({ error: 'OneSignal not configured' }), { status: 503 });

  let body = {};
  try { body = await req.json(); } catch { /**/ }

  const res = await fetch('https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers: { 'Authorization': `Key ${ONESIGNAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      included_segments: ['All'],
      headings: { en: body.title || 'The Bengal Reader' },
      contents: { en: body.body  || 'Data has been updated.' },
      url: body.url || '/',
      web_push_topic: body.tag || 'bengal-update',
      ttl: 86400,
    }),
  });

  const data = await res.json();
  return new Response(JSON.stringify({ ok: res.ok, recipients: data.recipients, id: data.id }), {
    status: res.ok ? 200 : 502,
    headers: { 'Content-Type': 'application/json' },
  });
}
