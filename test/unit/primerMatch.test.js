'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { searchPlasmid, buildIndex, search, inWindow } = require('../../src/primerMatch');
const { revComp } = require('../../media/cartShared');

/*
 * Deterministic pseudo-random sequence. A real PRNG matters here: an earlier
 * fixture built from tandem repeats made every "unique" primer match in three
 * places, which silently broke the position, dedupe and ordering assertions.
 * mulberry32 rather than an LCG, whose low bits are near-periodic.
 */
function randomSeq(length, seed) {
  let a = seed >>> 0;
  const bases = 'ACGT';
  let out = '';
  for (let i = 0; i < length; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out += bases[((t ^ (t >>> 14)) >>> 0) % 4];
  }
  return out;
}

// 300 bp with no accidental repeat long enough to confuse a >=15 nt primer.
const SEQ = randomSeq(300, 20260810);
const N = SEQ.length;

const p = (name, sequence, extra) => Object.assign({ name, sequence }, extra);
const find = (hits, name, strand) =>
  hits.filter((h) => h.name === name && (strand === undefined || h.strand === strand));

test('a forward primer matches with its full length and no overhang', () => {
  const { hits } = searchPlasmid(SEQ, false, [p('FWD', SEQ.slice(40, 68))]);
  const h = find(hits, 'FWD', 1);
  assert.ok(h.length >= 1);
  assert.strictEqual(h[0].anneal, 28);
  assert.strictEqual(h[0].overhang, 0);
  assert.strictEqual(h[0].start, 40);
  assert.strictEqual(h[0].end, 67);
  assert.strictEqual(h[0].threePrime, 67, 'a forward primer 3\' end is its right edge');
});

test('a reverse primer reports its 3\' end at the left edge', () => {
  const { hits } = searchPlasmid(SEQ, false, [p('REV', revComp(SEQ.slice(40, 68)))]);
  const h = find(hits, 'REV', -1);
  assert.ok(h.length >= 1);
  assert.strictEqual(h[0].anneal, 28);
  assert.strictEqual(h[0].start, 40);
  assert.strictEqual(h[0].end, 67);
  assert.strictEqual(h[0].threePrime, 40, 'a reverse primer 3\' end is its left edge');
});

test('a 5\' tail is excluded from the annealing length, not from the match', () => {
  // This is the case whole-sequence matching cannot find at all.
  const tail = 'GGGGCCCCTTTT';
  const { hits } = searchPlasmid(SEQ, false, [p('TAILED', tail + SEQ.slice(90, 115))]);
  const h = find(hits, 'TAILED', 1);
  assert.ok(h.length >= 1);
  assert.strictEqual(h[0].anneal, 25, 'only the template-matching part counts');
  assert.strictEqual(h[0].overhang, tail.length);
  assert.strictEqual(h[0].start, 90);
  assert.strictEqual(h[0].end, 114);
});

test('case in the inventory sequence is irrelevant to matching', () => {
  const lower = SEQ.slice(40, 68).toLowerCase();
  const mixed = 'ggggccccTTTT' + SEQ.slice(90, 115).toLowerCase();
  const { hits } = searchPlasmid(SEQ, false, [p('LOWER', lower), p('MIXED', mixed)]);
  assert.strictEqual(find(hits, 'LOWER')[0].overhang, 0);
  assert.strictEqual(find(hits, 'MIXED')[0].anneal, 25);
  assert.strictEqual(find(hits, 'MIXED')[0].overhang, 12);
});

test('the original-case sequence is preserved on the hit for ordering', () => {
  const mixed = 'ggggccccttttAGAGT' + SEQ.slice(95, 115);
  const { hits } = searchPlasmid(SEQ, false, [p('CASED', mixed)]);
  assert.strictEqual(hits[0].sequence, mixed, 'must not be uppercased on the way out');
});

test('an origin-spanning primer is found only when the sequence is circular', () => {
  const spanning = SEQ.slice(N - 12) + SEQ.slice(0, 12);

  const circular = searchPlasmid(SEQ, true, [p('SPAN', spanning)]).hits;
  const h = find(circular, 'SPAN', 1);
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].anneal, 24);
  assert.strictEqual(h[0].start, N - 12);
  assert.strictEqual(h[0].end, 11);
  assert.ok(h[0].wraps, 'end < start marks the origin wrap');

  const linear = searchPlasmid(SEQ, false, [p('SPAN', spanning)]).hits;
  assert.strictEqual(find(linear, 'SPAN').length, 0, 'a linear sequence has no origin to span');
});

test('an origin-spanning reverse primer is found too', () => {
  const spanning = revComp(SEQ.slice(N - 12) + SEQ.slice(0, 12));
  const h = find(searchPlasmid(SEQ, true, [p('SPANREV', spanning)]).hits, 'SPANREV', -1);
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].anneal, 24);
  assert.strictEqual(h[0].threePrime, N - 12);
});

test('a repeated site yields one hit per occurrence', () => {
  // Explicitly duplicate a motif rather than relying on chance.
  const motif = SEQ.slice(40, 70);
  const doubled = SEQ.slice(0, 150) + motif + SEQ.slice(150);
  const { hits } = searchPlasmid(doubled, false, [p('REPEAT', motif)]);
  assert.strictEqual(find(hits, 'REPEAT', 1).length, 2,
    'two genuine binding sites are two hits, not one');
  assert.notStrictEqual(hits[0].threePrime, hits[1].threePrime);
});

test('duplicate inventory rows collapse to a single hit', () => {
  const seq = SEQ.slice(40, 68);
  const { hits } = searchPlasmid(SEQ, false, [p('DUP', seq), p('DUP', seq), p('DUP', seq)]);
  assert.strictEqual(find(hits, 'DUP', 1).length, 1);
});

