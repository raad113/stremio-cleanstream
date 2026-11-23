#!/usr/bin/env node
/**
 * Convert the PostgreSQL dump (cleanstream_backup.sql) into the per-title
 * JSON files used by the JSON storage backend (data/filters/<id>.json).
 *
 * The same JSON files are also used to seed PostgreSQL, so after running this
 * script both storage modes share one source of truth.
 *
 * Usage: node scripts/backup-to-json.js [path/to/backup.sql]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const backupPath = process.argv[2] || path.join(ROOT, 'cleanstream_backup.sql');
const outDir = path.join(ROOT, 'data', 'filters');

// The dump was saved from Windows as UTF-16LE (with BOM); handle both encodings.
function readDump(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^﻿/, '');
  return buf.toString('utf8');
}

// Extract the rows of one `COPY public."Table" (...) FROM stdin;` block.
function copyBlock(sql, table) {
  const lines = sql.split(/\r?\n/);
  const start = lines.findIndex(l => l.startsWith(`COPY public."${table}" (`));
  if (start === -1) return [];
  const columns = lines[start].match(/\(([^)]*)\)/)[1].split(',').map(c => c.trim().replace(/"/g, ''));
  const rows = [];
  for (let i = start + 1; i < lines.length && lines[i] !== '\\.'; i++) {
    const values = lines[i].split('\t').map(v => (v === '\\N' ? null : v.replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')));
    rows.push(Object.fromEntries(columns.map((c, idx) => [c, values[idx]])));
  }
  return rows;
}

const sql = readDump(backupPath);
const titles = copyBlock(sql, 'Title');
const segments = copyBlock(sql, 'Segment');

const byTitleId = new Map();
for (const t of titles) {
  byTitleId.set(t.id, {
    imdbId: t.imdbId,
    title: t.title,
    year: t.year ? parseInt(t.year, 10) : null,
    type: t.type || 'movie',
    segments: [],
    releases: [],
    version: 1,
    createdAt: new Date(t.createdAt + 'Z').toISOString(),
    updatedAt: new Date(t.updatedAt + 'Z').toISOString(),
  });
}

for (const s of segments) {
  const title = byTitleId.get(s.titleId);
  if (!title) continue;
  title.segments.push({
    id: s.id,
    startMs: parseInt(s.startMs, 10),
    endMs: parseInt(s.endMs, 10),
    category: s.category,
    subcategory: s.subcategory || s.category,
    severity: s.severity,
    channel: s.channel || 'both',
    comment: s.comment,
    contributor: s.contributor || 'videoskip-import',
    votes: { up: parseInt(s.upvotes || '0', 10), down: parseInt(s.downvotes || '0', 10) },
    verified: s.verified === 't',
    addedAt: new Date(s.createdAt + 'Z').toISOString(),
  });
}

fs.mkdirSync(outDir, { recursive: true });
let written = 0;
let segCount = 0;
for (const t of byTitleId.values()) {
  if (t.segments.length === 0) continue;
  t.segments.sort((a, b) => a.startMs - b.startMs);
  fs.writeFileSync(path.join(outDir, `${t.imdbId.replace(/:/g, '_')}.json`), JSON.stringify(t, null, 2) + '\n');
  written++;
  segCount += t.segments.length;
}

console.log(`Wrote ${written} titles with ${segCount} segments to ${path.relative(ROOT, outDir)}`);
