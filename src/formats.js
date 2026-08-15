/* Serializers for the cart's copy and export actions. */
'use strict';

const HEADERS = [
  'Name', 'Sequence', 'Length', 'Tm (°C)',
  'Source plasmid', 'Coordinates', 'Strand', 'In inventory', 'Note'
];

function coords(item) {
  if (item.start === null || item.end === null) return '';
  // Display 1-based inclusive, matching how GenBank and OVE show positions.
  return `${item.start + 1}..${item.end + 1}${item.circularWrap ? ' (wraps origin)' : ''}`;
}

function inventoryCell(item) {
  const m = item.inventoryMatch;
  if (!m) return '';
  if (m.status === 'unknown') return 'unknown';
  return m.found ? m.name || 'yes' : 'new';
}

function row(item) {
  return [
    item.name,
    item.sequence,
    String(item.length),
    item.tm === null || item.tm === undefined ? '' : String(item.tm),
    item.sourceName || '',
    coords(item),
    item.strand === -1 ? 'reverse' : 'forward',
    inventoryCell(item),
    item.note || ''
  ];
}

/*
 * Name and sequence only. That is what an order form wants and what you paste
 * into a lab notebook; length, Tm, source, coordinates and inventory state are
 * all derivable or irrelevant once a primer is being ordered, and pasting nine
 * columns into a two-column form means deleting seven of them by hand.
 *
 * The full set is still one click away as CSV export, which is the path for
 * archiving a cart rather than ordering from it.
 */
const COPY_HEADERS = ['Name', 'Sequence'];

/**
 * Tab-separated, for pasting into Excel or Sheets.
 *
 * Excel does not handle quoted TSV consistently, so rather than quote we strip
 * the characters that would break the grid. Names come from GenBank LOCUS and
 * /label fields and occasionally contain tabs.
 */
function toTsv(items) {
  const clean = (v) => String(v === null || v === undefined ? '' : v).replace(/[\t\r\n]+/g, ' ');
  const lines = [COPY_HEADERS.join('\t')];
  for (const item of items) lines.push([item.name, item.sequence].map(clean).join('\t'));
  return lines.join('\n');
}

/** One sequence per line for bulk oligo order forms, optionally name-prefixed. */
function toSequenceList(items, includeName) {
  return items
    .map((it) => (includeName ? `${String(it.name).replace(/[\t\r\n]+/g, ' ')}\t${it.sequence}` : it.sequence))
    .join('\n');
}

function csvField(v) {
  const s = String(v === null || v === undefined ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * RFC4180 CSV with a UTF-8 BOM -- without it Excel on macOS renders the
 * degree sign in the Tm header as mojibake.
 */
function toCsv(items) {
  const lines = [HEADERS.map(csvField).join(',')];
  for (const item of items) lines.push(row(item).map(csvField).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = {
  COPY_HEADERS, toTsv, toSequenceList, toCsv, HEADERS };
