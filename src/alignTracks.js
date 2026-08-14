/*
 * Turns files the user picked into alignment tracks.
 *
 * Two jobs beyond parsing. First, quality trimming: a Sanger read is noisy at
 * both ends, and untrimmed those ends dominate the mismatch count and say
 * nothing about the construct. Second, keeping a chromatogram in step with its
 * bases -- the aligner may reverse-complement a read, and will rotate one that
 * spans the origin, and the trace has to make exactly the same journey or the
 * peaks stop lining up with the letters underneath them.
 *
 * The trace is stored per base pair (`baseTraces[i]` holds the four channel
 * arrays for base i), which is what makes that tractable: reversing and
 * rotating are array operations, with no scan positions to renumber. Only
 * `baseTraces` and `qualNums` are read by the drawing code, but `baseCalls` is
 * carried along so the structure stays self-consistent.
 */
'use strict';

const path = require('path');

const { anyToJson } = require('../media/bioparser2.umd.js');
const { revComp } = require('../media/cartShared');

const TRACE_CHANNELS = ['aTrace', 'tTrace', 'gTrace', 'cTrace'];

/* A complement swaps which channel is which, as well as reversing the order. */
const COMPLEMENT_CHANNEL = {
  aTrace: 'tTrace', tTrace: 'aTrace', gTrace: 'cTrace', cTrace: 'gTrace'
};

/*
 * Trimming looks at a window rather than single bases: one good base inside a
 * run of noise is not the start of usable signal, and stopping there leaves the
 * noise in. The test is what fraction of the window clears the threshold, not
 * the window's mean -- a mean is dragged over the line by one tall value, so a
 * lone good base surrounded by junk still reads as a good place to start.
 */
const TRIM_WINDOW = 10;
const TRIM_MIN_GOOD = 0.8;

/* ---------------------------------------------------------------- parsing -- */

const SEQUENCE_EXTENSIONS = ['ab1', 'gb', 'gbk', 'fa', 'fasta', 'dna'];

function isSupported(name) {
  const ext = path.extname(String(name || '')).replace('.', '').toLowerCase();
  return SEQUENCE_EXTENSIONS.includes(ext);
}

/**
 * Parse one file into one or more tracks.
 *
 * A FASTA holds any number of records, so this always returns an array --
 * taking [0] would silently drop every read after the first.
 *
 * @param {Buffer|string} content raw bytes, or text for a text format
 * @returns {Promise<Array<{name, sequence, sequenceData, chromatogramData}>>}
 */
async function parseFile(content, fileName) {
  const parsed = await anyToJson(content, { fileName, acceptParts: true });
  const base = path.basename(String(fileName || 'sequence'), path.extname(String(fileName || '')));

  return (parsed || [])
    .filter((r) => r && r.parsedSequence && r.parsedSequence.sequence)
    .map((r, i, all) => {
      const seq = r.parsedSequence;
      return {
        // Only qualify with the record name when there is more than one, so a
        // single-record file keeps the filename the user recognises.
        name: all.length > 1 ? `${base} · ${seq.name || `record ${i + 1}`}` : (base || seq.name),
        sequence: String(seq.sequence || '').toUpperCase(),
        circular: Boolean(seq.circular),
        sequenceData: seq,
        chromatogramData: seq.chromatogramData || null
      };
    });
}

/* --------------------------------------------------------------- trimming -- */

/** What fraction of the window from `from` (walking `step`) clears `minQuality`. */
function windowGoodFraction(qual, from, step, minQuality) {
  let good = 0;
  let n = 0;
  for (let i = from; n < TRIM_WINDOW && i >= 0 && i < qual.length; i += step) {
    if (qual[i] >= minQuality) good++;
    n++;
  }
  return n ? good / n : 0;
}

/**
 * Find the usable span of a read, by quality.
 *
 * @returns {{start: number, end: number}} inclusive, in read coordinates.
 *   The whole read when there is no quality data or trimming is off.
 */
