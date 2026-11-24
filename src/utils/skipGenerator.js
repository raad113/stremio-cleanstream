/**
 * Skip Generator
 * Generates skip instructions based on user preferences and available filter data
 */

const db = require('../database');
const { CATEGORIES } = require('./mcf');
const { statusOf } = require('../community/trust');

// A segment is hidden once the community has clearly rejected it:
// at least this many more downvotes than upvotes.
const DISPUTED_VOTE_MARGIN = 3;

function isDisputed(segment) {
  const votes = segment.votes || { up: 0, down: 0 };
  return (votes.down || 0) - (votes.up || 0) >= DISPUTED_VOTE_MARGIN;
}

// Severity level ordering for comparison
const SEVERITY_LEVELS = {
  off: 0,
  low: 1,
  medium: 2,
  high: 3,
};

/**
 * The user's level says how strict the filter is (matching the configure page):
 *   high   -> skip every flagged scene (low, medium and high severity)
 *   medium -> skip medium and high severity scenes
 *   low    -> skip only high severity scenes
 *   off    -> skip nothing
 */
function meetsFilterLevel(severity, userLevel) {
  const strictness = SEVERITY_LEVELS[userLevel] || 0;
  if (strictness === 0) return false;
  const minimumSeverity = 4 - strictness; // high->1, medium->2, low->3
  return (SEVERITY_LEVELS[severity] || 0) >= minimumSeverity;
}

/**
 * Generate skip segments for a movie/show based on user preferences
 * @param {string} imdbId - IMDB ID
 * @param {object} userConfig - User's filter preferences
 * @returns {array} Array of skip segments
 */
async function generateSkips(imdbId, userConfig = {}, { requesterHash = null } = {}) {
  const filterData = await db.getFilters(imdbId);
  
  if (!filterData || !filterData.segments || filterData.segments.length === 0) {
    return [];
  }
  
  // Default config - skip nothing
  const config = {
    nudity: 'off',
    sex: 'off',
    violence: 'off',
    language: 'off',
    drugs: 'off',
    fear: 'off',
    discrimination: 'off',
    dispensable: 'off',
    commercial: 'off',
    ...userConfig,
  };
  
  const skips = [];
  
  for (const segment of filterData.segments) {
    const category = segment.category;
    const severity = segment.severity;
    const userThreshold = config[category];

    // Ignore segments the community has voted down
    if (isDisputed(segment)) {
      continue;
    }

    // Only confirmed skips apply automatically; a viewer's own pending skips
    // also apply for that viewer. Others' pending skips are offered as prompts.
    const status = statusOf(segment);
    const ownPending = status === 'pending' && requesterHash && segment.contributorHash === requesterHash;
    if (status !== 'approved' && !ownPending) {
      continue;
    }
    
    // Skip if user hasn't enabled this category
    if (!userThreshold || userThreshold === 'off') {
      continue;
    }
    
    if (meetsFilterLevel(severity, userThreshold)) {
      skips.push({
        id: segment.id,
        startMs: segment.startMs,
        endMs: segment.endMs,
        startTime: formatTimeForDisplay(segment.startMs),
        endTime: formatTimeForDisplay(segment.endMs),
        duration: segment.endMs - segment.startMs,
        category,
        subcategory: segment.subcategory,
        severity,
        channel: segment.channel || 'both',
        sourceIds: [segment.id],
        refId: segment.refId || null,
        durationMs: segment.durationMs || null,
        description: segment.comment || generateDescription(category, severity),
      });
    }
  }
  
  // Sort by start time and merge overlapping segments
  return mergeOverlappingSkips(skips.sort((a, b) => a.startMs - b.startMs));
}

/**
 * Other viewers' pending (unconfirmed) skips that match the user's filters.
 * They are not merged, so each can be confirmed or rejected on its own.
 */
async function generatePendingSkips(imdbId, userConfig = {}, { requesterHash = null } = {}) {
  const filterData = await db.getFilters(imdbId);
  if (!filterData || !filterData.segments) return [];
  return filterData.segments
    .filter(seg => statusOf(seg) === 'pending' && !isDisputed(seg))
    .filter(seg => !requesterHash || seg.contributorHash !== requesterHash)
    .filter(seg => meetsFilterLevel(seg.severity, userConfig[seg.category]))
    .sort((a, b) => a.startMs - b.startMs)
    .map(seg => ({
      id: seg.id,
      startMs: seg.startMs,
      endMs: seg.endMs,
      duration: seg.endMs - seg.startMs,
      category: seg.category,
      severity: seg.severity,
      channel: seg.channel || 'both',
      sourceIds: [seg.id],
      refId: seg.refId || null,
      durationMs: seg.durationMs || null,
      description: seg.comment || generateDescription(seg.category, seg.severity),
      votes: seg.votes || { up: 0, down: 0 },
    }));
}

