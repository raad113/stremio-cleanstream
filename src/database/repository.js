/**
 * Database Repository
 * 
 * Abstraction layer for database operations
 * Supports both PostgreSQL (via Prisma) and fallback JSON storage
 */

const { getClient } = require('./connection');
const jsonDb = require('./jsonStorage');

/**
 * Check if PostgreSQL is available
 */
function isPostgresAvailable() {
  return !!process.env.DATABASE_URL;
}

/**
 * Get or create a title record
 */
async function getOrCreateTitle(imdbId, metadata = {}) {
  if (!isPostgresAvailable()) {
    return jsonDb.getFilters(imdbId) || jsonDb.createEmptyFilterData(imdbId);
  }
  
  const prisma = getClient();
  
  let title = await prisma.title.findUnique({
    where: { imdbId },
    include: {
      segments: {
        orderBy: { startMs: 'asc' },
      },
      releases: true,
    },
  });
  
  if (!title) {
    title = await prisma.title.create({
      data: {
        imdbId,
        title: metadata.title,
        year: metadata.year,
        type: metadata.type,
        runtime: metadata.runtime,
      },
      include: {
        segments: true,
        releases: true,
      },
    });
  }
  
  return title;
}

/**
 * Get filters/segments for a title
 */
async function getFilters(imdbId) {
  if (!jsonDb.isValidContentId(imdbId)) return null;

  if (!isPostgresAvailable()) {
    const data = jsonDb.getFilters(imdbId);
    if (!data) return null;
    // Never expose who voted; return a copy without the per-visitor vote map
    return {
      ...data,
      segments: data.segments.map(({ voters, ...seg }) => seg),
    };
  }
  
  const prisma = getClient();
  
  const title = await prisma.title.findUnique({
    where: { imdbId },
    include: {
      segments: {
        orderBy: { startMs: 'asc' },
      },
      releases: true,
    },
  });
  
  if (!title) return null;
  
  // Transform to match expected format
  return {
    imdbId: title.imdbId,
    title: title.title,
    year: title.year,
    type: title.type,
    runtime: title.runtime,
    segments: title.segments.map(seg => ({
      id: seg.id,
      startMs: seg.startMs,
      endMs: seg.endMs,
      category: seg.category,
      subcategory: seg.subcategory,
      severity: seg.severity,
      channel: seg.channel,
      comment: seg.comment,
      contributor: seg.contributor,
      contributorHash: seg.contributorHash,
      status: seg.status,
      refId: seg.refId,
      durationMs: seg.durationMs,
      votes: { up: seg.upvotes, down: seg.downvotes },
      verified: seg.verified,
      createdAt: seg.createdAt,
    })),
    releases: title.releases,
    createdAt: title.createdAt,
    updatedAt: title.updatedAt,
  };
}

/**
 * Add a segment to a title
 */
async function addSegment(imdbId, segmentData) {
  if (!isPostgresAvailable()) {
    return jsonDb.addSegment(imdbId, segmentData);
  }
  
  const prisma = getClient();
  
  // Ensure title exists
  const title = await getOrCreateTitle(imdbId, {
    title: segmentData.titleName,
    year: segmentData.year,
    type: segmentData.type || (imdbId.includes(':') ? 'episode' : undefined),
  });
  
  const segment = await prisma.segment.create({
    data: {
      titleId: title.id,
      startMs: segmentData.startMs,
      endMs: segmentData.endMs,
      category: segmentData.category,
      subcategory: segmentData.subcategory || segmentData.category,
      severity: segmentData.severity || 'high',
      channel: segmentData.channel || 'both',
      comment: segmentData.comment,
      contributor: segmentData.contributor || 'anonymous',
      contributorHash: segmentData.contributorHash || null,
      status: segmentData.status || 'approved',
      refId: segmentData.refId || null,
      durationMs: Number.isInteger(segmentData.durationMs) ? segmentData.durationMs : null,
    },
  });
  
  return {
    id: segment.id,
    startMs: segment.startMs,
    endMs: segment.endMs,
    category: segment.category,
    subcategory: segment.subcategory,
    severity: segment.severity,
    channel: segment.channel,
    comment: segment.comment,
    contributor: segment.contributor,
    status: segment.status,
    refId: segment.refId,
    durationMs: segment.durationMs,
    votes: { up: 0, down: 0 },
    createdAt: segment.createdAt,
  };
}

