// GET /api/v1/inquiries/[tracking_number]
// Returns the full chronological audit trail for a single RTI/inquiry.
// Journalists use this to document the exact sequence of evasions.
// PII of the citizen who filed is never returned — only the public record.

import { NextRequest, NextResponse } from 'next/server';
import { cacheLife } from 'next/cache';
import prisma from '@/lib/prisma';

export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  { params }: { params: { tracking_number: string } }
) {
  'use cache';
  cacheLife('inquiryAudit');

  const { tracking_number } = params;

  const inquiry = await prisma.inquiry.findUnique({
    where: { trackingNumber: decodeURIComponent(tracking_number) },
    select: {
      trackingNumber:   true,
      inquiryType:      true,
      category:         true,
      dateFiled:        true,
      statutoryDeadline: true,
      currentStatus:    true,
      frictionScore:    true,
      createdAt:        true,
      updatedAt:        true,
      department: {
        select: {
          name:         true,
          shortCode:    true,
          city:         true,
          state:        true,
          jurisdiction: true,
        },
      },
      assignedOfficial: {
        select: {
          name:        true,
          designation: true,
          // contactEmail deliberately excluded — privacy
        },
      },
      frictionEvents: {
        orderBy: { eventDate: 'asc' },
        select: {
          eventDate:          true,
          eventCategory:      true,
          description:        true,
          delayDaysIncurred:  true,
        },
      },
    },
  });

  if (!inquiry) {
    return NextResponse.json(
      { error: 'Inquiry not found.', tracking_number },
      { status: 404 }
    );
  }

  // Compute delay_days at response time (not stored, to stay current)
  const today = new Date();
  const delayDays = inquiry.currentStatus === 'Pending'
    ? Math.max(0, Math.floor((today.getTime() - inquiry.statutoryDeadline.getTime()) / 86_400_000))
    : 0;

  return NextResponse.json({
    metadata: {
      tracking_number:   inquiry.trackingNumber,
      type:              inquiry.inquiryType,
      category:          inquiry.category,
      date_filed:        inquiry.dateFiled,
      statutory_deadline: inquiry.statutoryDeadline,
      current_status:    inquiry.currentStatus,
      delay_days:        delayDays,
      friction_score:    Number(inquiry.frictionScore),
      department:        inquiry.department,
      assigned_officer:  inquiry.assignedOfficial ?? null,
    },
    timeline: inquiry.frictionEvents.map(ev => ({
      date:              ev.eventDate,
      category:          ev.eventCategory,
      description:       ev.description,
      delay_days_incurred: ev.delayDaysIncurred,
    })),
    generated_at: new Date().toISOString(),
  });
}
