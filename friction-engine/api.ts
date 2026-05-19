/**
 * Aether OS — Next.js 14 API Routes (App Router)
 * Deploy to Vercel. Set DATABASE_URL, WEBHOOK_SECRET, X_BEARER_TOKEN env vars.
 *
 * Routes:
 *   GET  /api/friction/departments        → ranked department leaderboard
 *   GET  /api/friction/inquiries          → paginated RTI list
 *   GET  /api/friction/inquiries/:id      → single RTI detail + events
 *   GET  /api/friction/stats              → global summary stats
 *   POST /api/friction/webhook            → internal threshold alert broadcaster
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { z } from "zod";

// ── RATE LIMITING (in-memory, use Upstash Redis in production) ─────────────
const RATE_MAP = new Map<string, { count: number; reset: number }>();

function rateLimit(ip: string, limit = 100, windowMs = 60_000): boolean {
  const now = Date.now();
  const entry = RATE_MAP.get(ip);
  if (!entry || entry.reset < now) {
    RATE_MAP.set(ip, { count: 1, reset: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

function getIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// ── GET /api/friction/departments ──────────────────────────────────────────
export async function GET_DEPARTMENTS(req: NextRequest) {
  const ip = getIp(req);
  if (!rateLimit(ip)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { searchParams } = new URL(req.url);
  const jurisdiction = searchParams.get("jurisdiction"); // Municipal | State | Central

  const result = await sql`
    SELECT
      df.short_code,
      df.name,
      df.city,
      df.state,
      df.jurisdiction,
      df.total_inquiries,
      df.sla_breaches,
      df.breach_rate_pct,
      df.avg_friction_score,
      df.avg_delay_days,
      df.max_friction_score,
      df.resolved_count,
      df.rejected_count
    FROM department_friction df
    WHERE ($1::text IS NULL OR df.jurisdiction = $1)
    ORDER BY df.avg_friction_score DESC NULLS LAST
    LIMIT 50
  `;

  return NextResponse.json(
    {
      data:           result.rows,
      count:          result.rows.length,
      generated_at:   new Date().toISOString(),
      schema_version: "1.0",
    },
    {
      headers: {
        ...corsHeaders(),
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=300",
      },
    }
  );
}

// ── GET /api/friction/inquiries ────────────────────────────────────────────
const inquiryQuerySchema = z.object({
  dept:   z.string().optional(),
  status: z.enum(["Pending","Transferred","Rejected","Resolved","Appealed"]).optional(),
  page:   z.coerce.number().int().positive().default(1),
  limit:  z.coerce.number().int().min(1).max(100).default(25),
  sort:   z.enum(["friction_score","delay_days","date_filed"]).default("friction_score"),
});

export async function GET_INQUIRIES(req: NextRequest) {
  const ip = getIp(req);
  if (!rateLimit(ip)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = inquiryQuerySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { dept, status, page, limit, sort } = parsed.data;
  const offset = (page - 1) * limit;

  const result = await sql`
    SELECT
      i.tracking_number,
      d.short_code         AS department,
      d.city,
      i.inquiry_type,
      i.category,
      i.date_filed,
      i.statutory_deadline,
      i.current_status,
      i.friction_score,
      i.delay_days,
      o.name               AS assigned_officer,
      o.designation        AS officer_designation,
      COUNT(*) OVER()      AS total_count
    FROM inquiries i
    JOIN departments d ON d.id = i.department_id
    LEFT JOIN officials o ON o.id = i.assigned_official_id
    WHERE ($1::text IS NULL OR d.short_code = $1)
      AND ($2::text IS NULL OR i.current_status = $2)
    ORDER BY i.friction_score DESC, i.delay_days DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const totalCount = result.rows[0]?.total_count ?? 0;

  return NextResponse.json(
    {
      data:        result.rows,
      page,
      per_page:    limit,
      total:       Number(totalCount),
      total_pages: Math.ceil(Number(totalCount) / limit),
      generated_at: new Date().toISOString(),
    },
    {
      headers: {
        ...corsHeaders(),
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
      },
    }
  );
}

// ── GET /api/friction/inquiries/[tracking_number] ──────────────────────────
export async function GET_INQUIRY_DETAIL(
  req: NextRequest,
  { params }: { params: { tracking: string } }
) {
  const result = await sql`
    SELECT
      i.*,
      d.name AS department_name, d.short_code, d.city, d.jurisdiction,
      o.name AS officer_name, o.designation AS officer_designation,
      json_agg(
        json_build_object(
          'id',                  fe.id,
          'event_date',          fe.event_date,
          'event_category',      fe.event_category,
          'description',         fe.description,
          'delay_days_incurred', fe.delay_days_incurred
        ) ORDER BY fe.event_date
      ) FILTER (WHERE fe.id IS NOT NULL) AS events
    FROM inquiries i
    JOIN departments d ON d.id = i.department_id
    LEFT JOIN officials o ON o.id = i.assigned_official_id
    LEFT JOIN friction_events fe ON fe.inquiry_id = i.id
    WHERE i.tracking_number = ${decodeURIComponent(params.tracking)}
    GROUP BY i.id, d.id, o.id
  `;

  if (result.rows.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(
    { data: result.rows[0], generated_at: new Date().toISOString() },
    { headers: corsHeaders() }
  );
}

// ── GET /api/friction/stats ────────────────────────────────────────────────
export async function GET_STATS(req: NextRequest) {
  const result = await sql`
    SELECT
      COUNT(*)                                         AS total_inquiries,
      COUNT(*) FILTER (WHERE current_status='Pending'
        AND CURRENT_DATE > statutory_deadline)         AS total_sla_breaches,
      ROUND(AVG(friction_score), 1)                   AS global_avg_friction,
      ROUND(AVG(delay_days) FILTER
        (WHERE delay_days > 0))                        AS avg_delay_when_late,
      MAX(friction_score)                             AS max_friction_score,
      COUNT(*) FILTER (WHERE current_status='Resolved') AS resolved_count,
      COUNT(*) FILTER (WHERE current_status='Rejected') AS rejected_count
    FROM inquiries
  `;

  return NextResponse.json(
    {
      data:         result.rows[0],
      generated_at: new Date().toISOString(),
    },
    {
      headers: {
        ...corsHeaders(),
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=600",
      },
    }
  );
}

// ── POST /api/friction/webhook (internal threshold broadcaster) ────────────
const webhookSchema = z.object({
  department_short_code: z.string(),
  friction_score:        z.number(),
  threshold:             z.number(),
  breach_rate_pct:       z.number().optional(),
});

export async function POST_WEBHOOK(req: NextRequest) {
  const secret = req.headers.get("x-aether-secret");
  if (secret !== process.env.WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const parsed = webhookSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { department_short_code, friction_score, threshold, breach_rate_pct } = parsed.data;

  const tweet = [
    `🚨 FRICTION ALERT: ${department_short_code} score ${friction_score}/100`,
    `(threshold: ${threshold}).`,
    breach_rate_pct ? `SLA breach rate: ${breach_rate_pct}%.` : "",
    `Details: aetheros.in/dept/${department_short_code.toLowerCase()}`,
    `#RTI #Transparency #Accountability`,
  ].filter(Boolean).join(" ");

  const tweetRes = await fetch("https://api.twitter.com/2/tweets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: tweet }),
  });

  if (!tweetRes.ok) {
    const err = await tweetRes.text();
    return NextResponse.json({ error: "Twitter post failed", detail: err }, { status: 502 });
  }

  return NextResponse.json({
    ok:           true,
    tweet_length: tweet.length,
    posted_at:    new Date().toISOString(),
  });
}
