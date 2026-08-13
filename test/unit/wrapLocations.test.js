'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { genbankToJson, jsonToGenbank } = require('../../media/bioparser2.umd.js');
const {
  locationsRestateOrigin, dropRedundantWrapLocations, restoreWrapLocations
} = require('../../media/cartShared.js');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'synthetic-plasmid.gb');
const LEN = 6537; // matches the fixture

const wrapping = (over) => Object.assign(
  { start: 6500, end: 60, locations: [{ start: 6500, end: LEN - 1 }, { start: 0, end: 60 }] },
  over
);

const seqData = (annotations) => ({
  sequence: 'a'.repeat(LEN),
  features: annotations
});

test('recognises locations that only restate an origin wrap', () => {
  assert.strictEqual(locationsRestateOrigin(wrapping(), LEN), true);
  // Order is not guaranteed by the parser, so both orderings must be caught.
  assert.strictEqual(locationsRestateOrigin(wrapping({
    locations: [{ start: 0, end: 60 }, { start: 6500, end: LEN - 1 }]
  }), LEN), true);
});

test('leaves a genuine spliced join alone', () => {
  // Two exons with a gap: the locations carry information start/end cannot.
  const spliced = { start: 100, end: 900, locations: [{ start: 100, end: 300 }, { start: 700, end: 900 }] };
  assert.strictEqual(locationsRestateOrigin(spliced, LEN), false);

  const data = seqData({ a: spliced });
  assert.strictEqual(dropRedundantWrapLocations(data), 0);
  assert.ok(data.features.a.locations, 'a spliced join must keep its exons');
});

test('leaves a wrapping annotation whose halves do not meet the origin', () => {
  // Wraps, two locations, but they are not the origin split -- so not ours to touch.
  const odd = wrapping({ locations: [{ start: 6500, end: 6520 }, { start: 0, end: 60 }] });
  assert.strictEqual(locationsRestateOrigin(odd, LEN), false);
});

test('strips the redundant locations across every annotation type', () => {
  const data = {
    sequence: 'a'.repeat(LEN),
    features: { f: wrapping() },
    primers: { p: wrapping() },
    parts: { q: wrapping() }
  };
  assert.strictEqual(dropRedundantWrapLocations(data), 3);
  assert.strictEqual(data.features.f.locations, undefined);
  assert.strictEqual(data.primers.p.locations, undefined);
  assert.strictEqual(data.parts.q.locations, undefined);
});

test('restore is the inverse of drop', () => {
  const data = seqData({ f: wrapping() });
  const before = JSON.parse(JSON.stringify(data));
  dropRedundantWrapLocations(data);
  restoreWrapLocations(data);
  assert.deepStrictEqual(data, before);
});

test('restore also gives a wrapping annotation that never had locations some', () => {
  // A primer drawn across the origin inside the editor arrives with no
  // locations at all, and would otherwise be written as "6501..61".
  const data = seqData({ f: { start: 6500, end: 60 } });
  assert.strictEqual(restoreWrapLocations(data), 1);
  assert.deepStrictEqual(data.features.f.locations,
    [{ start: 6500, end: LEN - 1 }, { start: 0, end: 60 }]);
});

test('restore does not touch a non-wrapping annotation', () => {
  const data = seqData({ f: { start: 10, end: 20 } });
  assert.strictEqual(restoreWrapLocations(data), 0);
  assert.strictEqual(data.features.f.locations, undefined);
});

/*
 * The one that actually matters: stripping is display-only, so a file that
 * goes through the editor untouched must come back out spelled the same way.
 * Without the restore the writer emits "6501..61" instead of join(...), which
 * other tools may not read.
 */
test('a plasmid survives load -> strip -> restore -> save unchanged', () => {
  const src = fs.readFileSync(FIXTURE, 'utf8');
  const parsed = genbankToJson(src)[0].parsedSequence;

  const joinsBefore = jsonToGenbank(parsed).split('\n').filter((l) => l.includes('join('));
  assert.ok(joinsBefore.length, 'the fixture must contain an origin-spanning join to be worth testing');

  assert.ok(dropRedundantWrapLocations(parsed) > 0, 'the wrap should have been stripped');
  restoreWrapLocations(parsed);

  const out = jsonToGenbank(parsed);
  assert.deepStrictEqual(out.split('\n').filter((l) => l.includes('join(')), joinsBefore);

  // The failure mode this guards: a bare "6501..61" where the writer gave up
  // on the join and emitted a span that runs backwards.
  const backwards = out.split('\n')
    .map((l) => l.match(/^\s{5}\S+\s+(?:complement\()?(\d+)\.\.(\d+)\)?\s*$/))
    .filter((m) => m && Number(m[1]) > Number(m[2]));
  assert.deepStrictEqual(backwards.map((m) => m[0].trim()), [],
    'no feature may be written with start > end');

  const reparsed = genbankToJson(out)[0].parsedSequence;
  const key = (g) => Object.values(g || {})
    .map((a) => `${a.name}:${a.start}-${a.end}:${a.strand}`).sort().join('|');
  assert.strictEqual(key(reparsed.features), key(parsed.features));
  assert.strictEqual(key(reparsed.primers), key(parsed.primers));
  assert.strictEqual(reparsed.sequence, parsed.sequence);
});
