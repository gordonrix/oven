'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { toTsv, toSequenceList, toCsv, HEADERS } = require('../../src/formats');

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

test('TSV has one clean field per column on every line', () => {
  const lines = toTsv(items).split('\n');
  assert.strictEqual(lines.length, items.length + 1);
  for (const line of lines) {
    assert.strictEqual(line.split('\t').length, HEADERS.length, `bad column count: ${line}`);
  }
  assert.ok(lines[0].startsWith('Name\tSequence\tLength\tTm (°C)'));
});

test('TSV replaces embedded tabs rather than quoting them', () => {
  // Excel is inconsistent about quoted TSV, so the tab must be gone entirely.
  const tsv = toTsv(items);
  assert.ok(tsv.includes('weird name'));
  assert.ok(!tsv.includes('weird\tname'));
});

test('TSV reports inventory state per row', () => {
  const rows = toTsv(items).split('\n').slice(1).map((l) => l.split('\t'));
  assert.strictEqual(rows[0][7], 'P_042');
  assert.strictEqual(rows[1][7], 'new');
  assert.strictEqual(rows[2][7], 'unknown'); // never "new" when the lookup failed
});

test('coordinates are 1-based and flag an origin wrap', () => {
  const rows = toTsv(items).split('\n').slice(1).map((l) => l.split('\t'));
  assert.strictEqual(rows[0][5], '25..32');
  assert.strictEqual(rows[1][5], '6531..5 (wraps origin)');
  assert.strictEqual(rows[1][6], 'reverse');
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
  assert.strictEqual(toTsv([]), HEADERS.join('\t'));
  assert.strictEqual(toSequenceList([], false), '');
});