/**
 * Merge overlapping skip segments
 */
function mergeOverlappingSkips(skips) {
  if (skips.length < 2) return skips;
  
  const merged = [skips[0]];
  
  for (let i = 1; i < skips.length; i++) {
    const current = skips[i];
    const last = merged[merged.length - 1];
    
    // Merge when overlapping or adjacent (within 500ms), but only skips timed on
    // the same copy: the player lines up each copy's times separately
    if (current.startMs <= last.endMs + 500 && (current.refId || null) === (last.refId || null)) {
      // Extend the last segment
      last.endMs = Math.max(last.endMs, current.endMs);
      last.endTime = formatTimeForDisplay(last.endMs);
      last.duration = last.endMs - last.startMs;
      last.sourceIds = [...(last.sourceIds || []), ...(current.sourceIds || [])];
      // A merged block is only "audio only" if every part is audio only
      if (current.channel !== last.channel) last.channel = 'both';
      
      // Combine descriptions
      if (current.category !== last.category) {
        last.description = `${last.description}, ${current.category}`;
      }
    } else {
      merged.push(current);
    }
  }
  
  return merged;
}

/**
 * Generate human-readable description
 */
function generateDescription(category, severity) {
  const descriptions = {
    nudity: 'Nudity',
    sex: 'Sexual content',
    violence: 'Violence',
    language: 'Strong language',
    drugs: 'Drug/alcohol use',
    fear: 'Frightening scene',
    discrimination: 'Discriminatory content',
    dispensable: 'Skippable scene',
    commercial: 'Product placement',
  };
  
  return descriptions[category] || category;
}

/**
 * Format milliseconds for display (MM:SS)
 */
function formatTimeForDisplay(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Generate a VTT file with skip markers
 * This is a creative approach - we embed skip data as subtitles
 * that can be parsed by a companion script/extension
 */
function generateSkipVTT(skips, imdbId) {
  let vtt = 'WEBVTT CleanStream Skip Data\n';
  vtt += `X-CLEANSTREAM-VERSION: 1.0.0\n`;
  vtt += `X-CLEANSTREAM-IMDB: ${imdbId}\n`;
  vtt += `X-CLEANSTREAM-TOTAL-SKIPS: ${skips.length}\n\n`;
  
  skips.forEach((skip, index) => {
    // Add 1 second before each skip as a warning
    const warningStart = Math.max(0, skip.startMs - 3000);
    const warningEnd = skip.startMs;
    
    vtt += `${index + 1}-warning\n`;
    vtt += `${formatVTTTimestamp(warningStart)} --> ${formatVTTTimestamp(warningEnd)}\n`;
    vtt += `<c.cleanstream-warning>⏭️ Scene skip in 3s (${skip.description})</c>\n\n`;
    
    // Add skip marker during the scene
    vtt += `${index + 1}-skip\n`;
    vtt += `${formatVTTTimestamp(skip.startMs)} --> ${formatVTTTimestamp(skip.endMs)}\n`;
    vtt += `<c.cleanstream-skip>⏭️ Press → to skip (${skip.description})</c>\n\n`;
  });
  
  return vtt;
}

/**
 * Generate JSON skip data for programmatic use
 */
function generateSkipJSON(skips, imdbId, metadata = {}) {
  return {
    version: '1.0.0',
    imdbId,
    metadata,
    generatedAt: new Date().toISOString(),
    totalSkips: skips.length,
    totalSkipTime: skips.reduce((sum, s) => sum + s.duration, 0),
    skips,
  };
}

/**
 * Format VTT timestamp
 */
function formatVTTTimestamp(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const milliseconds = ms % 1000;
  
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
}

module.exports = {
  generateSkips,
  generatePendingSkips,
  generateSkipVTT,
  generateSkipJSON,
  mergeOverlappingSkips,
  formatTimeForDisplay,
  formatVTTTimestamp,
  SEVERITY_LEVELS,
  isDisputed,
  meetsFilterLevel,
};
