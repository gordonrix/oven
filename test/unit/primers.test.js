'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { genbankToJson } = require('../../media/bioparser2.umd.js');
const { revComp, deriveBases, wrapsOrigin, normalizeSeqKey } = require('../../media/cartShared');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'synthetic-plasmid.gb');

test('revComp handles standard and degenerate bases', () => {
  assert.strictEqual(revComp('ATGC'), 'GCAT');
  assert.strictEqual(revComp('atgc'), 'GCAT');
  assert.strictEqual(revComp('ATGCN'), 'NGCAT');
  assert.strictEqual(revComp('RYKM'), 'KMRY');
  assert.strictEqual(revComp(''), '');
  assert.strictEqual(revComp('ATZ'), 'NAT'); // unknown letters degrade to N
});

test('deriveBases reads a forward span and uppercases it', () => {
  // GenBank ORIGIN blocks are lowercase; ordering needs uppercase.
  assert.strictEqual(deriveBases('aaaaccccgggg', 4, 7, 1, false), 'CCCC');
});

test('deriveBases reverse-complements a minus-strand span', () => {
  assert.strictEqual(deriveBases('aaaaccccgggg', 4, 7, -1, false), 'GGGG');
});

test('deriveBases wraps the origin on a circular sequence', () => {
  //            0123456789
  const seq = 'AAAACCCCGG';
  // 8..1 wraps: GG + AA
  assert.strictEqual(deriveBases(seq, 8, 1, 1, true), 'GGAA');
  assert.strictEqual(deriveBases(seq, 8, 1, -1, true), 'TTCC');
  assert.ok(wrapsOrigin(8, 1, true));
  assert.ok(!wrapsOrigin(8, 1, false));
  assert.ok(!wrapsOrigin(1, 8, true));
});

test('deriveBases degrades instead of throwing on unusable input', () => {
  assert.strictEqual(deriveBases('', 0, 5, 1, false), '');
  assert.strictEqual(deriveBases('ATGC', null, 2, 1, false), '');
  assert.strictEqual(deriveBases(null, 0, 2, 1, false), '');
});

test('normalizeSeqKey ignores case and whitespace', () => {
  assert.strictEqual(normalizeSeqKey(' atg c\n'), 'ATGC');
  assert.strictEqual(normalizeSeqKey('ATGC'), normalizeSeqKey('atgc'));
});

test('derived sequences match the /Sequence qualifier in a real plasmid', () => {
  // The strongest oracle available: where a file states the primer sequence
  // outright, our coordinate-and-strand reconstruction must agree with it.
  const parsed = genbankToJson(fs.readFileSync(FIXTURE, 'utf8'))[0].parsedSequence;
  const primers = parsed.primers || [];
  assert.ok(primers.length >= 3, 'fixture should contain primers');

  let checked = 0;
  for (const p of primers) {
    const stated = p.notes && p.notes.Sequence && p.notes.Sequence[0];
    if (!stated) continue;
    checked++;
    const derived = deriveBases(parsed.sequence, p.start, p.end, p.strand, parsed.circular);
    assert.strictEqual(derived, String(stated).trim().toUpperCase(), `mismatch for ${p.name}`);
  }
  assert.ok(checked >= 2, `expected at least 2 primers with /Sequence, saw ${checked}`);
});

test('parsed primers expose strand, not forward', () => {
  // Guards the shape this code depends on: bio-parsers emits strand: 1 | -1
  // and no `forward` key, so keying off `forward` would silently treat every
  // reverse primer as forward.
  const parsed = genbankToJson(fs.readFileSync(FIXTURE, 'utf8'))[0].parsedSequence;
  for (const p of parsed.primers || []) {
    assert.ok(p.strand === 1 || p.strand === -1, `unexpected strand ${p.strand}`);
    assert.strictEqual(p.forward, undefined);
    assert.strictEqual(typeof p.start, 'number');
    assert.strictEqual(typeof p.end, 'number');
  }
});
