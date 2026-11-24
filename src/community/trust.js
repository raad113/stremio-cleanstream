/**
 * Community trust rules
 *
 * Protects viewers from wrong or abusive skips (for example someone marking a
 * long stretch of a film that has no unwanted content):
 *
 *  1. New skips start as "pending" and are NOT skipped automatically for other
 *     viewers. Apps show them as a prompt instead ("A viewer marked this as
 *     kissing: Skip / Not a scene").
 *  2. A pending skip becomes "approved" when
 *       - a different viewer marks the same scene with closely matching times, or
 *       - viewers confirm it: at least APPROVE_NET_VOTES more confirmations than rejections.
 *  3. Any skip is "rejected" (stops being served) once it has REJECT_NET_VOTES
 *     more rejections than confirmations, or when the admin rejects it.
 *  4. Contributors earn trust when their skips are approved and lose it when
 *     they are rejected. Trusted contributors' skips apply straight away;
 *     repeat offenders are blocked automatically.
 *  5. Hard limits on skip length and on pending skips per viewer per title.
 *
 * The person who made a pending skip still gets it applied for themselves.
 */

const RULES = {
  APPROVE_NET_VOTES: 2,
  REJECT_NET_VOTES: 3,

  // Two marks confirm each other when they overlap by at least this share of
  // the LONGER one, so nobody can stretch a real scene into a long cut.
  CORROBORATE_OVERLAP: 0.6,

  // trust = approved - 3 x rejected
  TRUSTED_SCORE: 3,
  AUTO_BLOCK_REJECTED: 5,

  // Longest skip allowed, in milliseconds
  MAX_MS_NEW: 4 * 60 * 1000, // contributors without trust yet
  MAX_MS_TRUSTED: 15 * 60 * 1000,

  MAX_PENDING_PER_TITLE: 10,
};

// Categories that describe the same kind of scene for corroboration
const CATEGORY_GROUP = {
  sex: 'intimacy', nudity: 'intimacy',
  violence: 'violence', fear: 'violence',
  language: 'language', drugs: 'drugs',
};
const groupOf = category => CATEGORY_GROUP[category] || category;

function trustScore(contributor) {
  if (!contributor) return 0;
  return (contributor.approved || 0) - 3 * (contributor.rejected || 0);
}

function isTrusted(contributor) {
  return !!contributor && !contributor.blocked && trustScore(contributor) >= RULES.TRUSTED_SCORE;
}

/** Legacy and bundled segments have no status; treat them as approved. */
function statusOf(segment) {
  return segment.status || 'approved';
}

function overlapShare(a, b) {
  const overlap = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
  if (overlap <= 0) return 0;
  const longer = Math.max(a.endMs - a.startMs, b.endMs - b.startMs);
  return overlap / longer;
}

/**
 * Check a new contribution against the limits.
 * @returns {string|null} an error message, or null when allowed
 */
function checkLimits(segment, contributor, existingSegments) {
  if (contributor && contributor.blocked) {
    return 'Contributions from this device have been disabled';
  }
  const max = isTrusted(contributor) ? RULES.MAX_MS_TRUSTED : RULES.MAX_MS_NEW;
  if (segment.endMs - segment.startMs > max) {
    return `A single skip can be at most ${Math.round(max / 60000)} minutes`;
  }
  const myPending = existingSegments.filter(s =>
    s.contributorHash && s.contributorHash === segment.contributorHash && statusOf(s) === 'pending');
  if (myPending.length >= RULES.MAX_PENDING_PER_TITLE) {
    return 'Too many unconfirmed skips for this title; wait until some are confirmed';
  }
  return null;
}

/**
 * Decide the status of a new contribution.
 * @returns {{status: 'approved'|'pending', corroborates: Array}} segments it confirms
 */
function decideNewStatus(segment, contributor, existingSegments) {
  // Marks of the same scene by OTHER viewers (bundled data counts as another source)
  const matches = existingSegments.filter(s =>
    statusOf(s) !== 'rejected' &&
    groupOf(s.category) === groupOf(segment.category) &&
    (!s.contributorHash || s.contributorHash !== segment.contributorHash) &&
    overlapShare(s, segment) >= RULES.CORROBORATE_OVERLAP);

  if (matches.length > 0) {
    return { status: 'approved', corroborates: matches.filter(s => statusOf(s) === 'pending') };
  }
  if (isTrusted(contributor)) {
    return { status: 'approved', corroborates: [] };
  }
  return { status: 'pending', corroborates: [] };
}

/**
 * New status after votes change, or null when it stays the same.
 */
function statusAfterVotes(segment) {
  const votes = segment.votes || { up: 0, down: 0 };
  const net = (votes.up || 0) - (votes.down || 0);
  const current = statusOf(segment);
  // A confirmed skip that viewers report as wrong goes back to "unconfirmed"
  // (a button instead of an automatic skip) and to the moderation list, rather
  // than disappearing: it may only be wrong for some copies of the film.
  if (current === 'approved' && -net >= RULES.REJECT_NET_VOTES) return 'pending';
  if (current === 'pending' && -net >= RULES.REJECT_NET_VOTES) return 'rejected';
  if (current === 'pending' && net >= RULES.APPROVE_NET_VOTES) return 'approved';
  return null;
}

/**
 * Contributor counters after one of their skips changes status.
 */
function contributorAfterDecision(contributor, newStatus) {
  const c = { approved: 0, rejected: 0, blocked: false, ...(contributor || {}) };
  if (newStatus === 'approved') c.approved += 1;
  if (newStatus === 'rejected') {
    c.rejected += 1;
    if (c.rejected >= RULES.AUTO_BLOCK_REJECTED && c.rejected > c.approved) c.blocked = true;
  }
  return c;
}

module.exports = {
  RULES,
  trustScore,
  isTrusted,
  statusOf,
  overlapShare,
  checkLimits,
  decideNewStatus,
  statusAfterVotes,
  contributorAfterDecision,
};
