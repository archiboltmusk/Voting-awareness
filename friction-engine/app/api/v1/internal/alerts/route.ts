// POST /api/v1/internal/alerts
// Secure internal endpoint: fires React Email alert via Resend when a
// department's DFI crosses a configured threshold.
// Called by the nightly cron trigger — never exposed publicly.

import { NextResponse } from 'next/server';
import { Resend } from 'resend';
import { z } from 'zod';
import { CriticalFrictionAlert } from '@/components/emails/critical-friction-alert';
import prisma from '@/lib/prisma';

const resend = new Resend(process.env.RESEND_API_KEY);

const bodySchema = z.object({
  departmentId:   z.string().uuid(),
  dfi:            z.number(),
  medianF:        z.number(),
  ghostCount:     z.number().int(),
  ghostRate:      z.number(),
  threshold:      z.number(),
});

export async function POST(req: Request) {
  // ── Auth ────────────────────────────────────────────────────────────────
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.INTERNAL_WEBHOOK_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // ── Parse & validate ────────────────────────────────────────────────────
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json({ error: 'Malformed payload.', detail: err }, { status: 400 });
  }

  const { departmentId, dfi, medianF, ghostCount, ghostRate, threshold } = body;

  // ── Resolve department + subscribers from DB ─────────────────────────────
  const dept = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { name: true, shortCode: true },
  });
  if (!dept) {
    return NextResponse.json({ error: 'Department not found.' }, { status: 404 });
  }

  const subscribers = await prisma.alertSubscriber.findMany({
    where: {
      isActive: true,
      OR: [
        { departmentId: departmentId },
        { departmentId: null },        // global subscribers
      ],
      threshold: { lte: dfi },        // only notify if their threshold is breached
    },
    select: { email: true },
  });

  if (subscribers.length === 0) {
    return NextResponse.json({ ok: true, message: 'No subscribers meet threshold.', dispatched: 0 });
  }

  const totalInquiries = await prisma.inquiry.count({ where: { departmentId } });

  // ── Dispatch email ───────────────────────────────────────────────────────
  const { data, error } = await resend.emails.send({
    from:    process.env.ALERT_FROM_EMAIL ?? 'Aether OS <alerts@aetheros.in>',
    to:      subscribers.map(s => s.email),
    subject: `[AETHER ALERT] ${dept.shortCode} DFI ${dfi.toFixed(1)} — Threshold Breached`,
    react:   CriticalFrictionAlert({
      departmentName:   dept.name,
      shortCode:        dept.shortCode,
      dfi,
      medianF,
      ghostCount,
      ghostRate,
      threshold,
      totalInquiries,
      dashboardUrl: `${process.env.NEXT_PUBLIC_SITE_URL}/audit/${encodeURIComponent(dept.shortCode.toLowerCase())}`,
      triggerTimestamp: new Date().toUTCString(),
    }),
  });

  if (error) {
    console.error('[alerts] Resend error:', error);
    return NextResponse.json({ error: 'Email dispatch failed.', detail: error }, { status: 502 });
  }

  return NextResponse.json({
    ok:         true,
    dispatched: subscribers.length,
    resend_id:  data?.id,
    department: dept.shortCode,
    dfi,
  });
}
