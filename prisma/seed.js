/**
 * Database Seed Script
 * Imports the bundled skip data (data/filters/*.json) into PostgreSQL
 */

const { PrismaClient } = require('@prisma/client');
const { loadSeedTitles } = require('../src/database/seedSource');

const prisma = new PrismaClient();

async function seed() {
  console.log('Seeding database...');

  const titles = loadSeedTitles();
  if (titles.length === 0) {
    console.log('No bundled seed data found in data/filters, skipping seed.');
    return;
  }
  console.log(`Found ${titles.length} titles to import`);

  let importedTitles = 0;
  let importedSegments = 0;
  let skippedTitles = 0;

  for (const data of titles) {
    // Check if title already exists with segments
    const existing = await prisma.title.findUnique({
      where: { imdbId: data.imdbId },
      include: { _count: { select: { segments: true } } },
    });

    if (existing && existing._count.segments > 0) {
      skippedTitles++;
      continue; // Skip if already has data
    }

    // Create or update title
    const title = await prisma.title.upsert({
      where: { imdbId: data.imdbId },
      update: {
        title: data.title,
        year: data.year,
        type: data.type,
      },
      create: {
        imdbId: data.imdbId,
        title: data.title,
        year: data.year,
        type: data.type,
      },
    });

    // Import segments
    if (data.segments && data.segments.length > 0) {
      for (const seg of data.segments) {
        await prisma.segment.create({
          data: {
            titleId: title.id,
            startMs: seg.startMs,
            endMs: seg.endMs,
            category: seg.category,
            subcategory: seg.subcategory || seg.category,
            severity: seg.severity,
            channel: seg.channel || 'both',
            comment: seg.comment,
            contributor: seg.contributor || 'videoskip-import',
          },
        });
        importedSegments++;
      }
    }

    importedTitles++;
    
    // Progress indicator
    if (importedTitles % 50 === 0) {
      console.log(`  Imported ${importedTitles} titles...`);
    }
  }

  console.log('');
  console.log('=== Seed Complete ===');
  console.log(`Imported: ${importedTitles} titles, ${importedSegments} segments`);
  console.log(`Skipped: ${skippedTitles} titles (already had data)`);
}

seed()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
