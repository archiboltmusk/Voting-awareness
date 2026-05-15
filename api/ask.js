/**
 * api/ask.js — Groq-powered Q&A over The Bengal Reader's data
 *
 * POST /api/ask  { question: string }  → Server-Sent Events stream
 *
 * Uses Groq (free tier: 14,400 req/day, no credit card needed).
 * Get a free API key at: https://console.groq.com → API Keys → Create
 *
 * Required env var:
 *   GROQ_API_KEY — from console.groq.com (free, no billing)
 */

export const config = { runtime: 'edge' };

const GROQ_KEY  = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const GROQ_URL  = 'https://api.groq.com/openai/v1/chat/completions';

async function loadJSON(req, name) {
  try {
    // SITE_URL env var takes priority; fall back to request origin
    const base = (process.env.SITE_URL || new URL(req.url).origin).replace(/\/$/, '');
    const res = await fetch(`${base}/data/${name}`);
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

function summariseMlas(mlas) {
  if (!mlas) return '';
  const arr = Array.isArray(mlas) ? mlas : mlas.mlas || [];
  const withCases = arr.filter(m => m.cases > 0);
  return `MLA Criminal Records: ${arr.length} total, ${withCases.length} have criminal cases. ` +
    `Top 5: ${withCases.sort((a, b) => b.cases - a.cases).slice(0, 5).map(m => `${m.name} (${m.party}, ${m.cases} cases)`).join('; ')}.`;
}

function summariseCases(cases) {
  if (!cases) return '';
  const arr = Array.isArray(cases) ? cases : cases.cases || [];
  return arr.map(c =>
    `Case: ${c.title}\nSummary: ${c.summary}\nLatest: ${(c.timeline || []).slice(-2).map(t => `${t.date}: ${t.event}`).join(' | ')}`
  ).join('\n\n');
}

function summarisePledges(pledges) {
  if (!pledges) return '';
  const arr = Array.isArray(pledges) ? pledges : pledges.pledges || [];
  const list = arr.map(p => `${p.id}. ${p.title} [${p.status}]`).join('\n');
  return `BJP pre-election pledges (${arr.length} total):\n${list}`;
}

function summariseConstituencies(data) {
  if (!data || !data.seats) return '';
  const byParty = {};
  data.seats.forEach(s => { byParty[s.party] = (byParty[s.party] || 0) + 1; });
  const sorted = Object.entries(byParty).sort((a, b) => b[1] - a[1]);
  return `2026 WB Assembly results: ${data.seats.length} seats. ` + sorted.map(([p, n]) => `${p}: ${n}`).join(', ') + '.';
}

function selectData(question) {
  const q = question.toLowerCase();
  const needs = [];
  if (q.match(/mla|criminal|arrest|record/)) needs.push('mlas');
  if (q.match(/corrupt|saradha|narada|ssc|case|ed\b|cbi/)) needs.push('cases');
  if (q.match(/pledge|promise|deliver|100.day|manifesto|bjp/)) needs.push('pledges');
  if (q.match(/seat|result|win|constituenc|election|margin/)) needs.push('constituencies');
  if (needs.length === 0) needs.push('cases', 'pledges', 'constituencies');
  return [...new Set(needs)];
}

export default async function handler(req) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  if (!GROQ_KEY) return new Response(JSON.stringify({ error: 'GROQ_API_KEY not set — get one free at console.groq.com (no billing needed)' }), { status: 503, headers: { ...cors, 'Content-Type': 'application/json' } });

  let question;
  try { question = ((await req.json()).question || '').trim().slice(0, 500); } catch { return new Response('Invalid JSON', { status: 400 }); }
  if (!question) return new Response('question required', { status: 400 });

  const needs = selectData(question);
  const [mlas, cases, pledges, constituencies] = await Promise.all([
    needs.includes('mlas')           ? loadJSON(req, 'mlas.json')           : null,
    needs.includes('cases')          ? loadJSON(req, 'cases.json')          : null,
    needs.includes('pledges')        ? loadJSON(req, 'pledges.json')        : null,
    needs.includes('constituencies') ? loadJSON(req, 'constituencies.json') : null,
  ]);

  const context = [
    mlas           && summariseMlas(mlas),
    cases          && summariseCases(cases),
    pledges        && summarisePledges(pledges),
    constituencies && summariseConstituencies(constituencies),
  ].filter(Boolean).join('\n\n---\n\n');

  const systemPrompt = `You are a civic journalism assistant for The Bengal Reader, a non-partisan fact-based site covering West Bengal politics and the 2026 Assembly elections. Answer only from the data provided. Be concise and factual. Use Indian English. If the data does not contain the answer, say so clearly. Never take a partisan position.\n\nToday: 2026-05-15.\n\nDATA:\n${context}`;

  const groqRes = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: question },
      ],
      max_tokens: 600,
      temperature: 0.2,
      stream: true,
    }),
  });

  if (!groqRes.ok) {
    const err = await groqRes.text();
    let detail = err;
    try { const j = JSON.parse(err); detail = j.error?.message || err; } catch (_) {}
    return new Response(JSON.stringify({ error: `Groq ${groqRes.status}: ${detail}` }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  // Transform Groq SSE (OpenAI-compatible) → simple {text} stream the client reads
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  (async () => {
    const reader = groqRes.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const chunk = JSON.parse(raw);
            const text = chunk?.choices?.[0]?.delta?.content;
            if (text) await writer.write(enc.encode(`data: ${JSON.stringify({ text })}\n\n`));
          } catch { /* skip malformed */ }
        }
      }
    } finally {
      await writer.write(enc.encode('data: [DONE]\n\n'));
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
  });
}
