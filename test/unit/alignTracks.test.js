'use strict';

/*
 * Parsing reads, trimming them, and keeping a chromatogram in step with the
 * transforms the aligner applies to its sequence. The last of these is the one
 * with no visible failure mode: a trace that is reversed but not re-channelled,
 * or rotated by the wrong amount, still renders -- it just quietly disagrees
 * with the letters underneath it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  parseFile, isSupported, trimByQuality, qualitySpan,
  smoothChromatogram, SMOOTH_TARGET,
  reverseComplementChromatogram, rotateChromatogram, followAlignment
, followAlignmentAnnotations
} = require('../../src/alignTracks');
const { revComp } = require('../../media/cartShared');

const fixture = (n) => path.join(__dirname, '..', 'fixtures', n);

/* ---------------------------------------------------------------- parsing -- */

test('recognises the formats the picker offers and rejects others', () => {
  for (const ok of ['a.ab1', 'b.gb', 'c.gbk', 'd.fa', 'e.fasta', 'F.AB1']) {
    assert.ok(isSupported(ok), ok);
  }
  for (const no of ['notes.txt', 'sheet.xlsx', 'noext', 'a.ab']) {
    assert.ok(!isSupported(no), no);
  }
});

test('parses an ab1 into a track carrying its trace', async () => {
  const [track] = await parseFile(fs.readFileSync(fixture('synthetic-trace.ab1')), 'synthetic-trace.ab1');
  assert.strictEqual(track.name, 'synthetic-trace');
  assert.strictEqual(track.sequence, 'ACGTACGTAAGGCCTTACGTTGCATTAGCA');
  assert.strictEqual(track.chromatogramData.baseTraces.length, track.sequence.length);
});

test('a multi-record FASTA becomes several tracks, not just the first', async () => {
  const fa = '>alpha\nACGTACGTAA\n>beta\nTTTTGGGGCC\n>gamma\nAAAACCCCGG\n';
  const tracks = await parseFile(fa, 'reads.fasta');
  assert.strictEqual(tracks.length, 3);
  assert.deepStrictEqual(tracks.map((t) => t.sequence),
    ['ACGTACGTAA', 'TTTTGGGGCC', 'AAAACCCCGG']);
  // The record name has to survive, or three tracks all read "reads".
  assert.ok(tracks.every((t) => t.name.startsWith('reads · ')), tracks.map((t) => t.name).join());
});

test('a single-record file keeps the filename the user recognises', async () => {
  const [track] = await parseFile('>ignored\nACGTACGTAA\n', 'my-read.fasta');
  assert.strictEqual(track.name, 'my-read');
});

test('a GenBank read parses with no chromatogram, so it draws no trace', async () => {
  const gb = fs.readFileSync(fixture('synthetic-plasmid.gb'), 'utf8');
  const [track] = await parseFile(gb, 'synthetic-plasmid.gb');
  assert.strictEqual(track.chromatogramData, null);
  assert.ok(track.sequence.length > 1000);
  assert.strictEqual(track.circular, true);
});

/* --------------------------------------------------------------- trimming -- */

const chrom = (seq, qual) => ({
  baseCalls: seq.split(''),
  qualNums: qual,
  baseTraces: seq.split('').map((b) => ({
    aTrace: [b === 'A' ? 9 : 1], tTrace: [b === 'T' ? 9 : 1],
    gTrace: [b === 'G' ? 9 : 1], cTrace: [b === 'C' ? 9 : 1]
  }))
});

test('finds the usable span and ignores a lone good base in the noise', () => {
  const qual = [...Array(10).fill(5), 50, ...Array(5).fill(5), ...Array(40).fill(50), ...Array(10).fill(5)];
  const span = qualitySpan(qual, 20);
  assert.ok(span.start >= 16, `trimming stopped early at ${span.start}, on a single good base`);
  assert.ok(span.end <= 55);
});

test('trimming cuts sequence, quality and trace by the same amount', () => {
  const seq = 'ACGT'.repeat(15); // 60
  const qual = [...Array(10).fill(2), ...Array(40).fill(50), ...Array(10).fill(2)];
  const track = { name: 't', sequence: seq, chromatogramData: chrom(seq, qual) };

  const out = trimByQuality(track, 20);
  const c = out.chromatogramData;
  assert.ok(out.sequence.length < seq.length, 'nothing was trimmed');
  assert.strictEqual(c.baseTraces.length, out.sequence.length);
  assert.strictEqual(c.qualNums.length, out.sequence.length);
  assert.strictEqual(c.baseCalls.length, out.sequence.length);
  assert.strictEqual(c.baseCalls.join(''), out.sequence, 'bases and trace drifted apart');
});

test('a read with no quality data, or trimming off, is left alone', () => {
  const track = { name: 't', sequence: 'ACGTACGT', chromatogramData: null };
  assert.strictEqual(trimByQuality(track, 20), track);

  const seq = 'ACGT'.repeat(10);
  const withChrom = { name: 't', sequence: seq, chromatogramData: chrom(seq, Array(40).fill(50)) };
  assert.strictEqual(trimByQuality(withChrom, 0), withChrom, 'threshold 0 must disable trimming');
});

