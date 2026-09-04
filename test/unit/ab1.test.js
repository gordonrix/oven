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

/* --- per-base trace windows ---------------------------------------------- */

const { convertBasePosTraceToPerBpTrace } = require('../../media/bioparser2.umd.js');

/*
 * A base's window has to be the stretch of trace closer to its own peak than to
 * either neighbour's, or the drawn chromatogram does not line up with the
 * letters under it.
 *
 * Upstream walked the trace with a running cursor and a fixed +3 fudge at every
 * step. On a real 1672 bp read that put the peak belonging to a base outside
 * its own window for 1670 of them -- the whole trace drawn about a base to the
 * right -- and gave the final base everything the sequencer recorded after the
 * last call, which is what bunched the end of a PCR read into one cell.
 */

/** A synthetic trace: a spike at every peak position, flat between. */
function traceWith(peaks, length, spikeAt) {
  const flat = new Array(length).fill(10);
  for (const p of peaks) if (spikeAt(p)) flat[p] = 1000;
  return flat;
}

const PEAKS = [4, 8, 12, 16, 20, 24];

function synthetic({ trailing = 0 } = {}) {
  const length = PEAKS[PEAKS.length - 1] + 1 + trailing;
  return {
    basePos: PEAKS,
    baseCalls: ['A', 'A', 'A', 'A', 'A', 'A'],
    aTrace: traceWith(PEAKS, length, () => true),
    tTrace: new Array(length).fill(0),
    gTrace: new Array(length).fill(0),
    cTrace: new Array(length).fill(0)
  };
}

test('every peak sits inside its own base window', () => {
  const { baseTraces } = convertBasePosTraceToPerBpTrace(synthetic());
  assert.strictEqual(baseTraces.length, PEAKS.length);
  baseTraces.forEach((bp, i) => {
    const peak = Math.max(...bp.aTrace);
    assert.strictEqual(peak, 1000, `base ${i} has no peak in its window`);
    // And exactly one, so it has not borrowed a neighbour's.
    assert.strictEqual(bp.aTrace.filter((v) => v === 1000).length, 1,
      `base ${i} window holds more than one peak`);
  });
});

test('the peak is centred in its window, not at an edge', () => {
  const { baseTraces } = convertBasePosTraceToPerBpTrace(synthetic());
  // Ends excluded: they have only one neighbour to take a midpoint against.
  baseTraces.slice(1, -1).forEach((bp, i) => {
    const at = bp.aTrace.indexOf(1000) / (bp.aTrace.length - 1);
    assert.ok(at > 0.2 && at < 0.8, `base ${i + 1} peak sits at ${at.toFixed(2)} of its window`);
  });
});

test('trace recorded after the last base call is not dumped into it', () => {
  // A PCR product often leaves a long tail after the final call. Stock gave the
  // last base everything to the end of the trace.
  const withTail = convertBasePosTraceToPerBpTrace(synthetic({ trailing: 400 }));
  const widths = withTail.baseTraces.map((b) => b.aTrace.length);
  const last = widths[widths.length - 1];

  // The last window is half a peak spacing, like any other -- not the 400
  // samples of tail. Stock made it the whole remainder of the trace.
  assert.ok(last <= 6, `the last window swallowed the tail: ${last} samples`);
  assert.ok(Math.max(...widths) <= Math.min(...widths) + 2,
    `windows should be even, got ${widths.join(',')}`);
  // And the tail is genuinely dropped rather than hidden somewhere else.
  const total = widths.reduce((a, b) => a + b, 0);
  assert.ok(total < 40, `windows cover ${total} samples, far more than the called bases`);
});
