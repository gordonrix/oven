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

/* ------------------------------------------------------------- smoothing -- */

/*
 * Some writers emit very few samples per base, with square shoulders -- one
 * file here has four samples per base and every value is either 0 or the peak
 * height. Drawn as straight lines between those points that is a flat-topped
 * rectangle, which is what "pure vertical spikes" looks like on screen. Other
 * viewers interpolate, which is why the same file reads as peaks there.
 *
 * Anything with enough samples to describe its own shape is left alone: this
 * is for rescuing coarse traces, not for reshaping good ones.
 */
const SMOOTH_BELOW = 8;   // samples per base under which a trace is coarse
const SMOOTH_TARGET = 16; // samples per base to resample up to

/** Cosine interpolation: smooth through the samples, no overshoot past them. */
function resample(points, target) {
  if (points.length < 2) return points.slice();
  const out = new Array(target);
  const last = points.length - 1;
  for (let i = 0; i < target; i++) {
    const at = (i / (target - 1)) * last;
    const lo = Math.floor(at);
    const hi = Math.min(last, lo + 1);
    const f = at - lo;
    // (1 - cos(pi*f)) / 2 eases in and out, so square shoulders become peaks
    // without ringing above the original maximum the way a spline can.
    const w = (1 - Math.cos(Math.PI * f)) / 2;
    out[i] = Math.round(points[lo] * (1 - w) + points[hi] * w);
  }
  return out;
}

/**
 * Smooth a per-bp chromatogram whose sample density is too low to draw.
 *
 * @returns the chromatogram, resampled only if it is coarse.
 */
function smoothChromatogram(chrom) {
  const traces = chrom && chrom.baseTraces;
  if (!traces || !traces.length) return chrom;

  // Judge on the median, so a couple of odd-sized windows at the ends do not
  // decide it for the whole read.
  const lengths = traces.map((bp) => (bp.aTrace || []).length).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)];
  if (!median || median >= SMOOTH_BELOW) return chrom;

  return Object.assign({}, chrom, {
    baseTraces: traces.map((bp) => {
      const out = {};
      for (const channel of TRACE_CHANNELS) out[channel] = resample(bp[channel] || [], SMOOTH_TARGET);
      return out;
    }),
    smoothedFrom: median
  });
}

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
        chromatogramData: seq.chromatogramData ? smoothChromatogram(seq.chromatogramData) : null
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
 * Reorder a per-bp chromatogram to match a read handed over out of read order.
 *
 * A read folded across the origin is laid out in the row by reference position,
 * so its first base is not the leftmost one. The trace is indexed by read
 * position, and the viewer walks both left to right -- so without this the
 * peaks sit under the wrong letters.
 *
 * @param {number[]} readIndex where each base of the reordered read came from
 */
function reorderChromatogram(chrom, readIndex) {
  if (!chrom || !readIndex) return chrom;
  const pick = (arr) => (arr ? readIndex.map((i) => arr[i]) : arr);
  return Object.assign({}, chrom, {
    baseTraces: pick(chrom.baseTraces),
    baseCalls: pick(chrom.baseCalls),
    qualNums: pick(chrom.qualNums)
  });
}

/**
 * Put a track's trace through the same transform the aligner applied to its
 * sequence.
 *
 * Order matters and mirrors the aligner: reverse-complement first, then rotate,
 * because the rotation was measured against the already-oriented read. A folded
 * read is reordered last, since its readIndex is expressed over the oriented
 * read.
 */
function followAlignment(chrom, { strand, rotation, readIndex }) {
  if (!chrom) return null;
  let out = chrom;
  if (strand === -1) out = reverseComplementChromatogram(out);
  if (rotation) out = rotateChromatogram(out, rotation);
  if (readIndex) out = reorderChromatogram(out, readIndex);
  return out;
}

/* The annotation kinds a GenBank read can bring with it. */
const ANNOTATION_KINDS = ['features', 'parts', 'primers'];

/**
 * Put a read's own annotations through the same transform its sequence took.
 *
 * A GenBank read carries features in its own coordinates, but the row draws the
 * read flipped, and for a read folded across the origin, reordered. Handed over
 * untransformed the features land somewhere else entirely, which is worse than
 * not drawing them: wrong and confident.
 *
 * Flip first, then reorder -- the same order as followAlignment, because the
 * reorder is expressed over the already-oriented read.
 *
 * A folded read can split an annotation in two: its bases are contiguous in the
 * read and need not be contiguous in the row. Those come back as one piece per
 * run, which is what the viewer can draw.
 *
 * @param {object} sequenceData the read's own parsed data
 * @param {object} track        {strand, readIndex, sequence}
 * @returns {object} {features, parts, primers} in row coordinates
 */