test('a uniformly bad read is kept rather than trimmed to nothing', () => {
  const seq = 'ACGT'.repeat(10);
  const track = { name: 't', sequence: seq, chromatogramData: chrom(seq, Array(40).fill(2)) };
  assert.strictEqual(trimByQuality(track, 20).sequence, seq);
});

/* ------------------------------------------------------ trace transforms -- */

test('reverse-complementing swaps the channels, not just the order', () => {
  // The silent failure: reverse the array but leave A where T should be, and
  // every peak is drawn in the wrong colour under a correct-looking base.
  const seq = 'AACCGGTT';
  const out = reverseComplementChromatogram(chrom(seq, Array(8).fill(40)));

  assert.strictEqual(out.baseCalls.join(''), revComp(seq));
  for (let i = 0; i < seq.length; i++) {
    const base = out.baseCalls[i];
    const channel = { A: 'aTrace', C: 'cTrace', G: 'gTrace', T: 'tTrace' }[base];
    assert.strictEqual(Math.max(...out.baseTraces[i][channel]), 9,
      `base ${i} (${base}) has no peak in its own channel`);
  }
});

test('reverse-complementing twice returns the original', () => {
  const seq = 'ACGTTGCA';
  const original = chrom(seq, [1, 2, 3, 4, 5, 6, 7, 8]);
  const back = reverseComplementChromatogram(reverseComplementChromatogram(original));
  assert.deepStrictEqual(back.baseCalls, original.baseCalls);
  assert.deepStrictEqual(back.qualNums, original.qualNums);
  assert.deepStrictEqual(back.baseTraces, original.baseTraces);
});

