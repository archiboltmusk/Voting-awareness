// GET /api/v1/internal/trigger-friction-update
// Vercel Cron endpoint — fires at 00:00 IST (18:30 UTC) every night.
// 1. Calls PostgreSQL sweep_missed_deadlines() to log new Deadline_Missed events
// 2. Recomputes DFI for every department
// 3. Fires alert emails for any department newly crossing its threshold
// 4. Returns a summary of the run for Vercel logs

import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import prisma from '@/lib/prisma';

export const runtime = 'nodejs';
export const maxDuration = 60; // Vercel Pro allows up to 300s; keep to 60 for safety

const ALPHA = 2.0;
const EXPONENT = 1.2;

export async function GET(req: NextRequest) {
  // Vercel cron passes Authorization: Bearer <CRON_SECRET>
  const cronSecret = req.headers.get('authorization');
  if (cronSecret !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized cron call.' }, { status: 401 });
  }

  const start = Date.now();
  const log: string[] = [];

  // ── Step 1: Sweep missed deadlines via stored procedure ──────────────────
  const swept: { sweep_missed_deadlines: number }[] =
    await prisma.$queryRaw`SELECT sweep_missed_deadlines()`;
  const sweepCount = swept[0]?.sweep_missed_deadlines ?? 0;
  log.push(`Swept ${sweepCount} new Deadline_Missed events`);

  // ── Step 2: Recompute friction scores for all pending/transferred inquiries
  const staleInquiries = await prisma.inquiry.findMany({
    where: { currentStatus: { in: ['Pending', 'Transferred', 'Appealed'] } },
    select: { id: true },
  });

  for (const inq of staleInquiries) {
    await prisma.$executeRaw`SELECT refresh_friction_score(${inq.id}::uuid)`;
  }
  log.push(`Refreshed ${staleInquiries.length} inquiry friction scores`);

  // ── Step 3: Compute DFI per department and fire threshold alerts ─────────
  const departments = await prisma.department.findMany({
    where: { isActive: true },
    select: { id: true, shortCode: true },
  });

  let alertsFired = 0;
  for (const dept of departments) {
    const inquiries = await prisma.inquiry.findMany({
      where: { departmentId: dept.id },
      select: { frictionScore: true, currentStatus: true, statutoryDeadline: true },
    });

    if (inquiries.length === 0) continue;

    const scores = inquiries.map(i => Number(i.frictionScore)).sort((a, b) => a - b);
    const n = scores.length;
    const medianF = n % 2 === 1 ? scores[Math.floor(n/2)] : (scores[n/2-1] + scores[n/2]) / 2;

    const today = new Date();
    const ghosts = inquiries.filter(i =>
      !['Resolved','Rejected'].includes(i.currentStatus) &&
      Math.floor((today.getTime() - i.statutoryDeadline.getTime()) / 86_400_000) > 90
    ).length;

    const ghostRate = ghosts / n * 100;
    const dfi = medianF + ghostRate;

    // Check if any subscriber threshold is crossed; if so, post to alerts endpoint
    const subscribers = await prisma.alertSubscriber.findMany({
      where: {
        isActive: true,
        threshold: { lte: dfi },
        OR: [{ departmentId: dept.id }, { departmentId: null }],
      },
      select: { email: true },
    });

    if (subscribers.length > 0) {
      await fetch(`${process.env.NEXT_PUBLIC_SITE_URL}/api/v1/internal/alerts`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${process.env.INTERNAL_WEBHOOK_SECRET}`,
        },
        body: JSON.stringify({
          departmentId: dept.id,
          dfi:          Math.round(dfi * 10) / 10,
          medianF:      Math.round(medianF * 10) / 10,
          ghostCount:   ghosts,
          ghostRate:    Math.round(ghostRate * 10) / 10,
          threshold:    subscribers[0] ? 0 : 100, // pass lowest threshold
        }),
      });
      alertsFired++;
      log.push(`Alert fired: ${dept.shortCode} DFI=${dfi.toFixed(1)}`);
    }
  }

  // ── Step 4: Bust the ISR cache so rankings serve fresh data ─────────────
  revalidateTag('friction-rankings');
  log.push('ISR cache invalidated: friction-rankings');

  return NextResponse.json({
    ok:              true,
    duration_ms:     Date.now() - start,
    swept_events:    sweepCount,
    scores_refreshed: staleInquiries.length,
    alerts_fired:    alertsFired,
    departments:     departments.length,
    log,
    timestamp:       new Date().toISOString(),
  });
}
