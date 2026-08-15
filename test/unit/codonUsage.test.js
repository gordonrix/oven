'use strict';

/*
 * The codon tables themselves.
 *
 * These are transcribed numbers, so the failure mode is not a crash but a
 * plausible wrong value that silently informs a cloning decision. Each table is
 * checked against an independently built genetic code, for internal
 * consistency, and for coverage.
 *
 * The coverage check is the one that has already caught something. Kazusa has
 * several E. coli entries, and the obvious one -- K-12, taxid 83333 -- is built
 * from too few CDSs to contain an amber stop, so it reports TAG at exactly
 * zero. That reads as "E. coli never uses TAG", which is wrong, and it passes a
 * fractions-sum-to-one check because the other two stops absorb it.
 */

const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
require('../../media/codonUsage');
const usage = global.window.OveCodonUsage;

/** The standard code, derived here rather than imported, so it is a real check. */
const BASES = 'TCAG';
const AAS = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG';
const CODE = {};
{
  let i = 0;
  for (const a of BASES) for (const b of BASES) for (const c of BASES) CODE[a + b + c] = AAS[i++];
}

const organisms = () => usage.ORGANISMS.map((o) => o.key);

test('every organism has all 64 codons, once', () => {
  for (const key of organisms()) {
    const table = usage.TABLES[key];
    assert.equal(Object.keys(table).length, 64, `${key} has ${Object.keys(table).length} codons`);
  }
});

test('the amino acid on every codon matches the genetic code', () => {
  for (const key of organisms()) {
    for (const [codon, entry] of Object.entries(usage.TABLES[key])) {
      assert.equal(entry.aa, CODE[codon], `${key} ${codon}`);
    }
  }
});

test("each amino acid's fractions sum to one", () => {
  for (const key of organisms()) {
    const family = {};
    for (const entry of Object.values(usage.TABLES[key])) {
      family[entry.aa] = (family[entry.aa] || 0) + entry.fraction;
    }
    for (const [aa, total] of Object.entries(family)) {
      // A wide tolerance: the published figures are rounded to two places, and
      // six codons rounding the same way is enough to drift.
      assert.ok(Math.abs(total - 1) <= 0.03, `${key} ${aa} sums to ${total.toFixed(2)}`);
    }
  }
});

test('no codon is reported as never used', () => {
  for (const key of organisms()) {
    for (const [codon, entry] of Object.entries(usage.TABLES[key])) {
      assert.ok(entry.fraction > 0, `${key} ${codon} has a fraction of ${entry.fraction}`);
      assert.ok(entry.frequency > 0, `${key} ${codon} has a frequency of ${entry.frequency}`);
    }
  }
});

test('the E. coli table is the one with a real amber stop', () => {
  // Pinned because the wrong entry is the easier one to reach for.
  const table = usage.TABLES['E. coli'];
  assert.ok(table.TAG.fraction >= 0.05, `TAG fraction is ${table.TAG.fraction}`);
  assert.match(usage.sourceUrl('E. coli'), /species=316407/);
});

test('the grid is the printed arrangement, and covers everything', () => {
  assert.deepStrictEqual(usage.ORDER, ['T', 'C', 'A', 'G']);
  assert.equal(usage.GRID.length, 4);
  assert.deepStrictEqual(usage.GRID[0][0], ['TTT', 'TTC', 'TTA', 'TTG']);
  assert.deepStrictEqual(usage.GRID[0].map((cell) => cell[0]), ['TTT', 'TCT', 'TAT', 'TGT']);
  assert.equal(new Set(usage.GRID.flat(2)).size, 64);
});

test('numbers print the way the published tables do', () => {
  assert.equal(usage.num(1), '1');
  assert.equal(usage.num(0.4), '0.4');
  assert.equal(usage.num(34), '34');
  assert.equal(usage.num(21.7), '21.7');
});

test('every organism links to its own table', () => {
  const seen = new Set();
  for (const organism of usage.ORGANISMS) {
    const url = usage.sourceUrl(organism.key);
    assert.match(url, /showcodon\.cgi\?species=\d+/, organism.key);
    assert.ok(!seen.has(url), `${organism.key} shares a source url`);
    seen.add(url);
  }
});