test('minAnneal is enforced at the boundary', () => {
  const twenty = SEQ.slice(50, 70);
  assert.strictEqual(searchPlasmid(SEQ, false, [p('X', twenty)], { minAnneal: 20 }).hits.length >= 1, true);
  assert.strictEqual(searchPlasmid(SEQ, false, [p('X', twenty)], { minAnneal: 21 }).hits.length, 0);
});

test('degenerate and too-short entries are skipped, not thrown on', () => {
  const { hits, skipped, scanned } = searchPlasmid(SEQ, false, [
    p('DEGENERATE', 'ATGCNNNNATGCATGCATGC'),
    p('SHORT', 'ATGCA'),
    p('GOOD', SEQ.slice(40, 68))
  ]);
  assert.strictEqual(skipped, 2);
  assert.strictEqual(scanned, 1);
  assert.strictEqual(find(hits, 'GOOD').length >= 1, true);
});

test('selection scoping keeps a hit whose 3\' end is inside but whose 5\' end is not', () => {
  // The explicit requirement. The primer starts at 90 and ends at 114; the
  // window opens at 100, so the match runs into it from outside.
  const primer = SEQ.slice(90, 115); // 3' end at 114
  const opts = (sel) => ({ selection: sel });

  const inside = searchPlasmid(SEQ, false, [p('EDGE', primer)], opts({ start: 100, end: 130 })).hits;
  assert.strictEqual(find(inside, 'EDGE', 1).length, 1, '3\' end at 114 is inside 100..130');

  const outside = searchPlasmid(SEQ, false, [p('EDGE', primer)], opts({ start: 60, end: 100 })).hits;
  assert.strictEqual(find(outside, 'EDGE', 1).length, 0,
    '3\' end at 114 is outside 60..100 even though the match overlaps the window');
});

test('selection scoping uses the reverse primer\'s own 3\' end', () => {
  const primer = revComp(SEQ.slice(90, 115)); // 3' end at 90
  const a = searchPlasmid(SEQ, false, [p('R', primer)], { selection: { start: 85, end: 95 } }).hits;
  assert.strictEqual(find(a, 'R', -1).length, 1);
  const b = searchPlasmid(SEQ, false, [p('R', primer)], { selection: { start: 105, end: 120 } }).hits;
  assert.strictEqual(find(b, 'R', -1).length, 0, 'the 5\' end is in that window, but the 3\' end is not');
});

test('an origin-spanning selection window is honoured', () => {
  assert.ok(inWindow(5, 170, 20, 180));
  assert.ok(inWindow(175, 170, 20, 180));
  assert.ok(!inWindow(100, 170, 20, 180));
  const primer = SEQ.slice(0, 25); // 3' end at 24
  const hits = searchPlasmid(SEQ, true, [p('W', primer)], { selection: { start: 170, end: 30 } }).hits;
  assert.strictEqual(find(hits, 'W', 1).length, 1);
});

test('hits are sorted by position, then by cleanest overhang', () => {
  const core = SEQ.slice(60, 85);
  const { hits } = searchPlasmid(SEQ, false, [
    p('LATE', SEQ.slice(120, 145)),
    p('TAILED', 'GGGGCCCCTTTTAAAA' + core),
    p('CLEAN', core)
  ]);
  const names = hits.filter((h) => h.strand === 1).map((h) => h.name);
  assert.deepStrictEqual(names.slice(0, 3), ['CLEAN', 'TAILED', 'LATE'],
    'same site: no-tail first; then later positions');
});

test('Tm is computed over the annealing region only', () => {
  const core = SEQ.slice(60, 85);
  const clean = searchPlasmid(SEQ, false, [p('A', core)]).hits[0];
  const tailed = searchPlasmid(SEQ, false, [p('B', 'GGGGCCCCTTTTAAAA' + core)]).hits[0];
  assert.strictEqual(clean.tm, tailed.tm, 'the tail must not inflate the Tm');
  assert.ok(Number.isFinite(clean.tm));
});

test('maxHits truncates rather than running away', () => {
  const many = Array.from({ length: 50 }, (_, i) => p('P' + i, SEQ.slice(i, i + 25)));
  const all = searchPlasmid(SEQ, false, many, {});
  assert.strictEqual(all.hits.length, 50);
  assert.ok(!all.truncated);

  const capped = searchPlasmid(SEQ, false, many, { maxHits: 10 });
  assert.ok(capped.truncated);
  assert.strictEqual(capped.hits.length, 10);
});

test('indexing and scanning an inventory-sized set stays well under 50 ms', () => {
  // The real workload: 10 kb plasmid, 1308 primers.
  const big = randomSeq(10000, 424242);
  const entries = [];
  for (let i = 0; i < 1308; i++) {
    const at = (i * 7) % (big.length - 60);
    entries.push(p('P' + i, big.slice(at, at + 20 + (i % 25))));
  }
  const t0 = process.hrtime.bigint();
  const index = buildIndex(big, true, 100);
  const res = search(index, entries, {});
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(res.hits.length >= 1308, `expected every planted primer to be found, got ${res.hits.length}`);
  assert.ok(!res.truncated, 'a normal workload must not hit the work budget');
  assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`);
});

test('a low-complexity sequence is bounded by the work budget instead of hanging', () => {
  // A fully periodic template is the pathological case: every anchor matches
  // everywhere and every extension runs the length of the tract.
  const periodic = 'AT'.repeat(5000);
  const entries = Array.from({ length: 200 }, (_, i) => p('P' + i, 'AT'.repeat(15 + (i % 10))));
  const t0 = process.hrtime.bigint();
  const res = searchPlasmid(periodic, true, entries, {});
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(res.truncated, 'should report truncation rather than pretending it finished');
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms; the budget is meant to stop this dead`);
});