/**
 * Update title metadata
 */
async function updateTitleMetadata(imdbId, metadata) {
  if (!isPostgresAvailable()) {
    const data = jsonDb.getFilters(imdbId) || jsonDb.createEmptyFilterData(imdbId);
    Object.assign(data, metadata);
    data.updatedAt = new Date().toISOString();
    jsonDb.saveFilters(imdbId, data);
    return data;
  }
  
  const prisma = getClient();
  
  const title = await prisma.title.upsert({
    where: { imdbId },
    update: {
      title: metadata.title,
      year: metadata.year,
      type: metadata.type,
      runtime: metadata.runtime,
    },
    create: {
      imdbId,
      title: metadata.title,
      year: metadata.year,
      type: metadata.type,
      runtime: metadata.runtime,
    },
  });
  
  return title;
}

/**
 * Vote on a segment
 */
async function voteSegment(imdbId, segmentId, voteType, visitorId) {
  if (!isPostgresAvailable()) {
    return jsonDb.voteSegment(imdbId, segmentId, voteType, visitorId);
  }
  
  const prisma = getClient();

  // Make sure the segment exists and belongs to this title
  const segment = await prisma.segment.findFirst({
    where: { id: segmentId, title: { imdbId } },
    select: { id: true },
  });
  if (!segment) {
    return { success: false, reason: 'not_found' };
  }
  
  // Check for existing vote
  const existingVote = await prisma.vote.findUnique({
    where: {
      visitorId_segmentId: {
        visitorId,
        segmentId,
      },
    },
  });
  
  if (existingVote) {
    // Already voted
    if (existingVote.voteType === voteType) {
      return { success: false, reason: 'already_voted' };
    }
    
    // Changing vote
    await prisma.$transaction([
      prisma.vote.update({
        where: {
          visitorId_segmentId: { visitorId, segmentId },
        },
        data: { voteType },
      }),
      prisma.segment.update({
        where: { id: segmentId },
        data: {
          upvotes: voteType === 'up' ? { increment: 1 } : { decrement: 1 },
          downvotes: voteType === 'down' ? { increment: 1 } : { decrement: 1 },
        },
      }),
    ]);
    
    return { success: true, changed: true };
  }
  
  // New vote
  await prisma.$transaction([
    prisma.vote.create({
      data: {
        visitorId,
        segmentId,
        voteType,
      },
    }),
    prisma.segment.update({
      where: { id: segmentId },
      data: {
        [voteType === 'up' ? 'upvotes' : 'downvotes']: { increment: 1 },
      },
    }),
  ]);
  
  return { success: true };
}

/**
 * Change a segment's status ("pending", "approved" or "rejected").
 */
async function setSegmentStatus(imdbId, segmentId, status) {
  if (!isPostgresAvailable()) return jsonDb.setSegmentStatus(imdbId, segmentId, status);
  const prisma = getClient();
  const result = await prisma.segment.updateMany({
    where: { id: segmentId, title: { imdbId } },
    data: { status },
  });
  return result.count > 0;
}

/** Pending segments across all titles, newest first (for the admin page). */
async function listPending({ limit = 100 } = {}) {
  if (!isPostgresAvailable()) return jsonDb.listPending({ limit });
  const prisma = getClient();
  const rows = await prisma.segment.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { title: { select: { imdbId: true, title: true } } },
  });
  return rows.map(seg => ({
    imdbId: seg.title.imdbId,
    title: seg.title.title,
    segment: {
      id: seg.id, startMs: seg.startMs, endMs: seg.endMs, category: seg.category,
      severity: seg.severity, channel: seg.channel, comment: seg.comment,
      contributorHash: seg.contributorHash, status: seg.status,
      votes: { up: seg.upvotes, down: seg.downvotes }, addedAt: seg.createdAt,
    },
  }));
}

async function getContributor(hash) {
  if (!hash) return null;
  if (!isPostgresAvailable()) return jsonDb.getContributor(hash);
  return getClient().contributor.findUnique({ where: { hash } });
}

