/**
 * api/ask.js — Gemini-powered Q&A over The Bengal Reader's data
 *
 * POST /api/ask  { question: string }  → Server-Sent Events stream
 *
 * Uses Google Gemini 1.5 Flash (free tier: 15 req/min, 1M tokens/day).
 * Get a free API key at: https://aistudio.google.com  (no credit card)
 *
 * Required env var:
 *   GEMINI_API_KEY — from aistudio.google.com → Get API Key
 */

export const config = { runtime: 'edge' };

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse&key=`;
const DATA_BASE = 'https://voting-awareness-psi.vercel.app/data';

async function loadJSON(name) {
  try {
    const res = await fetch(`${DATA_BASE}/${name}`);
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

  if (!GEMINI_KEY) return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not set — get one free at aistudio.google.com' }), { status: 503, headers: { ...cors, 'Content-Type': 'application/json' } });

  let question;
  try { question = ((await req.json()).question || '').trim().slice(0, 500); } catch { return new Response('Invalid JSON', { status: 400 }); }
  if (!question) return new Response('question required', { status: 400 });

  const needs = selectData(question);
  const [mlas, cases, pledges, constituencies] = await Promise.all([
    needs.includes('mlas')             ? loadJSON('mlas.json')             : null,
    needs.includes('cases')            ? loadJSON('cases.json')            : null,
    needs.includes('pledges')          ? loadJSON('pledges.json')          : null,
    needs.includes('constituencies')   ? loadJSON('constituencies.json')   : null,
  ]);

  const context = [
    mlas           && summariseMlas(mlas),
    cases          && summariseCases(cases),
    pledges        && summarisePledges(pledges),
    constituencies && summariseConstituencies(constituencies),
  ].filter(Boolean).join('\n\n---\n\n');

  const systemPrompt = `You are a civic journalism assistant for The Bengal Reader, a non-partisan fact-based site covering West Bengal politics and the 2026 Assembly elections. Answer only from the data provided. Be concise and factual. Use Indian English. If data doesn't contain the answer, say so. Never take a partisan position.\n\nToday: 2026-05-15.\n\nDATA:\n${context}`;

  const geminiRes = await fetch(`${GEMINI_URL}${GEMINI_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: question }] }],
      generationConfig: { maxOutputTokens: 600, temperature: 0.2 },
    }),
  });

  if (!geminiRes.ok) {
    const err = await geminiRes.text();
    return new Response(JSON.stringify({ error: 'Gemini error', detail: err }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  // Transform Gemini SSE → simple text/event-stream the client can parse
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  (async () => {
    const reader = geminiRes.body.getReader();
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
            const text = chunk?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) await writer.write(enc.encode(`data: ${JSON.stringify({ text })}\n\n`));
          } catch { /* skip malformed */ }
        }
      }
    } finally {
      await writer.write(enc.encode('data: [DONE]\n\n'));
      await writer.close();
    }
  })();

  return new Response(readable, { headers: { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } });
}
