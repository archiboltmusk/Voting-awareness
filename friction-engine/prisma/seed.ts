/**
 * Aether OS — Database Seed
 * Idempotent: safe to run multiple times (upserts by short_code).
 * Run with: npx tsx prisma/seed.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEPARTMENTS = [
  {
    name: 'Municipal Corporation of Greater Mumbai',
    shortCode: 'MCGM',
    jurisdiction: 'Municipal' as const,
    state: 'Maharashtra',
    city: 'Mumbai',
    portalUrl: 'https://portal.mcgm.gov.in',
    scraperConfig: {
      searchPath: '/rti/status_check',
      listPath: '/rti/recent',
      idPattern: 'RTI/\\d{4}/\\d{4,6}',
    },
  },
  {
    name: 'Kolkata Municipal Corporation',
    shortCode: 'KMC',
    jurisdiction: 'Municipal' as const,
    state: 'West Bengal',
    city: 'Kolkata',
    portalUrl: 'https://www.kmcgov.in',
    scraperConfig: {
      searchPath: '/rti/track',
      listPath: '/rti/list',
      idPattern: 'KMC/RTI/\\d{4}/\\d{5}',
    },
  },
  {
    name: 'Delhi Development Authority',
    shortCode: 'DDA',
    jurisdiction: 'Central' as const,
    state: 'Delhi',
    city: 'Delhi',
    portalUrl: 'https://dda.gov.in',
    scraperConfig: {
      searchPath: '/rti/status',
      listPath: '/rti/applications',
      idPattern: 'DDA/RTI/\\d{4}/\\d{5}',
    },
  },
  {
    name: 'Bruhat Bengaluru Mahanagara Palike',
    shortCode: 'BBMP',
    jurisdiction: 'Municipal' as const,
    state: 'Karnataka',
    city: 'Bengaluru',
    portalUrl: 'https://bbmp.gov.in',
    scraperConfig: {
      searchPath: '/rti/check-status',
      listPath: '/rti/applications-list',
      idPattern: 'BBMP/\\d{4}/RTI/\\d{5}',
    },
  },
  {
    name: 'Pune Municipal Corporation',
    shortCode: 'PMC',
    jurisdiction: 'Municipal' as const,
    state: 'Maharashtra',
    city: 'Pune',
    portalUrl: 'https://pmc.gov.in',
    scraperConfig: {
      searchPath: '/rti/application-status',
      listPath: '/rti/recent-applications',
      idPattern: 'PMC/RTI/\\d{4}/\\d{5}',
    },
  },
  {
    name: 'Greater Chennai Corporation',
    shortCode: 'GCC',
    jurisdiction: 'Municipal' as const,
    state: 'Tamil Nadu',
    city: 'Chennai',
    portalUrl: 'https://chennaicorporation.gov.in',
    scraperConfig: {
      searchPath: '/rti/status-enquiry',
      listPath: '/rti/applications',
      idPattern: 'GCC/RTI/\\d{4}/\\d{5}',
    },
  },
];

const GLOBAL_ALERT_THRESHOLDS = [
  { metric: 'avg_friction_score', thresholdValue: 80 },
  { metric: 'breach_rate',        thresholdValue: 25 },
  { metric: 'ghost_rate',         thresholdValue: 15 },
];

async function main() {
  console.log('🌱 Seeding Aether OS database…');

  // Upsert departments
  for (const dept of DEPARTMENTS) {
    await prisma.department.upsert({
      where: { shortCode: dept.shortCode },
      update: {
        name:          dept.name,
        jurisdiction:  dept.jurisdiction,
        state:         dept.state,
        city:          dept.city,
        portalUrl:     dept.portalUrl,
        scraperConfig: dept.scraperConfig,
        isActive:      true,
      },
      create: dept,
    });
    console.log(`  ✓ Department: ${dept.shortCode} — ${dept.name}`);
  }

  // Seed global alert thresholds (only if none exist)
  const existingThresholds = await prisma.alertThreshold.count({
    where: { departmentId: null },
  });

  if (existingThresholds === 0) {
    for (const threshold of GLOBAL_ALERT_THRESHOLDS) {
      await prisma.alertThreshold.create({
        data: {
          metric:         threshold.metric,
          thresholdValue: threshold.thresholdValue,
          isActive:       true,
        },
      });
      console.log(`  ✓ Global threshold: ${threshold.metric} ≥ ${threshold.thresholdValue}`);
    }
  } else {
    console.log(`  ↳ Global thresholds already set (${existingThresholds} rows) — skipping`);
  }

  console.log('\n✓ Seed complete.');
}

main()
  .catch(err => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