test('rotating moves bases, quality and trace together', () => {
  const seq = 'ACGTACGTAA';
  const out = rotateChromatogram(chrom(seq, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 3);
  assert.strictEqual(out.baseCalls.join(''), 'TACGTAAACG');
  assert.deepStrictEqual(out.qualNums, [3, 4, 5, 6, 7, 8, 9, 0, 1, 2]);
  assert.strictEqual(out.baseTraces.length, seq.length);
  assert.strictEqual(Math.max(...out.baseTraces[0].tTrace), 9, 'the trace did not move with the bases');
});

test('rotating by a full turn, or by zero, changes nothing', () => {
  const seq = 'ACGTACGTAA';
  const original = chrom(seq, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.strictEqual(rotateChromatogram(original, 0), original);
  assert.deepStrictEqual(rotateChromatogram(original, seq.length).baseCalls, original.baseCalls);
});

test('followAlignment applies the flip before the rotation, as the aligner does', () => {
  // Order matters: the rotation was measured on the already-oriented read, so
  // rotating first would land somewhere else entirely.
  const seq = 'AACCGGTTAC';
  const original = chrom(seq, Array(10).fill(40));
  const out = followAlignment(original, { strand: -1, rotation: 4 });

  const expected = rotateChromatogram(reverseComplementChromatogram(original), 4);
  assert.deepStrictEqual(out.baseCalls, expected.baseCalls);
  assert.strictEqual(out.baseCalls.join(''),
    revComp(seq).slice(4) + revComp(seq).slice(0, 4));
});

test('a track with no trace survives the whole transform', () => {
  assert.strictEqual(followAlignment(null, { strand: -1, rotation: 5 }), null);
});

test('coarse traces are smoothed, dense ones are left alone', () => {
  const bp = (pts) => ({ aTrace: pts, tTrace: pts, gTrace: pts, cTrace: pts });
  // Four samples per base with square shoulders: too coarse to draw as a peak.
  const coarse = { baseTraces: Array.from({ length: 20 }, () => bp([0, 900, 900, 0])) };
  const out = smoothChromatogram(coarse);
  assert.equal(out.baseTraces[0].aTrace.length, SMOOTH_TARGET);
  assert.equal(out.smoothedFrom, 4);
  // Interpolation must not invent signal above what the file actually contains.
  assert.ok(Math.max(...out.baseTraces[0].aTrace) <= 900);
  assert.equal(out.baseTraces[0].aTrace[0], 0);

  const dense = { baseTraces: Array.from({ length: 20 }, () => bp(new Array(12).fill(500))) };
  assert.equal(smoothChromatogram(dense), dense, 'a dense trace is returned untouched');
});

/* --- a read's own annotations, moved to match the row -------------------- */

test('a query annotation follows the read when it is flipped', () => {
  /*
   * A GenBank read brings features in its own coordinates. The row draws the
   * read reverse-complemented when it aligned that way, so a feature handed
   * over untransformed lands somewhere else entirely -- which is worse than not
   * drawing it: wrong, and confident.
   */
  const moved = followAlignmentAnnotations(
    { features: [{ id: 'f', name: 'gene', start: 10, end: 19, strand: 1, forward: true }] },
    { strand: -1, readIndex: null, length: 100 }
  );
  assert.strictEqual(moved.features.length, 1);
  // 10..19 of 100 counts back to 80..89, and the strand turns over with it.
  assert.deepStrictEqual(
    [moved.features[0].start, moved.features[0].end, moved.features[0].forward],
    [80, 89, false]
  );
});

test('a forward read keeps its annotations where they were', () => {
  const moved = followAlignmentAnnotations(
    { features: [{ id: 'f', name: 'gene', start: 10, end: 19, forward: true }] },
    { strand: 1, readIndex: null, length: 100 }
  );
  assert.deepStrictEqual(
    [moved.features[0].start, moved.features[0].end, moved.features[0].forward],
    [10, 19, true]
  );
});

test('a folded read splits an annotation the row splits', () => {
  /*
   * A read folded across the origin is handed over in column order, so bases
   * contiguous in the read need not be contiguous in the row. An annotation
   * spanning the join has to come back as two pieces, or it would be drawn as
   * one band straight across the middle of the plasmid.
   *
   * readIndex here says the row's first 10 columns are read bases 10-19 and
   * the next 10 are read bases 0-9 -- the shape a fold produces.
   */
  const readIndex = [];
  for (let i = 10; i < 20; i++) readIndex.push(i);
  for (let i = 0; i < 10; i++) readIndex.push(i);

  const moved = followAlignmentAnnotations(
    { features: [{ id: 'f', name: 'spans', start: 5, end: 14, forward: true }] },
    { strand: 1, readIndex, length: 20 }
  );
  const ranges = moved.features.map((f) => [f.start, f.end]).sort((a, b) => a[0] - b[0]);
  // Read 5-9 sit at columns 15-19; read 10-14 sit at columns 0-4.
  assert.deepStrictEqual(ranges, [[0, 4], [15, 19]]);
  // Two pieces of one feature must not collide as one id.
  assert.notStrictEqual(moved.features[0].id, moved.features[1].id);
});

test('a read with no annotations brings none', () => {
  assert.deepStrictEqual(followAlignmentAnnotations({}, { strand: 1, length: 10 }), {});
  assert.deepStrictEqual(followAlignmentAnnotations(null, { strand: 1, length: 10 }), {});
});

test('an annotation crossing the origin is kept, not dropped', () => {
  /*
   * From a real plasmid: join(4072..4075, 1..657), which GenBank writes as one
   * annotation whose end comes before its start. Reading only start and end
   * gave nothing to iterate between 4072 and 656, so the whole thing vanished
   * without a word -- a feature silently missing from the query track.
   */
  const moved = followAlignmentAnnotations(
    { features: [{ id: 'w', name: 'wraps', start: 90, end: 9, forward: true }] },
    { strand: 1, readIndex: null, length: 100 }
  );
  assert.ok(moved.features && moved.features.length, 'the annotation was dropped');
  const covered = moved.features.reduce((n, f) => n + (f.end - f.start + 1), 0);
  assert.strictEqual(covered, 20, '90..99 and 0..9 is twenty bases');
});

test('the parts of a join are followed separately', () => {
  const moved = followAlignmentAnnotations(
    {
      features: [{
        id: 'j', name: 'joined', start: 10, end: 60, forward: true,
        locations: [{ start: 10, end: 19 }, { start: 50, end: 60 }]
      }]
    },
    { strand: 1, readIndex: null, length: 100 }
  );
  const ranges = moved.features.map((f) => [f.start, f.end]).sort((a, b) => a[0] - b[0]);
  // The gap between the parts is not part of the annotation and must not be
  // filled in by reading start and end alone.
  assert.deepStrictEqual(ranges, [[10, 19], [50, 60]]);
  // Each piece stands alone; carrying the join onto both would draw it twice.
  assert.ok(moved.features.every((f) => f.locations === undefined));
});

test('pieces that end up touching are drawn as one', () => {
  /*
   * An origin-spanning annotation lands as two pieces that abut once the row
   * starts somewhere else. Left apart they are drawn as two features with the
   * name printed twice at the seam.
   */
  const readIndex = [];
  for (let i = 50; i < 100; i++) readIndex.push(i);
  for (let i = 0; i < 50; i++) readIndex.push(i);

  const moved = followAlignmentAnnotations(
    { features: [{ id: 'w', name: 'wraps', start: 95, end: 4, forward: true }] },
    { strand: 1, readIndex, length: 100 }
  );
  // Read 95-99 sit at columns 45-49 and read 0-4 at columns 50-54: one run.
  assert.strictEqual(moved.features.length, 1,
    `expected one merged piece, got ${JSON.stringify(moved.features.map((f) => [f.start, f.end]))}`);
  assert.deepStrictEqual([moved.features[0].start, moved.features[0].end], [45, 54]);
});
