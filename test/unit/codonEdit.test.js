'use strict';

/*
 * The codon arithmetic behind Change Amino Acid.
 *
 * These are the cases where a wrong answer is not a crash but a plausible,
 * silently corrupt sequence: a reverse-strand CDS, and a codon straddling the
 * origin of a circular plasmid.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  codonAt, applyCodon, codonPositions, basesAt, caseFromFlanks
} = require('../../media/codonEdit');
const { revComp } = require('../../media/cartShared');

/** A translation shaped like the one OVE hands a right-click. */
const translation = (forward, ranges) => ({
  forward,
  strand: forward ? 1 : -1,
  aminoAcids: ranges.map((range, i) => ({
    aminoAcidIndex: i, positionInCodon: 0, codonRange: range, aminoAcid: { value: '?' }
  }))
});

/* ------------------------------------------------------------- forward -- */

test('a forward codon is read straight off the top strand', () => {
  //             0123456789
  const seq = 'AAAGCGTTTCCC';
  const t = translation(true, [{ start: 3, end: 5 }]);
  const at = codonAt(seq, t, 0);
  assert.equal(at.stored, 'GCG');
  assert.equal(at.codon, 'GCG', 'what is shown is what is stored');
  assert.equal(at.forward, true);
});

test('writing a forward codon changes exactly those three bases', () => {
  const seq = 'AAAGCGTTTCCC';
  const at = codonAt(seq, translation(true, [{ start: 3, end: 5 }]), 0);
  const out = applyCodon(seq, at, 'TTA');
  // Lower case because the bases it replaced were upper -- see below.
  assert.equal(out, 'AAAttaTTTCCC');
  assert.equal(out.length, seq.length);
});

/* ----------------------------------------------------------------- case -- */

/*
 * An edited codon is written in whichever case stands out from its neighbours,
 * so it can be found in the sequence afterwards. Nothing downstream reads case,
 * and every comparison here upper-cases first, so this is purely a marker.
 *
 * The case comes from the codons either side, not from the bases being
 * replaced. Flipping a codon's own case works until two adjacent codons are
 * both edited -- the second flips relative to the first and the pair ends up in
 * opposite cases, with neither reading as the edit.
 */

test('an edit is written opposite to the case around it', () => {
  const upper = 'AAAAAAGCGTTTTTT';
  const lower = 'aaaaaagcgtttttt';
  const t = translation(true, [{ start: 6, end: 8 }]);
  assert.equal(applyCodon(upper, codonAt(upper, t, 0), 'TTA'), 'AAAAAAttaTTTTTT');
  assert.equal(applyCodon(lower, codonAt(lower, t, 0), 'TTA'), 'aaaaaaTTAtttttt');
});

test('the whole codon takes one case, not one per base', () => {
  const seq = 'AAAAAAGcGTTTTTT';
  const out = applyCodon(seq, codonAt(seq, translation(true, [{ start: 6, end: 8 }]), 0), 'TTA');
  assert.equal(out, 'AAAAAAttaTTTTTT', 'the case being replaced does not carry through');
});

test('neighbours that disagree fall back to upper case', () => {
  //           0..5 lower, 9..14 upper -- no majority either way
  const seq = 'aaaaaaGCGTTTTTT';
  const out = applyCodon(seq, codonAt(seq, translation(true, [{ start: 6, end: 8 }]), 0), 'TTA');
  assert.equal(out, 'aaaaaaTTATTTTTT');
});

test('two codons edited in a row do not both go lower', () => {
  const seq = 'AAAAAAGCGGCGTTTTTT';
  const t = translation(true, [{ start: 6, end: 8 }, { start: 9, end: 11 }]);

  const once = applyCodon(seq, codonAt(seq, t, 0), 'TTA');
  assert.equal(once, 'AAAAAAttaGCGTTTTTT');

  // The second codon now has a lower-case neighbour on one side and an upper
  // one on the other, so it takes upper rather than matching the first.
  const twice = applyCodon(once, codonAt(once, t, 1), 'CCA');
  assert.equal(twice, 'AAAAAAttaCCATTTTTT');
});

test('an edit at the very start goes on its one neighbour', () => {
  const seq = 'GCGTTTTTT';
  const out = applyCodon(seq, codonAt(seq, translation(true, [{ start: 0, end: 2 }]), 0), 'TTA');
  assert.equal(out, 'ttaTTTTTT', 'one-sided evidence is still evidence');
});