async function saveContributor(hash, data) {
  if (!hash) return null;
  if (!isPostgresAvailable()) return jsonDb.saveContributor(hash, data);
  const { approved = 0, rejected = 0, blocked = false } = data;
  return getClient().contributor.upsert({
    where: { hash },
    update: { approved, rejected, blocked },
    create: { hash, approved, rejected, blocked },
  });
}

/** Progress of automatic imports (any JSON value), keyed by name. */
/** Attach a timing fingerprint to a segment that has none yet. */
async function setSegmentRef(imdbId, segmentId, refId, durationMs) {
  if (!isPostgresAvailable()) return jsonDb.setSegmentRef(imdbId, segmentId, refId, durationMs);
  const prisma = getClient();
  const result = await prisma.segment.updateMany({
    where: { id: segmentId, title: { imdbId }, refId: null },
    data: { refId, durationMs: Number.isInteger(durationMs) ? durationMs : null },
  });
  return result.count > 0;
}

/** Timing fingerprints are stored as key/value pairs next to the import progress. */
async function getTimingRef(refId) {
  return (await getImportState(`ref:${refId}`)) || null;
}

async function saveTimingRef(refId, ref) {
  if (await getImportState(`ref:${refId}`)) return;
  await setImportState(`ref:${refId}`, ref);
}

/**
 * Confirmed and unconfirmed skips across a show's episodes (tt123:1:2, ...),
 * leaving out unconfirmed ones the community has voted down.
 * @returns {{approved: number, pending: number}}
 */
async function countEpisodeSegments(showId) {
  if (!isPostgresAvailable()) return jsonDb.countEpisodeSegments(showId);
  const rows = await getClient().segment.findMany({
    where: { title: { imdbId: { startsWith: `${showId}:` } } },
    select: { status: true, upvotes: true, downvotes: true },
  });
  let approved = 0;
  let pending = 0;
  for (const r of rows) {
    if (r.status === 'approved') approved++;
    else if (r.status === 'pending' && r.downvotes - r.upvotes < 3) pending++;
  }
  return { approved, pending };
}

/** Clear a segment's votes (after the admin decides) so old reports no longer hide it. */
async function resetVotes(imdbId, segmentId) {
  if (!isPostgresAvailable()) return jsonDb.resetVotes(imdbId, segmentId);
  const prisma = getClient();
  const segment = await prisma.segment.findFirst({ where: { id: segmentId, title: { imdbId } }, select: { id: true } });
  if (!segment) return false;
  await prisma.$transaction([
    prisma.vote.deleteMany({ where: { segmentId } }),
    prisma.segment.update({ where: { id: segmentId }, data: { upvotes: 0, downvotes: 0, verified: true, verifiedAt: new Date(), verifiedBy: 'admin' } }),
  ]);
  return true;
}

async function getImportState(key) {
  if (!isPostgresAvailable()) return jsonDb.getImportState(key);
  const row = await getClient().importState.findUnique({ where: { key } });
  return row ? JSON.parse(row.value) : null;
}

async function setImportState(key, value) {
  if (!isPostgresAvailable()) return jsonDb.setImportState(key, value);
  const text = JSON.stringify(value);
  await getClient().importState.upsert({ where: { key }, update: { value: text }, create: { key, value: text } });
}

/**
 * Delete a segment
 */
async function deleteSegment(segmentId) {
  if (!isPostgresAvailable()) {
    // Not implemented for JSON storage
    return false;
  }
  
  const prisma = getClient();
  
  await prisma.segment.delete({
    where: { id: segmentId },
  });
  
  return true;
}

/**
 * Verify a segment (admin function)
 */
async function verifySegment(segmentId, verifiedBy) {
  if (!isPostgresAvailable()) {
    return false;
  }
  
  const prisma = getClient();
  
  await prisma.segment.update({
    where: { id: segmentId },
    data: {
      verified: true,
      verifiedBy,
      verifiedAt: new Date(),
    },
  });
  
  return true;
}

/**
 * Get statistics
 */