function followAlignmentAnnotations(sequenceData, { strand, readIndex, length }) {
  const out = {};
  if (!sequenceData) return out;

  // Column of each read base, for a folded read. Identity otherwise.
  let columnOf = null;
  if (readIndex && readIndex.length) {
    columnOf = new Array(length).fill(-1);
    for (let col = 0; col < readIndex.length; col++) columnOf[readIndex[col]] = col;
  }

  for (const kind of ANNOTATION_KINDS) {
    const list = sequenceData[kind];
    if (!Array.isArray(list) || !list.length) continue;

    const moved = [];
    for (const annotation of list) {
      let forward = annotation.forward !== undefined
        ? annotation.forward
        : annotation.strand !== -1;

      /*
       * The bases this annotation actually sits on, as plain ranges.
       *
       * A GenBank join gives several; one that crosses the origin gives a
       * single range with its end before its start. Reading only start and end
       * dropped both -- a `join(4072..4075,1..657)` has nothing to iterate
       * between 4072 and 656, so the whole annotation silently vanished.
       */
      const ranges = [];
      const push = (from, to) => {
        if (!Number.isFinite(from) || !Number.isFinite(to)) return;
        if (from <= to) ranges.push([from, to]);
        else { ranges.push([from, length - 1]); ranges.push([0, to]); }
      };
      if (Array.isArray(annotation.locations) && annotation.locations.length) {
        for (const location of annotation.locations) push(Number(location.start), Number(location.end));
      } else {
        push(Number(annotation.start), Number(annotation.end));
      }
      if (!ranges.length) continue;

      const flipped = strand === -1
        ? ranges.map(([from, to]) => [length - 1 - to, length - 1 - from])
        : ranges;
      if (strand === -1) forward = !forward;

      const pieces = [];
      const emit = (from, to) => { pieces.push([Math.min(from, to), Math.max(from, to)]); };
      const finish = (from, to) => {
        moved.push(Object.assign({}, annotation, {
          id: `${annotation.id || annotation.name || kind}-${from}`,
          start: from,
          end: to,
          forward,
          strand: forward ? 1 : -1,
          // Each piece stands alone once split; a join copied onto every piece
          // would have the viewer draw the whole thing again per piece.
          locations: undefined,
          /*
           * `bases` is dropped, and it has to be.
           *
           * The viewer draws an annotation's bases along it and reds anything
           * that does not match the template underneath. The parser fills this
           * in from a CDS's /translation qualifier, so for a coding feature it
           * holds protein, not DNA -- six residues drawn one-per-base over
           * eighteen bases, every one of them "not matching", every one red.
           * What it looked like was a mutation; what it was is an amino acid
           * string being compared to DNA.
           *
           * Nothing is lost: the bases under the annotation are the track's own
           * sequence, already drawn.
           */
          bases: undefined
        }));
      };

      for (const [from, to] of flipped) {
        if (!columnOf) { emit(from, to); continue; }

        // Walk it in read order and break it again wherever the row does.
        let runStart = null;
        let previous = null;
        for (let at = from; at <= to && at < length; at++) {
          const col = columnOf[at];
          if (col < 0) continue;
          if (runStart === null) { runStart = col; previous = col; continue; }
          if (col === previous + 1) { previous = col; continue; }
          emit(runStart, previous);
          runStart = col;
          previous = col;
        }
        if (runStart !== null) emit(runStart, previous);
      }

      /*
       * Put touching pieces back together. A join whose parts sit next to each
       * other once moved -- which is what an origin-spanning annotation becomes
       * when the row starts somewhere else -- would otherwise be drawn as two
       * abutting features, with the name printed twice at the seam.
       */
      pieces.sort((a, b) => a[0] - b[0]);
      let open = null;
      for (const [from, to] of pieces) {
        if (open && from <= open[1] + 1) { open[1] = Math.max(open[1], to); continue; }
        if (open) finish(open[0], open[1]);
        open = [from, to];
      }
      if (open) finish(open[0], open[1]);
    }
    if (moved.length) out[kind] = moved;
  }
  return out;
}

module.exports = {
  parseFile, isSupported, SEQUENCE_EXTENSIONS,
  followAlignmentAnnotations, ANNOTATION_KINDS,
  smoothChromatogram, resample, SMOOTH_BELOW, SMOOTH_TARGET,
  trimByQuality, qualitySpan, sliceTrack,
  reverseComplementChromatogram, rotateChromatogram, reorderChromatogram, followAlignment
};