test('a sequence with no case either side comes out upper', () => {
  // Characters with no case at all, unlike N -- which is a perfectly good
  // upper-case base and counts as evidence.
  assert.equal(caseFromFlanks('---GCG---', [3, 4, 5]), 'upper');
  assert.equal(caseFromFlanks('GCG', [0, 1, 2]), 'upper', 'nothing to go on');
  assert.equal(caseFromFlanks('NNNGCGNNN', [3, 4, 5]), 'lower', 'N is upper case');
});

test('case does not disturb what the codon is read as', () => {
  const seq = 'AAAgcgTTT';
  assert.equal(codonAt(seq, translation(true, [{ start: 3, end: 5 }]), 0).codon, 'GCG');
  // And on the reverse strand the complement is still taken correctly.
  assert.equal(codonAt(seq, translation(false, [{ start: 3, end: 5 }]), 0).codon, 'CGC');
});

/* ------------------------------------------------------------- reverse -- */

test('a reverse codon is shown as the reverse complement of what is stored', () => {
  const seq = 'AAAGCGTTTCCC';
  const at = codonAt(seq, translation(false, [{ start: 3, end: 5 }]), 0);
  assert.equal(at.stored, 'GCG');
  // Read on the bottom strand, GCG is CGC -- which is what the translation
  // shows, and so what the dialog must offer alternatives to.
  assert.equal(at.codon, 'CGC');
});

test('a codon chosen on a reverse CDS is complemented before it is written', () => {
  const seq = 'AAAGCGTTTCCC';
  const at = codonAt(seq, translation(false, [{ start: 3, end: 5 }]), 0);
  const out = applyCodon(seq, at, 'CGT');       // picked in reading orientation
  assert.equal(out, 'AAAacgTTTCCC');            // stored as revComp('CGT')
  assert.equal(out.slice(3, 6).toUpperCase(), revComp('CGT'));

  // And the round trip holds: reading it back gives what was picked.
  assert.equal(codonAt(out, translation(false, [{ start: 3, end: 5 }]), 0).codon, 'CGT');
});

test('only the codon changes, on either strand', () => {
  const seq = 'AAAGCGTTTCCC';
  for (const forward of [true, false]) {
    const at = codonAt(seq, translation(forward, [{ start: 3, end: 5 }]), 0);
    const out = applyCodon(seq, at, 'TTA');
    assert.equal(out.slice(0, 3), seq.slice(0, 3));
    assert.equal(out.slice(6), seq.slice(6));
  }
});

/* -------------------------------------------------------------- origin -- */

test('a codon straddling the origin covers the right three positions', () => {
  const seq = 'GCGTTTCCCAA'; // 11 bases; the codon runs 9, 10, 0
  assert.deepStrictEqual(codonPositions({ start: 9, end: 0 }, seq.length), [9, 10, 0]);
  assert.equal(basesAt(seq, { start: 9, end: 0 }), 'AAG');
});

test('writing across the origin lands on both sides of it', () => {
  const seq = 'GCGTTTCCCAA';
  const at = codonAt(seq, translation(true, [{ start: 9, end: 0 }]), 0);
  assert.equal(at.codon, 'AAG');
  const out = applyCodon(seq, at, 'TCA');
  assert.equal(out.length, seq.length);
  assert.equal(out[9], 't');
  assert.equal(out[10], 'c');
  assert.equal(out[0], 'a');
  assert.equal(out.slice(1, 9), seq.slice(1, 9), 'the middle is untouched');
});

test('a wrapping reverse codon round-trips too', () => {
  const seq = 'GCGTTTCCCAA';
  const t = translation(false, [{ start: 9, end: 0 }]);
  const out = applyCodon(seq, codonAt(seq, t, 0), 'GGA');
  assert.equal(codonAt(out, t, 0).codon, 'GGA');
  assert.equal(out.length, seq.length);
});

/* ------------------------------------------------------------- refusals -- */

test('nothing is written for an index that is not in the translation', () => {
  const seq = 'AAAGCGTTTCCC';
  assert.equal(codonAt(seq, translation(true, [{ start: 3, end: 5 }]), 7), null);
});

test('a codon that is not three bases is refused rather than half-applied', () => {
  const seq = 'AAAGCGTTTCCC';
  const at = codonAt(seq, translation(true, [{ start: 3, end: 5 }]), 0);
  assert.equal(applyCodon(seq, at, 'TT'), seq);
  assert.equal(applyCodon(seq, at, ''), seq);
  assert.equal(applyCodon(seq, null, 'TTA'), seq);
});

test('U is accepted as T, so an RNA-style codon is not written literally', () => {
  const seq = 'AAAGCGTTTCCC';
  const at = codonAt(seq, translation(true, [{ start: 3, end: 5 }]), 0);
  assert.equal(applyCodon(seq, at, 'UUA'), 'AAAttaTTTCCC');
});