function qualitySpan(qual, minQuality) {
  if (!qual || !qual.length || !minQuality) return { start: 0, end: (qual || []).length - 1 };
  // Two conditions, and both are needed. The window alone would stop a couple
  // of bases early, on a base already known to be bad, because a mostly-good
  // window can still start on a bad one; the base alone would stop on the first
  // lucky base inside a run of noise.
  const good = (i, step) =>
    qual[i] >= minQuality && windowGoodFraction(qual, i, step, minQuality) >= TRIM_MIN_GOOD;

  let start = 0;
  let end = qual.length - 1;
  while (start < end && !good(start, 1)) start++;
  while (end > start && !good(end, -1)) end--;
  return { start, end };
}

/** Cut a track down to [start, end], keeping bases, quality and trace in step. */
function sliceTrack(track, start, end) {
  if (start === 0 && end === track.sequence.length - 1) return track;
  const chrom = track.chromatogramData;
  return Object.assign({}, track, {
    sequence: track.sequence.slice(start, end + 1),
    trimmed: { start, end, removed: track.sequence.length - (end - start + 1) },
    chromatogramData: chrom ? Object.assign({}, chrom, {
      baseCalls: (chrom.baseCalls || []).slice(start, end + 1),
      qualNums: chrom.qualNums ? chrom.qualNums.slice(start, end + 1) : undefined,
      baseTraces: (chrom.baseTraces || []).slice(start, end + 1)
    }) : null
  });
}

/** Trim low-quality ends. A track with no quality data passes straight through. */
function trimByQuality(track, minQuality) {
  const qual = track.chromatogramData && track.chromatogramData.qualNums;
  if (!qual || !qual.length || !minQuality) return track;
  const { start, end } = qualitySpan(qual, minQuality);
  if (end <= start) return track; // nothing survives the threshold; keep it all
  return sliceTrack(track, start, end);
}

/* ------------------------------------------------- keeping the trace in step -- */

/** Reverse-complement a per-bp chromatogram. */
function reverseComplementChromatogram(chrom) {
  if (!chrom) return chrom;
  const traces = (chrom.baseTraces || []).map((bp) => {
    const out = {};
    for (const channel of TRACE_CHANNELS) {
      // The channel that becomes `channel` after complementing, read backwards.
      out[channel] = (bp[COMPLEMENT_CHANNEL[channel]] || []).slice().reverse();
    }
    return out;
  }).reverse();

  return Object.assign({}, chrom, {
    baseTraces: traces,
    baseCalls: revComp((chrom.baseCalls || []).join('')).split(''),
    qualNums: chrom.qualNums ? chrom.qualNums.slice().reverse() : undefined
  });
}

/** Rotate a per-bp chromatogram so base `by` becomes base 0. */
function rotateChromatogram(chrom, by) {
  if (!chrom || !by) return chrom;
  const n = (chrom.baseTraces || []).length;
  if (!n) return chrom;
  const at = ((by % n) + n) % n;
  const roll = (arr) => (arr ? arr.slice(at).concat(arr.slice(0, at)) : arr);
  return Object.assign({}, chrom, {
    baseTraces: roll(chrom.baseTraces),
    baseCalls: roll(chrom.baseCalls),
    qualNums: roll(chrom.qualNums)
  });
}

/**
 * Put a track's trace through the same transform the aligner applied to its
 * sequence.
 *
 * Order matters and mirrors the aligner: reverse-complement first, then rotate,
 * because the rotation was measured against the already-oriented read.
 */
function followAlignment(chrom, { strand, rotation }) {
  if (!chrom) return null;
  let out = chrom;
  if (strand === -1) out = reverseComplementChromatogram(out);
  if (rotation) out = rotateChromatogram(out, rotation);
  return out;
}

module.exports = {
  parseFile, isSupported, SEQUENCE_EXTENSIONS,
  trimByQuality, qualitySpan, sliceTrack,
  reverseComplementChromatogram, rotateChromatogram, followAlignment
};
