// GET /api/v1/departments/rankings
// Returns departments ranked by Department Friction Index (DFI).
// DFI = median(F_inquiry) + (ghosts_past_90d / N) × 100
// F_inquiry = (α·Δt)^1.2 + evasion_events + status_penalty
// Cached at Vercel's edge for 24 hours; ISR rebuilds nightly via cron.

import { NextRequest, NextResponse } from 'next/server';
import { cacheLife } from 'next/cache';
import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  'use cache';
  cacheLife('frictionRankings');

  const { searchParams } = new URL(req.url);
  const region = searchParams.get('region');       // e.g. "Purulia" or "West Bengal"
  const jurisdiction = searchParams.get('jurisdiction'); // Municipal | State | Central
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 100);

  // Raw SQL for PERCENTILE_CONT (median) — Prisma doesn't wrap this natively
  const rankings = await prisma.$queryRaw<RankingRow[]>`
    WITH inquiry_scores AS (
      SELECT
        i.department_id,
        -- F_inquiry = (α · Δt)^1.2 + evasion + status_penalty
        -- α=2.0, exponent=1.2 applied in the stored procedure during ingestion;
        -- friction_score column already holds the pre-computed F value.
        i.friction_score                                                   AS f_score,
        CASE
          WHEN i.current_status NOT IN ('Resolved','Rejected')
           AND CURRENT_DATE - i.statutory_deadline > 90
          THEN 1 ELSE 0
        END                                                                AS is_ghost
      FROM inquiries i
    ),
    dept_stats AS (
      SELECT
        s.department_id,
        COUNT(*)                                                           AS total_n,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.f_score)            AS median_f,
        SUM(s.is_ghost)                                                    AS ghost_count,
        ROUND(SUM(s.is_ghost)::numeric / NULLIF(COUNT(*), 0) * 100, 2)    AS ghost_rate
      FROM inquiry_scores s
      GROUP BY s.department_id
    )
    SELECT
      d.id,
      d.name,
      d.short_code                                                         AS "shortCode",
      d.city,
      d.state,
      d.jurisdiction,
      ds.total_n                                                           AS "totalInquiries",
      ds.ghost_count                                                       AS "ghostCount",
      ROUND(ds.ghost_rate, 2)                                              AS "ghostRate",
      ROUND(ds.median_f, 2)                                               AS "medianF",
      -- DFI formula: median(F) + ghost_rate
      ROUND(ds.median_f + ds.ghost_rate, 2)                               AS "dfi"
    FROM departments d
    JOIN dept_stats ds ON ds.department_id = d.id
    WHERE d.is_active = TRUE
      ${region       ? Prisma.sql`AND (d.city = ${region} OR d.state = ${region})` : Prisma.empty}
      ${jurisdiction ? Prisma.sql`AND d.jurisdiction = ${jurisdiction}`             : Prisma.empty}
    ORDER BY "dfi" DESC NULLS LAST
    LIMIT ${limit}
  `;

  return NextResponse.json({
    data:          rankings,
    count:         rankings.length,
    region:        region ?? 'ALL',
    jurisdiction:  jurisdiction ?? 'ALL',
    generated_at:  new Date().toISOString(),
    formula: {
      f_inquiry:   '(α·Δt)^1.2 + Σ(w·E) + P_status',
      dfi:         'median(F_inquiry) + (ghost_count/N × 100)',
      alpha:       2.0,
      exponent:    1.2,
      ghost_threshold_days: 90,
    },
  });
}

interface RankingRow {
  id: string;
  name: string;
  shortCode: string;
  city: string | null;
  state: string | null;
  jurisdiction: string | null;
  totalInquiries: bigint;
  ghostCount: bigint;
  ghostRate: number;
  medianF: number;
  dfi: number;
}
