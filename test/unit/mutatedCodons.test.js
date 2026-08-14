'use strict';

/*
 * Finding the codon a substitution falls in, so the viewer can show what the
 * mutation codes for.
 *
 * The output is in READ coordinates and is handed to OVE as a translation, so
 * OVE derives the amino acid from the read's own bases. That means a wrong
 * codon boundary does not error -- it quietly displays the wrong amino acid,
 * which is why the frame cases are worth pinning individually.
 */

const test = require('node:test');
const assert = require('node:assert');

const { mutatedCodons, codonPositions } = require('../../src/align');

const cds = (over) => Object.assign({ id: 'c1', name: 'orf', type: 'CDS', strand: 1 }, over);

/* ------------------------------------------------------------ codon frame -- */

test('reading frame runs from the start of a forward CDS', () => {
  const f = cds({ start: 10, end: 30 });
  assert.deepStrictEqual(codonPositions(f, 10, 100), [10, 11, 12]);
  assert.deepStrictEqual(codonPositions(f, 12, 100), [10, 11, 12]);
  assert.deepStrictEqual(codonPositions(f, 13, 100), [13, 14, 15]);
});

test('reading frame runs from the end of a reverse CDS', () => {
  // Counting from the wrong end silently shifts every codon by one or two
  // bases, which reports a plausible but wrong amino acid.
  const f = cds({ start: 10, end: 30, strand: -1 });
  assert.deepStrictEqual(codonPositions(f, 30, 100), [28, 29, 30]);
  assert.deepStrictEqual(codonPositions(f, 28, 100), [28, 29, 30]);
  assert.deepStrictEqual(codonPositions(f, 27, 100), [25, 26, 27]);
});

test('a CDS across the origin keeps its frame', () => {
  const f = cds({ start: 98, end: 10 }); // wraps a 100 bp reference
  assert.deepStrictEqual(codonPositions(f, 98, 100), [0, 98, 99]);
  assert.deepStrictEqual(codonPositions(f, 1, 100), [1, 2, 3]);
});

/* ----------------------------------------------------------- the mapping -- */

const REF = 'ATGGCCTTAGGGCCCAAATTTGGGCCCATGATG'; // 33 bp
const sub = (s, i, base) => s.slice(0, i) + base + s.slice(i + 1);

test('a substitution in a CDS yields its codon in read coordinates', () => {
  const read = sub(REF, 7, 'A'); // position 7 -> codon 6..8
  const out = mutatedCodons(REF, read, [cds({ start: 0, end: 32 })], REF.length);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(
    { start: out[0].start, end: out[0].end, forward: out[0].forward },
    { start: 6, end: 8, forward: true });
  assert.deepStrictEqual(out[0].referencePositions, [6, 7, 8]);
});

test('two substitutions in one codon report it once', () => {
  const read = sub(sub(REF, 6, 'A'), 8, 'A');
  const out = mutatedCodons(REF, read, [cds({ start: 0, end: 32 })], REF.length);
  assert.strictEqual(out.length, 1, 'one codon, one translation');
});

test('substitutions in different codons are reported separately', () => {
  const read = sub(sub(REF, 1, 'C'), 20, 'A');
  const out = mutatedCodons(REF, read, [cds({ start: 0, end: 32 })], REF.length);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out.map((c) => c.start).sort((a, b) => a - b), [0, 18]);
});

test('a substitution outside any CDS is ignored', () => {
  const read = sub(REF, 30, 'A');
  assert.deepStrictEqual(mutatedCodons(REF, read, [cds({ start: 0, end: 20 })], REF.length), []);
  assert.deepStrictEqual(mutatedCodons(REF, read, [], REF.length), []);
});

test('a non-CDS feature does not produce translations', () => {
  const read = sub(REF, 7, 'A');
  const promoter = cds({ type: 'promoter', start: 0, end: 32 });
  assert.deepStrictEqual(mutatedCodons(REF, read, [promoter], REF.length), []);
});

/* ------------------------------------------------------------ gapped rows -- */

test('read coordinates account for gaps earlier in the read', () => {
  // The read is missing three bases up front, so every later read position is
  // three behind its reference position. Using reference coordinates directly
  // would put the translation in the wrong place.
  const refRow = REF;
  const readRow = '---' + sub(REF.slice(3), 4, 'A'); // reference position 7
  const out = mutatedCodons(refRow, readRow, [cds({ start: 0, end: 32 })], REF.length);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0].referencePositions, [6, 7, 8]);
  assert.deepStrictEqual({ start: out[0].start, end: out[0].end }, { start: 3, end: 5 });
});

test('a codon broken by an indel is skipped rather than guessed', () => {
  // One base of the codon is missing from the read, so there is no triplet to
  // translate; inventing one would report an amino acid that does not exist.
  const refRow = 'ATGGCCTTAGGG';
  const readRow = 'ATGGC-TTCGGG'; // gap at 5, substitution at 8
  const out = mutatedCodons(refRow, readRow, [cds({ start: 0, end: 11 })], 12);
  assert.deepStrictEqual(out.map((c) => c.referencePositions), [[6, 7, 8]],
    'the intact codon is still reported; the broken one is not');
});

test('a reverse CDS reports the codon with its own strand', () => {
  const read = sub(REF, 7, 'A');
  const out = mutatedCodons(REF, read, [cds({ start: 0, end: 32, strand: -1 })], REF.length);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].strand, -1);
  assert.strictEqual(out[0].forward, false);
  // Counting back from 32: 32,31,30 | 29,28,27 | ... | 8,7,6
  assert.deepStrictEqual(out[0].referencePositions, [6, 7, 8]);
});

test('an identical read produces nothing', () => {
  assert.deepStrictEqual(mutatedCodons(REF, REF, [cds({ start: 0, end: 32 })], REF.length), []);
});
