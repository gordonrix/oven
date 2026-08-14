'use strict';

/*
 * The read verdict, which is the most-read output the alignment panel has: a
 * green "match" is a claim that the whole construct was checked, so getting it
 * wrong is worse than showing nothing.
 *
 * The rule:
 *   match          perfect, and covers the reference end to end
 *   partial match  perfect over at least MIN_COVERED_BP of it
 *   mismatch       any substitution, insertion or deletion
 */

const test = require('node:test');
const assert = require('node:assert');

const { alignmentVerdict, MIN_COVERED_BP } = require('../../media/cartShared');

const REF_LEN = 4489; // the worked example
const read = (over) => Object.assign({ mismatches: 0, compared: REF_LEN }, over);
const verdictOf = (over, len = REF_LEN) => alignmentVerdict(read(over), len);

/* ------------------------------------------------------------------ match -- */

test('perfect and end to end is a match', () => {
  assert.strictEqual(verdictOf({ mismatches: 0, compared: REF_LEN }), 'match');
});

test('a single base short of full coverage is not a match', () => {
  // "match" claims the whole reference was checked, so it has to mean it.
  assert.strictEqual(verdictOf({ compared: REF_LEN - 1 }), 'partial match');
});

/* ---------------------------------------------------------- partial match -- */

test('a perfect window is a partial match, however long the reference', () => {
  for (const covered of [MIN_COVERED_BP, 100, 800, 2000, REF_LEN - 1]) {
    assert.strictEqual(verdictOf({ compared: covered }), 'partial match', `covered ${covered}`);
  }
});

test('a Sanger-sized read can never be a match', () => {
  // The distinction the whole scheme exists for: a window cannot vouch for a
  // plasmid, so only whole-plasmid sequencing turns the reference green.
  for (const covered of [500, 700, 900, 1100]) {
    assert.notStrictEqual(verdictOf({ compared: covered }), 'match', `covered ${covered}`);
  }
});

/* --------------------------------------------------------------- mismatch -- */

test('any difference is a mismatch, whatever the coverage', () => {
  // One wrong base is one wrong base whether the read spans 800 bp or the lot.
  for (const covered of [MIN_COVERED_BP, 800, REF_LEN]) {
    assert.strictEqual(verdictOf({ mismatches: 1, compared: covered }), 'mismatch',
      `one difference over ${covered} bp`);
    assert.strictEqual(verdictOf({ mismatches: 25, compared: covered }), 'mismatch');
  }
});

test('an indel is a mismatch, not a partial match', () => {
  // Insertions and deletions arrive as gapped columns, which countDifferences
  // folds into `mismatches` -- so this is the same test path as a substitution
  // and must not be reachable by a read that is otherwise perfect.
  assert.strictEqual(verdictOf({ mismatches: 3, compared: 800 }), 'mismatch');
  assert.strictEqual(verdictOf({ mismatches: 3, compared: REF_LEN }), 'mismatch');
});

test('a perfect stretch too short to mean anything is a mismatch', () => {
  for (const covered of [0, 1, 20, MIN_COVERED_BP - 1]) {
    assert.strictEqual(verdictOf({ compared: covered }), 'mismatch', `covered ${covered}`);
  }
  // The floor is inclusive: exactly MIN_COVERED_BP counts.
  assert.strictEqual(verdictOf({ compared: MIN_COVERED_BP }), 'partial match');
});

test('the floor can be overridden without touching the rest of the rule', () => {
  assert.strictEqual(alignmentVerdict({ mismatches: 0, compared: 30 }, REF_LEN, 20), 'partial match');
  assert.strictEqual(alignmentVerdict({ mismatches: 0, compared: 30 }, REF_LEN, 0), 'partial match');
});

/* ------------------------------------------------------------------ edges -- */

test('a read that has not been aligned yet has no verdict', () => {
  assert.strictEqual(alignmentVerdict({ compared: 100 }, REF_LEN), null);
  assert.strictEqual(alignmentVerdict({ mismatches: null }, REF_LEN), null);
  assert.strictEqual(alignmentVerdict(null, REF_LEN), null);
});

test('a missing reference length degrades to partial rather than claiming a match', () => {
  assert.strictEqual(alignmentVerdict({ mismatches: 0, compared: 900 }, 0), 'partial match');
  assert.strictEqual(alignmentVerdict({ mismatches: 0, compared: 900 }, undefined), 'partial match');
});

/* -------------------------------------------------- against the real data -- */

test('reproduces the worked example', () => {
  // pGR-004 with the three XZ9D9W reads, plus an 800 bp window off the same
  // plasmid. These are the numbers the aligner actually produces.
  const cases = [
    [{ mismatches: 0, compared: 4489 }, 'match'],          // XZ9D9W_1
    [{ mismatches: 1, compared: 4489 }, 'mismatch'],       // XZ9D9W_2
    [{ mismatches: 2, compared: 4489 }, 'mismatch'],       // XZ9D9W_3
    [{ mismatches: 0, compared: 800 }, 'partial match']    // a Sanger window
  ];
  for (const [r, want] of cases) {
    assert.strictEqual(alignmentVerdict(r, 4489), want, JSON.stringify(r));
  }
});
