'use strict';

/*
 * Pins three fixes to the vendored ABIF reader (see patches/README.md). Every
 * one of them was a hard throw, so these tests are the difference between the
 * alignment tool reading a trace file and not opening it at all.
 *
 * The fixtures are generated, not collected -- see make-synthetic-ab1.mjs.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { ab1ToJson } = require('../../media/bioparser2.umd.js');

const fixture = (name) => path.join(__dirname, '..', 'fixtures', name);
const read = (name) => ab1ToJson(fs.readFileSync(fixture(name)), { fileName: name });

const FULL_SEQ = 'ACGTACGTAAGGCCTTACGTTGCATTAGCA';

test('reads a trace whose tags are only ever numbered 1', async () => {
  // PBAS2/PLOC2/PCON2 are the edited copies and are absent here, which is
  // normal. Asking for them and not falling back left basePos undefined.
  const [{ parsedSequence: p }] = await read('synthetic-trace.ab1');
  assert.strictEqual(p.sequence, FULL_SEQ);

  const c = p.chromatogramData;
  assert.strictEqual(c.baseCalls.length, FULL_SEQ.length);
  assert.strictEqual(c.basePos.length, FULL_SEQ.length);
  assert.strictEqual(c.qualNums.length, FULL_SEQ.length);
});

test('builds one trace per base pair, which is what the chromatogram draws', async () => {
  const [{ parsedSequence: p }] = await read('synthetic-trace.ab1');
  const { baseTraces } = p.chromatogramData;

  assert.strictEqual(baseTraces.length, FULL_SEQ.length,
    'a missing or short baseTraces renders as a blank track rather than an error');
  assert.deepStrictEqual(Object.keys(baseTraces[0]).sort(),
    ['aTrace', 'cTrace', 'gTrace', 'tTrace']);
  assert.ok(baseTraces[0].aTrace.length > 0, 'each base needs actual trace points');
});

test('the called base is the tallest channel at its own peak', () => {
  // Guards the DATA9/10/11/12 -> G/A/T/C mapping. Getting it wrong still
  // parses, still renders, and is only visible as wrongly coloured peaks.
  return read('synthetic-trace.ab1').then(([{ parsedSequence: p }]) => {
    const { baseTraces, baseCalls } = p.chromatogramData;
    const channel = { A: 'aTrace', C: 'cTrace', G: 'gTrace', T: 'tTrace' };
    for (let i = 0; i < baseCalls.length; i++) {
      const t = baseTraces[i];
      const peak = (k) => Math.max(...t[k]);
      const called = peak(channel[baseCalls[i]]);
      const others = Object.values(channel)
        .filter((k) => k !== channel[baseCalls[i]])
        .map(peak);
      assert.ok(called > Math.max(...others),
        `base ${i} (${baseCalls[i]}) is not the tallest channel — trace mapping is off`);
    }
  });
});

test('reads tags whose data is stored inline', async () => {
  // ABIF puts data of 4 bytes or fewer in the offset field itself. A 4-base
  // read makes PBAS and PCON exactly 4 bytes; dereferencing them as offsets
  // lands far outside the file and throws.
  const [{ parsedSequence: p }] = await read('synthetic-trace-tiny.ab1');
  assert.strictEqual(p.sequence, 'ACGT');
  assert.strictEqual(p.chromatogramData.qualNums.length, 4);
  assert.strictEqual(p.chromatogramData.baseTraces.length, 4);
});

test('accepts a Node Buffer, a Uint8Array and a bare ArrayBuffer', async () => {
  // The Node path used to unwrap a Buffer to its ArrayBuffer and then read
  // .length off it -- undefined -- yielding a zero-length DataView.
  const buf = fs.readFileSync(fixture('synthetic-trace.ab1'));
  const view = new Uint8Array(buf);
  const ab = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);

  for (const [label, input] of [['Buffer', buf], ['Uint8Array', view], ['ArrayBuffer', ab]]) {
    const [{ parsedSequence: p }] = await ab1ToJson(input, { fileName: 'x.ab1' });
    assert.strictEqual(p.sequence, FULL_SEQ, `${label} input did not parse`);
  }
});

test('a Buffer that is a window onto a larger pool reads only its own bytes', async () => {
  // Node pools small allocations, so buf.buffer can hold unrelated data either
  // side; ignoring byteOffset silently parses the neighbours.
  const bytes = fs.readFileSync(fixture('synthetic-trace.ab1'));
  const pool = Buffer.alloc(bytes.length + 64, 0xab);
  bytes.copy(pool, 32);
  const windowed = pool.subarray(32, 32 + bytes.length);

  const [{ parsedSequence: p }] = await ab1ToJson(windowed, { fileName: 'x.ab1' });
  assert.strictEqual(p.sequence, FULL_SEQ);
});
