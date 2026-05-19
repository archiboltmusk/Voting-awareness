// POST /api/v1/webhooks/subscribe
// Self-service alert subscription. No auth required — anyone with a valid
// email can subscribe to DFI threshold alerts for any department (or globally).
//
// Body: { email, threshold, departmentCode?, webhookUrl? }
// - email: required
// - threshold: required, DFI value to trigger on (min 10, max 500)
// - departmentCode: optional; null/omitted = alert on any department breach
// - webhookUrl: optional Slack/Discord/custom webhook to POST alerts to

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';

const SubscribeSchema = z.object({
  email: z.string().email('Invalid email address'),
  threshold: z.number().min(10, 'Threshold must be at least 10').max(500),
  departmentCode: z.string().max(20).optional().nullable(),
  webhookUrl: z.string().url().optional().nullable(),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = SubscribeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed.', issues: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { email, threshold, departmentCode, webhookUrl } = parsed.data;

  // Resolve department if a code was provided
  let departmentId: string | null = null;
  if (departmentCode) {
    const dept = await prisma.department.findUnique({
      where: { shortCode: departmentCode },
      select: { id: true, name: true, isActive: true },
    });
    if (!dept) {
      return NextResponse.json(
        { error: `Department '${departmentCode}' not found.` },
        { status: 404 }
      );
    }
    if (!dept.isActive) {
      return NextResponse.json(
        { error: `Department '${departmentCode}' is currently inactive.` },
        { status: 409 }
      );
    }
    departmentId = dept.id;
  }

  // One active subscription per (email × department) pair.
  // Prisma upsert can't handle nullable fields in compound unique keys cleanly,
  // so we use findFirst + create/update manually.
  const existing = await prisma.alertSubscriber.findFirst({
    where: { email, departmentId: departmentId ?? null },
  });

  let subscriber;
  if (existing) {
    subscriber = await prisma.alertSubscriber.update({
      where: { id: existing.id },
      data: {
        threshold,
        webhookUrl: webhookUrl ?? null,
        isActive:   true,
      },
      select: {
        id:         true,
        email:      true,
        threshold:  true,
        isActive:   true,
        department: { select: { shortCode: true, name: true } },
      },
    });
  } else {
    subscriber = await prisma.alertSubscriber.create({
      data: {
        email,
        threshold,
        departmentId: departmentId ?? null,
        webhookUrl:   webhookUrl ?? null,
        isActive:     true,
      },
      select: {
        id:         true,
        email:      true,
        threshold:  true,
        isActive:   true,
        department: { select: { shortCode: true, name: true } },
      },
    });
  }

  return NextResponse.json(
    {
      ok: true,
      message: departmentId
        ? `Subscribed to alerts for ${subscriber.department?.name ?? departmentCode} when DFI ≥ ${threshold}.`
        : `Subscribed to global alerts when any department DFI ≥ ${threshold}.`,
      subscription: {
        id:           subscriber.id,
        email:        subscriber.email,
        threshold:    Number(subscriber.threshold),
        department:   subscriber.department ?? null,
        global:       !departmentId,
      },
    },
    { status: 201 }
  );
}

// DELETE /api/v1/webhooks/subscribe?email=x&departmentCode=y
// Unsubscribe. No auth — relies on email ownership (link in email footer).
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const email = searchParams.get('email');
  const departmentCode = searchParams.get('departmentCode') ?? null;

  if (!email) {
    return NextResponse.json({ error: 'email query parameter required.' }, { status: 400 });
  }

  if (departmentCode) {
    const dept = await prisma.department.findUnique({
      where: { shortCode: departmentCode },
      select: { id: true },
    });
    if (!dept) {
      return NextResponse.json(
        { error: `Department '${departmentCode}' not found.` },
        { status: 404 }
      );
    }
    await prisma.alertSubscriber.updateMany({
      where: { email, departmentId: dept.id },
      data:  { isActive: false },
    });
  } else {
    // Unsubscribe from all (global + per-department)
    await prisma.alertSubscriber.updateMany({
      where: { email },
      data:  { isActive: false },
    });
  }

  return NextResponse.json({ ok: true, message: 'Unsubscribed successfully.' });
}
