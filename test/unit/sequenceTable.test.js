'use strict';

/*
 * Pasting a table of sequences into the alignment panel. Each case is a shape
 * people actually copy: a block of spreadsheet rows, a CSV, FASTA, a GenBank
 * ORIGIN block. The thing to get right is telling a table of many sequences
 * from one sequence that happens to span lines.
 */

const test = require('node:test');
const assert = require('node:assert');

const { parseSequenceTable } = require('../../media/cartShared');

const T7 = 'TAATACGACTCACTATAGGG';
const SP6 = 'ATTTAGGTGACACTATAGAA';

test('rows copied from a spreadsheet', () => {
  assert.deepStrictEqual(parseSequenceTable(`T7\t${T7}\nSP6\t${SP6}\n`), [
    { name: 'T7', sequence: T7 }, { name: 'SP6', sequence: SP6 }
  ]);
});

test('a header row is dropped', () => {
  assert.deepStrictEqual(parseSequenceTable(`Name\tSequence\nT7\t${T7}`), [{ name: 'T7', sequence: T7 }]);
  assert.deepStrictEqual(parseSequenceTable(`primer\tbases\nT7\t${T7}`), [{ name: 'T7', sequence: T7 }]);
});

test('the sequence column is found whichever side it is on', () => {
  assert.deepStrictEqual(parseSequenceTable(`${T7}\tT7\n${SP6}\tSP6`), [
    { name: 'T7', sequence: T7 }, { name: 'SP6', sequence: SP6 }
  ]);
});

test('extra spreadsheet columns are ignored', () => {
  const rows = `ID\tName\tSequence\tLength\n1\tT7\t${T7}\t20\n2\tSP6\t${SP6}\t20`;
  // A row number is not a name: the Name column is used, not the ID.
  assert.deepStrictEqual(parseSequenceTable(rows), [
    { name: 'T7', sequence: T7 }, { name: 'SP6', sequence: SP6 }
  ]);
});

test('a short name made of residue letters is not taken for the sequence', () => {
  // LacI is all valid one-letter amino-acid codes; the longer column wins.
  assert.deepStrictEqual(parseSequenceTable(`LacI\t${T7}`), [{ name: 'LacI', sequence: T7 }]);
});

test('a CSV, quoted names included', () => {
  assert.deepStrictEqual(parseSequenceTable(`"T7, forward",${T7}\nSP6,${SP6}`), [
    { name: 'T7, forward', sequence: T7 }, { name: 'SP6', sequence: SP6 }
  ]);
});

test('FASTA, wrapped records included', () => {
  assert.deepStrictEqual(parseSequenceTable(`>T7 promoter\n${T7.slice(0, 10)}\n${T7.slice(10)}\n>SP6\n${SP6}`), [
    { name: 'T7 promoter', sequence: T7 }, { name: 'SP6', sequence: SP6 }
  ]);
});

test('"name sequence" lines', () => {
  assert.deepStrictEqual(parseSequenceTable(`T7 ${T7}\nSP6 ${SP6}`), [
    { name: 'T7', sequence: T7 }, { name: 'SP6', sequence: SP6 }
  ]);
});

test('a numbered GenBank block is one sequence', () => {
  const block = '        1 acgtacgtac gtacgtacgt acgtacgtac\n       31 ggccggccgg\n';
  const got = parseSequenceTable(block);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].sequence.replace(/[\s\d]/g, ''), 'acgtacgtacgtacgtacgtacgtacgtacggccggccgg');
});

test('one sequence wrapped at a fixed width is one sequence', () => {
  const seq = 'ACGT'.repeat(40);
  const got = parseSequenceTable(`${seq.slice(0, 60)}\n${seq.slice(60, 120)}\n${seq.slice(120)}`);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].sequence.replace(/\s/g, ''), seq);
});

test('a column of sequences without names', () => {
  assert.deepStrictEqual(parseSequenceTable(`${T7}\n${SP6}`), [
    { name: '', sequence: T7 }, { name: '', sequence: SP6 }
  ]);
});

test('blank lines and Windows line endings are harmless', () => {
  assert.deepStrictEqual(parseSequenceTable(`T7\t${T7}\r\n\r\nSP6\t${SP6}\r\n`), [
    { name: 'T7', sequence: T7 }, { name: 'SP6', sequence: SP6 }
  ]);
  assert.deepStrictEqual(parseSequenceTable('  \n'), []);
});