async function getStats() {
  if (!isPostgresAvailable()) {
    return jsonDb.getStats();
  }
  
  const prisma = getClient();
  
  const [titleCount, segmentCount, verifiedCount] = await Promise.all([
    prisma.title.count(),
    prisma.segment.count(),
    prisma.segment.count({ where: { verified: true } }),
  ]);
  
  return {
    totalTitles: titleCount,
    totalSegments: segmentCount,
    verifiedSegments: verifiedCount,
  };
}

/**
 * List all titles with filters
 */
async function listTitles(options = {}) {
  if (!isPostgresAvailable()) {
    return jsonDb.listTitles(options);
  }
  
  const prisma = getClient();
  const { limit = 100, offset = 0, hasSegments = true, sortBy = 'recent', type } = options;
  
  // Determine orderBy based on sortBy
  let orderBy;
  switch (sortBy) {
    case 'popular':
      // Sort by segment count (most skips first)
      orderBy = { segments: { _count: 'desc' } };
      break;
    case 'year':
      // Sort by release year (newest first)
      orderBy = { year: 'desc' };
      break;
    case 'title':
      // Sort alphabetically
      orderBy = { title: 'asc' };
      break;
    case 'recent':
    default:
      // Sort by recently added/updated
      orderBy = { updatedAt: 'desc' };
      break;
  }
  
  // Only confirmed skips count: a title whose skips are all unconfirmed or
  // rejected would play unfiltered, so it must not be listed as clean
  const titles = await prisma.title.findMany({
    where: {
      ...(hasSegments ? { segments: { some: { status: 'approved' } } } : {}),
      ...(type ? { type } : {}),
    },
    take: limit,
    skip: offset,
    orderBy: orderBy,
    include: {
      _count: {
        select: { segments: { where: { status: 'approved' } } },
      },
    },
  });
  
  return titles.map(t => ({
    imdbId: t.imdbId,
    title: t.title,
    year: t.year,
    type: t.type,
    segmentCount: t._count.segments,
  }));
}

/**
 * Search titles
 */
async function searchTitles(query) {
  if (!isPostgresAvailable()) {
    return jsonDb.searchTitles(query);
  }
  
  const prisma = getClient();
  
  const titles = await prisma.title.findMany({
    where: {
      OR: [
        { imdbId: { contains: query, mode: 'insensitive' } },
        { title: { contains: query, mode: 'insensitive' } },
      ],
    },
    take: 20,
    include: {
      _count: {
        select: { segments: true },
      },
    },
  });
  
  return titles.map(t => ({
    imdbId: t.imdbId,
    title: t.title,
    year: t.year,
    type: t.type,
    segmentCount: t._count.segments,
  }));
}

/**
 * Bulk import segments (for MCF imports)
 */
async function bulkImportSegments(imdbId, segments, metadata = {}) {
  if (!isPostgresAvailable()) {
    // Fall back to individual inserts for JSON
    for (const seg of segments) {
      jsonDb.addSegment(imdbId, seg);
    }
    return { imported: segments.length };
  }
  
  const prisma = getClient();
  
  // Ensure title exists
  const title = await getOrCreateTitle(imdbId, {
    ...metadata,
    type: metadata.type || (imdbId.includes(':') ? 'episode' : undefined),
  });
  
  // Bulk create segments
  const result = await prisma.segment.createMany({
    data: segments.map(seg => ({
      titleId: title.id,
      startMs: seg.startMs,
      endMs: seg.endMs,
      category: seg.category,
      subcategory: seg.subcategory || seg.category,
      severity: seg.severity || 'high',
      channel: seg.channel || 'both',
      comment: seg.comment,
      contributor: seg.contributor || 'bulk-import',
    })),
    skipDuplicates: true,
  });
  
  return { imported: result.count };
}

module.exports = {
  setSegmentStatus,
  listPending,
  getContributor,
  saveContributor,
  getImportState,
  setImportState,
  isValidContentId: jsonDb.isValidContentId,
  isPostgresAvailable,
  getOrCreateTitle,
  getFilters,
  addSegment,
  setSegmentRef,
  countEpisodeSegments,
  resetVotes,
  getTimingRef,
  saveTimingRef,
  updateTitleMetadata,
  voteSegment,
  deleteSegment,
  verifySegment,
  getStats,
  listTitles,
  searchTitles,
  bulkImportSegments,
};
