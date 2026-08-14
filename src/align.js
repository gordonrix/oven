/*
 * Aligns sequencing reads against a reference plasmid.
 *
 * MAFFT does the alignment. What MAFFT cannot do is circular topology, and that
 * is not a corner case here: a full-plasmid read starts wherever the assembler
 * happened to break it, so it routinely runs off the end of the reference and
 * continues at the start. Handing such a read to MAFFT unchanged aligns only
 * the portion before the origin and strands the rest -- measured on a real
 * 4489 bp plasmid, 2140 mismatches instead of 0.
 *
 * So the read is rotated into the reference's frame first, by k-mer anchoring,
 * and MAFFT is asked to align sequences that already start in the same place.
 * The reference is never rotated: it owns the coordinates and the annotations
 * the viewer draws along the top.
 *
 *   anchor()  -- which strand, and where does the read start on the reference
 *   rotate    -- move the read (and its trace) into that frame
 *   mafft     -- one call, reference first, all reads together
 *   split     -- carve the resulting MSA into [reference, read] pairs
 */
'use strict';

const { execFile } = require('child_process');
const { revComp } = require('../media/cartShared');

const DEFAULT_K = 20;

/*
 * Sample every SEED_STRIDE-th k-mer rather than all of them. Anchoring only
 * needs the dominant diagonal, and a 4.5 kb read still contributes ~900 votes
 * at stride 5 -- far more than enough to separate signal from a few spurious
 * repeat hits, at a fifth of the work.
 */
const SEED_STRIDE = 5;

/* Same reasoning as primerMatch's budget: a low-complexity read can make the
 * seed histogram blow up, so cap the votes rather than hang. */
const MAX_SEEDS = 2e5;

/* -------------------------------------------------------------- anchoring -- */

function buildIndex(seq, k) {
  const idx = new Map();
  for (let i = 0; i + k <= seq.length; i++) {
    const kmer = seq.substr(i, k);
    // First position only. A repeated k-mer votes for one diagonal instead of
    // several; with hundreds of votes the true diagonal still wins easily.
    if (!idx.has(kmer)) idx.set(kmer, i);
  }
  return idx;
}

/*
 * How far a wrap's two diagonals may drift from being exactly one reference
 * length apart, and how much support the second one needs. Indels between the
 * two halves shift them slightly; a read that merely contains an indel produces
 * diagonals a few bases apart, nowhere near a whole reference length, so these
 * two cases never get confused.
 */
const WRAP_SLOP = 100;
const WRAP_MIN_SUPPORT = 0.05;

/** Median of the diagonals of the earliest seeds -- i.e. where the read starts. */
const START_SAMPLE = 9;

/**
 * Work out which strand a read is on, where its first base sits on the
 * reference, and whether it runs off the end and continues at the start.
 *
 * Votes on the raw diagonal `refPos - readPos`, deliberately *not* reduced
 * modulo the reference length. A wrapping read produces two diagonals exactly
 * one reference length apart, and that separation is the only reliable signal
 * that a wrap happened -- taking the modulo first merges them and throws it
 * away. It matters because the rotation must be applied only to undo a wrap:
 * rotating a read just because its dominant diagonal is offset would also fire
 * on any read carrying an indel, whose halves sit on diagonals a few bases
 * apart, and would shuffle it out of its own frame for no reason.
 *
 * @returns {{strand: 1|-1, offset: number, wraps: boolean, votes: number,
 *            total: number}|null}
 *   `offset` is the reference position of the (possibly reverse-complemented)
 *   read's first base. null when nothing seeds at all.
 */
