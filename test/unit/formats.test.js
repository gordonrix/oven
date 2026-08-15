'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { toTsv, toSequenceList, toCsv, COPY_HEADERS } = require('../../src/formats');

const items = [
  {
    name: 'demo-fwd', sequence: 'ATGCATGC', length: 8, tm: 60.1, tmSource: 'computed',
    sourceName: 'plasmidA', start: 24, end: 31, strand: 1, circularWrap: false, note: '',
    inventoryMatch: { status: 'ok', found: true, name: 'P_042' }
  },
  {
    // Deliberately nasty: a tab in the name, a comma in the source, quotes in
    // the note, no Tm, and a reverse strand that wraps the origin.
    name: 'weird\tname', sequence: 'GGGGCCCC', length: 8, tm: null, tmSource: null,
    sourceName: 'p,B "quoted"', start: 6530, end: 4, strand: -1, circularWrap: true, note: 'a "quote"',
    inventoryMatch: { status: 'ok', found: false }
  },
  {
    name: 'unchecked', sequence: 'TTTT', length: 4, tm: 12, tmSource: 'notes',
    sourceName: 'pX', start: 0, end: 3, strand: 1, circularWrap: false, note: '',
    inventoryMatch: { status: 'unknown', found: false }
  }
];

test('TSV copies name and sequence, and nothing else', () => {
  // What an order form wants. The rest is derivable or irrelevant once a primer
  // is being ordered, and would have to be deleted by hand after pasting.
  const lines = toTsv(items).split('\n');
  assert.strictEqual(lines.length, items.length + 1);
  assert.strictEqual(lines[0], 'Name\tSequence');
  for (const line of lines) {
    assert.strictEqual(line.split('\t').length, COPY_HEADERS.length, `bad column count: ${line}`);
  }
  assert.strictEqual(lines[1], 'demo-fwd\tATGCATGC');
});

test('TSV replaces embedded tabs rather than quoting them', () => {
  // Excel is inconsistent about quoted TSV, so the tab must be gone entirely.
  const tsv = toTsv(items);
  assert.ok(tsv.includes('weird name'));
  assert.ok(!tsv.includes('weird\tname'));
});

test('the full export reports inventory state per row', () => {
  // The detail moved to CSV when TSV was narrowed to an order form; this is
  // still the path for archiving a cart rather than ordering from it.
  const rows = toCsv(items).replace(/^\ufeff/, '').trim().split('\r\n').slice(1);
  assert.match(rows[0], /P_042/);
  assert.match(rows[1], /(^|,)new(,|$)/);
  assert.match(rows[2], /unknown/); // never "new" when the lookup failed
});

test('coordinates are 1-based and flag an origin wrap', () => {
  const csv = toCsv(items);
  assert.match(csv, /(^|,)25\.\.32(,|$)/m);
  assert.match(csv, /6531\.\.5 \(wraps origin\)/);
  assert.match(csv, /reverse/);
});

test('CSV starts with a BOM and quotes properly', () => {
  const csv = toCsv(items);
  assert.strictEqual(csv.charCodeAt(0), 0xfeff, 'missing BOM; Excel on macOS would mangle the degree sign');
  assert.ok(csv.includes('Tm (°C)'));
  assert.ok(csv.includes('"p,B ""quoted"""'));
  assert.ok(csv.includes('"a ""quote"""'));
  assert.ok(csv.endsWith('\r\n'));
});

test('sequence list is bare by default and tab-joined on request', () => {
  assert.strictEqual(toSequenceList(items, false), 'ATGCATGC\nGGGGCCCC\nTTTT');
  assert.strictEqual(
    toSequenceList(items, true),
    'demo-fwd\tATGCATGC\nweird name\tGGGGCCCC\nunchecked\tTTTT'
  );
});

test('empty cart serializes to headers only', () => {
  assert.strictEqual(toTsv([]), COPY_HEADERS.join('\t'));
  assert.strictEqual(toSequenceList([], false), '');
});
