'use strict';

/*
 * Reads that cross the origin.
 *
 * A read whose tail belongs at a lower reference position than its head cannot
 * be aligned against a linear reference: alignment only moves forward, so the
 * tail is left dangling past the end and counted as hundreds of mismatches. No
 * gap penalty changes that. The read is aligned against the reference written
 * twice instead, then folded back onto one turn.
 */

const test = require('node:test');
const assert = require('node:assert');

const { overhangsEnd, foldOntoReference, toSharedColumns, countDifferences } =
  require('../../src/align');

test('a read dangling past the end of the reference is spotted', () => {
  //                       reference runs out here ─┐
  assert.strictEqual(overhangsEnd('ACGTACGT----', 'ACGTACGTAAAA'), 4);
  assert.strictEqual(overhangsEnd('ACGTACGTACGT', 'ACGTACGTACGT'), 0);
  // Trailing gaps in the READ are the ordinary case: it simply stopped early.
  assert.strictEqual(overhangsEnd('ACGTACGTACGT', 'ACGTACGT----'), 0);
  assert.strictEqual(overhangsEnd('ACGT', '----'), 0, 'a read with no bases at all');
});

/*
 * Reference of 10. The read produces 6-9 first, then 2-3 -- so it carried on
 * through 0-1 and did not find them (a deletion), while 4-5 is simply where it
 * stopped (never reached).
 *
 *   doubled reference   0 1 2 3 4 5 6 7 8 9 | 0 1 2 3 4 5 6 7 8 9
 *   read                            G T A C |     G T
 */
const DOUBLED = 'ACGTACGTAC' + 'ACGTACGTAC';
const READ_ROW = '------GTAC' + '--GT------';

test('a folded read lands on the reference positions it belongs to', () => {
  const { placed } = foldOntoReference(DOUBLED, READ_ROW, 10);
  assert.strictEqual(placed[6], 'G');
  assert.strictEqual(placed[9], 'C');
  assert.strictEqual(placed[2], 'G');
  assert.strictEqual(placed[3], 'T');
  assert.strictEqual(placed[4], null, 'never reached');
  assert.strictEqual(placed[0], null, 'deleted');
});

test('coverage and deletion are told apart by read order', () => {
  const { covered, deleted } = foldOntoReference(DOUBLED, READ_ROW, 10);
  assert.deepStrictEqual(covered, [[2, 3], [6, 9]]);
  /*
   * Note the deletion wraps the origin: the read went off the end at 9 and
   * resumed at 2, so 0-1 is what it passed through and did not find. 4-5 is
   * merely where it stopped. Reading the two the same way is the bug this
   * exists to prevent.
   */
  assert.deepStrictEqual(deleted, [[0, 1]]);
});

test('a folded row is written into the shared column space', () => {
  const { placed } = foldOntoReference(DOUBLED, READ_ROW, 10);
  // The shared reference carries an extra column for another read's insertion.
  const shared = 'ACGTA-CGTAC';
  const row = toSharedColumns(placed, shared);
  assert.strictEqual(row.length, shared.length, 'every row must stay the same length');
  assert.strictEqual(row[5], '-', 'another read\'s insertion gets a gap here');
  assert.strictEqual(row[2], 'G');
  assert.strictEqual(row[10], 'C');
});

test('scoring counts the deletion and ignores what was never reached', () => {
  const { placed, covered, deleted } = foldOntoReference(DOUBLED, READ_ROW, 10);
  const reference = 'ACGTACGTAC';
  const row = toSharedColumns(placed, reference);
  const out = countDifferences(reference, row, { covered, deleted });
  assert.strictEqual(out.substitutions, 0);
  assert.strictEqual(out.gaps, 2, 'the two deleted bases, and only those');
  assert.strictEqual(out.compared, 6, 'the six bases the read actually placed');
  assert.strictEqual(out.identity, 1, 'every base it did read agrees');
});

test('a deletion that wraps the origin is still scored', () => {
  // Covered 2-7; the read carried on through 8-9 and 0-1 and did not find them.
  const reference = 'ACGTACGTAC';
  const row = '--GTACGT--';
  const out = countDifferences(reference, row, { covered: [[2, 7]], deleted: [[8, 1]] });
  assert.strictEqual(out.gaps, 4, 'both ends of a wrapping deletion count');
  assert.strictEqual(out.compared, 6);
});