function anchor(reference, read, { k = DEFAULT_K, circular = true } = {}) {
  const ref = String(reference || '').toUpperCase();
  const fwd = String(read || '').toUpperCase();
  if (ref.length < k || fwd.length < k) return null;

  const idx = buildIndex(ref, k);
  const len = ref.length;
  let best = null;

  for (const [strand, seq] of [[1, fwd], [-1, revComp(fwd)]]) {
    const votes = new Map();
    const seeds = [];
    for (let i = 0; i + k <= seq.length && seeds.length < MAX_SEEDS; i += SEED_STRIDE) {
      const at = idx.get(seq.substr(i, k));
      if (at === undefined) continue;
      const d = at - i;
      seeds.push({ readPos: i, d });
      votes.set(d, (votes.get(d) || 0) + 1);
    }
    if (!seeds.length) continue;
    if (!best || seeds.length > best.total) {
      best = { strand, seeds, votes, total: seeds.length };
    }
  }
  if (!best) return null;

  // Where the read *starts*, taken from its earliest seeds rather than from the
  // most popular diagonal: after an indel the larger half wins the popular
  // vote, and its diagonal is not where base 0 sits.
  const head = best.seeds.slice(0, START_SAMPLE).map((s) => s.d).sort((a, b) => a - b);
  const startDiagonal = head[Math.floor(head.length / 2)];

  let wraps = false;
  if (circular) {
    const support = Math.max(1, Math.floor(best.total * WRAP_MIN_SUPPORT));
    for (const [d, n] of best.votes) {
      if (n < support) continue;
      if (Math.abs(startDiagonal - d - len) <= WRAP_SLOP) { wraps = true; break; }
    }
  }

  const offset = circular ? ((startDiagonal % len) + len) % len : startDiagonal;
  const dominant = Math.max(...best.votes.values());
  return { strand: best.strand, offset, wraps, votes: dominant, total: best.total };
}

/** Rotate a string so index `by` becomes index 0. */
function rotateString(s, by) {
  if (!by) return s;
  const n = ((by % s.length) + s.length) % s.length;
  return s.slice(n) + s.slice(0, n);
}

/**
 * Rotate the read so its first base lands on reference position 0.
 *
 * `offset` is where the read currently starts on the reference, so the base
 * that belongs at reference 0 is the one `len - offset` along the read.
 */
function rotationFor(readLength, offset, refLength) {
  if (!offset) return 0;
  return ((refLength - offset) % readLength + readLength) % readLength;
}

/* ------------------------------------------------------------------ MAFFT -- */

const MISSING_MAFFT =
  'MAFFT was not found. Install it with "brew install mafft" or ' +
  '"conda install -c bioconda mafft", or set oveCart.mafftPath to its full path.';

function toFasta(records) {
  return records.map((r) => `>${r.name}\n${r.sequence}\n`).join('');
}

function parseFasta(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('>')) {
      cur = { name: line.slice(1).trim(), sequence: '' };
      out.push(cur);
    } else if (cur) {
      cur.sequence += line.trim();
    }
  }
  return out;
}

/**
 * Run MAFFT over stdin and return the aligned records in input order.
 *
 * `--adjustdirection` is belt and braces: anchoring has already oriented every
 * read it could seed, but this still rescues one it could not. MAFFT marks a
 * sequence it flipped by prefixing its name with `_R_`, which the caller has to
 * act on -- see splitPairs.
 */
function runMafft(records, opts = {}) {
  const bin = opts.mafftPath || 'mafft';
  const extra = (opts.mafftArgs || '--auto').split(/\s+/).filter(Boolean);
  const args = [...extra, '--adjustdirection', '--preservecase', '--quiet', '-'];

  return new Promise((resolve, reject) => {
    const child = execFile(
      bin, args,
      { maxBuffer: 1 << 28, timeout: opts.timeoutMs || 120000 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') return reject(new Error(MISSING_MAFFT));
          return reject(new Error(`MAFFT failed: ${(stderr || err.message).trim().slice(0, 500)}`));
        }
        const aligned = parseFasta(stdout);
        if (aligned.length !== records.length) {
          return reject(new Error(
            `MAFFT returned ${aligned.length} sequences for ${records.length} inputs`));
        }
        resolve(aligned);
      }
    );
    child.stdin.end(toFasta(records));
  });
}

/* ------------------------------------------------------- MSA -> pairwise -- */

/**
 * Carve an MSA into one [reference, read] pair per read.
 *
 * The viewer only builds its mutation summary from pairwise input, and the rows
 * of an MSA already share a column space, so this is a slice rather than a
 * re-alignment. Columns gapped in *both* rows come from some other read's
 * insertion and are dropped, which keeps each pair in the reference's own
 * coordinates; a column where only the reference is gapped is a real insertion
 * in this read and is kept.
 */
function splitPairs(aligned) {
  const [ref, ...reads] = aligned;
  return reads.map((read) => {
    // MAFFT prefixes a sequence it reverse-complemented.
    const flipped = read.name.startsWith('_R_');
    const refCols = [];
    const readCols = [];
    for (let i = 0; i < ref.sequence.length; i++) {
      const r = ref.sequence[i];
      const q = read.sequence[i];
      if (r === '-' && q === '-') continue;
      refCols.push(r);
      readCols.push(q);
    }
    return {
      name: flipped ? read.name.slice(3) : read.name,
      flipped,
      referenceRow: refCols.join(''),
      readRow: readCols.join('')
    };
  });
}

