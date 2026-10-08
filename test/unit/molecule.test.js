'use strict';

/*
 * Telling DNA from protein, and what a protein's verdict says.
 *
 * guessMolecule has to agree with the sequence parser exactly. A sequence typed
 * into the panel is classified by guessMolecule, the same sequence read from a
 * file by the parser, and if the two disagreed the same letters would be
 * accepted one way and refused the other.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  guessMolecule, alignmentVerdict, identityLabel, MIN_COVERED_AA, MIN_COVERED_BP
} = require('../../media/cartShared');
const { parseOptions } = require('../../src/alignTracks');
const { fastaToJson } = require('../../media/bioparser2.umd.js');

const parserSays = (seq) => {
  const parsed = fastaToJson(`>x\n${seq}\n`, parseOptions('x.fasta'))[0].parsedSequence;
  return parsed.isProtein ? 'protein' : 'dna';
};

test('guessMolecule agrees with the parser, edge ratios included', () => {
  const cases = [
    'ACGTACGTACGT',
    'MKEFILPQWYHRDNSTVGAC',
    'ACGTNNNNNNACGT',                          // ambiguity codes count as DNA
    'ACGTRYSWKMBDHVN',
    `${'A'.repeat(91)}${'E'.repeat(9)}`,       // 91% DNA letters: DNA
    `${'A'.repeat(90)}${'E'.repeat(10)}`,      // exactly 90%: not over, so protein
    `${'A'.repeat(89)}${'E'.repeat(11)}`,
    'GATTACAGATTACA',
    'MSTRPEELFKQIGNWDHLAV',
    'ACGTACGTACGTACGTACGTACGTXACGT'           // one X in 29: still DNA
  ];
  for (const seq of cases) {
    assert.strictEqual(guessMolecule(seq), parserSays(seq), `disagree on ${seq.slice(0, 24)}`);
  }
});

test('an empty sequence is DNA, as everything was before proteins', () => {
  assert.strictEqual(guessMolecule(''), 'dna');
});

test('the protein floor holds a protein to the same odds as DNA', () => {
  // 50 bases at 2 bits each against 24 residues at log2(20) = 4.32 bits.
  assert.ok(MIN_COVERED_AA * Math.log2(20) >= MIN_COVERED_BP * 2);
  assert.ok((MIN_COVERED_AA - 1) * Math.log2(20) < MIN_COVERED_BP * 2);

  const read = (compared) => ({ mismatches: 0, compared });
  assert.strictEqual(alignmentVerdict(read(23), 500, MIN_COVERED_AA), 'mismatch');
  assert.strictEqual(alignmentVerdict(read(24), 500, MIN_COVERED_AA), 'partial match');
  assert.strictEqual(alignmentVerdict(read(500), 500, MIN_COVERED_AA), 'match');
});

test('the identity label counts gaps against a protein', () => {
  assert.strictEqual(identityLabel({ compared: 186, substitutions: 2, gaps: 0 }), '98.9% identical');
  // 183 of 186 columns, with three residues missing: not 100%.
  assert.strictEqual(identityLabel({ compared: 183, substitutions: 0, gaps: 3 }), '98.3% identical');
});

test('a protein that differs at all is never shown as 100%', () => {
  // 1 in 10,000 would round to 100.0; rounding down keeps it at 99.9.
  assert.strictEqual(identityLabel({ compared: 10000, substitutions: 1, gaps: 0 }), '99.9% identical');
  assert.strictEqual(identityLabel({ compared: 10000, substitutions: 0, gaps: 1 }), '99.9% identical');
});

test('an unaligned read has no identity to label', () => {
  assert.strictEqual(identityLabel({}), '');
  assert.strictEqual(identityLabel(null), '');
});