/** Substitutions and gapped columns between two equal-length aligned rows. */
function countDifferences(referenceRow, readRow) {
  let substitutions = 0;
  let gaps = 0;
  let compared = 0;
  const start = readRow.search(/[^-]/);
  const end = readRow.length - 1 - String(readRow).split('').reverse().join('').search(/[^-]/);
  for (let i = 0; i < referenceRow.length; i++) {
    // Leading and trailing gaps are absence of coverage, not disagreement.
    if (start < 0 || i < start || i > end) continue;
    const r = referenceRow[i];
    const q = readRow[i];
    if (r === '-' || q === '-') { gaps++; continue; }
    compared++;
    if (r.toUpperCase() !== q.toUpperCase()) substitutions++;
  }
  return {
    substitutions,
    gaps,
    compared,
    mismatches: substitutions + gaps,
    identity: compared ? (compared - substitutions) / compared : 0
  };
}

/* ------------------------------------------------------------ the pipeline -- */

/**
 * Align reads against a reference.
 *
 * @param {{name: string, sequence: string, circular?: boolean}} reference
 * @param {Array<{name: string, sequence: string, onRotate?: function}>} reads
 *   `onRotate(rotation, strand)` is called for a read that had to move, so the
 *   caller can bring a chromatogram along with it.
 * @returns {Promise<{reference: object, tracks: Array}>}
 */
async function align(reference, reads, opts = {}) {
  const refSeq = String(reference.sequence || '').toUpperCase();
  const circular = reference.circular !== false;
  if (!refSeq) throw new Error('The reference has no sequence.');
  if (!reads.length) return { reference, tracks: [] };

  const prepared = reads.map((read, i) => {
    const seq = String(read.sequence || '').toUpperCase();
    const hit = seq ? anchor(refSeq, seq, { k: opts.k, circular }) : null;

    let oriented = seq;
    let strand = 1;
    if (hit && hit.strand === -1) {
      oriented = revComp(seq);
      strand = -1;
    }
    // Rotate only to undo a wrap. An ordinary offset is something MAFFT handles
    // perfectly well with terminal gaps, and moving the read would only take it
    // out of its own frame.
    const rotation = hit && hit.wraps
      ? rotationFor(oriented.length, hit.offset, refSeq.length)
      : 0;

    return {
      input: read,
      // Unique and MAFFT-safe: its name parsing stops at whitespace, and we
      // need to match rows back to reads by position anyway.
      key: `read${i}`,
      anchored: Boolean(hit),
      offset: hit ? hit.offset : null,
      seeds: hit ? hit.votes : 0,
      strand,
      rotation,
      sequence: rotateString(oriented, rotation)
    };
  });

  const aligned = await runMafft(
    [{ name: 'reference', sequence: refSeq },
      ...prepared.map((p) => ({ name: p.key, sequence: p.sequence }))],
    opts
  );

  const pairs = splitPairs(aligned);

  return {
    reference,
    /*
     * The MSA exactly as MAFFT produced it, reference first. The viewer wants
     * this: every row shares one column space, which is what lets it stack the
     * tracks. The per-track referenceRow/readRow below are the same alignment
     * carved into pairs, which is what the mismatch counts are measured on --
     * a column gapped in both rows belongs to some other read's insertion and
     * would otherwise be counted against this one.
     */
    msa: {
      reference: aligned[0].sequence,
      rows: prepared.map((p, i) => ({
        name: p.input.name,
        sequence: aligned[i + 1].sequence
      }))
    },
    tracks: prepared.map((p, i) => {
      const pair = pairs[i];
      // MAFFT may have flipped a read anchoring could not orient.
      const strand = pair.flipped ? -p.strand : p.strand;
      return {
        name: p.input.name,
        strand,
        anchored: p.anchored,
        offset: p.offset,
        seeds: p.seeds,
        rotation: p.rotation,
        flippedByMafft: pair.flipped,
        sequence: p.sequence,
        referenceRow: pair.referenceRow,
        readRow: pair.readRow,
        ...countDifferences(pair.referenceRow, pair.readRow)
      };
    })
  };
}

module.exports = {
  align, anchor, rotateString, rotationFor, splitPairs, countDifferences,
  runMafft, parseFasta, toFasta, MISSING_MAFFT, DEFAULT_K
};
