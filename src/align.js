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
/*
 * How many seeds the second diagonal needs, as a flat count rather than a share
 * of the read's total.
 *
 * A share is the wrong shape for this test: the tail past the origin is however
 * long the read happens to overhang by, which has nothing to do with how long
 * the read is. A 3076 bp read of a 3889 bp plasmid overhanging by 126 bp puts
 * ~22 seeds on the wrap diagonal against 587 on the main one -- real, exact,
 * and unreachable under a 5% rule that wanted 30. The wrap went undetected, the
 * read was never rotated, and the overhang came back as a block of mismatches.
 *
 * A flat count is safe here because the seeds are exact 20-mers landing on a
 * diagonal exactly one reference length from the start diagonal. Three of those
 * agreeing is not something noise produces; a chance 20-mer hit in a few
 * kilobases is already unlikely, and three of them collinear at precisely that
 * offset far more so.
 */
const WRAP_MIN_SEEDS = 3;

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
    for (const [d, n] of best.votes) {
      if (n < WRAP_MIN_SEEDS) continue;
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

const { notFoundMessage } = require('./mafft');

const MISSING_MAFFT = notFoundMessage();

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
        /*
         * A binary that exists but is not MAFFT gets this far and returns
         * something that is not FASTA. "returned 0 sequences" reads like an
         * alignment problem; it is almost always a misconfigured path.
         */
        if (!String(stdout || '').trimStart().startsWith('>')) {
          return reject(new Error(
            `"${bin}" ran but did not return an alignment, so it is probably not MAFFT. ` +
            'Check oven.mafftPath.'));
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
/**
 * The longest run of columns the read does not cover, inside its own span.
 *
 * Only meaningful for a read that wraps the origin. Such a read covers an arc
 * that crosses 0, so against a reference drawn from 0 its two halves land at
 * opposite ends and the part it never saw sits *between* them -- interior by
 * position, but absence of coverage all the same, exactly like the leading and
 * trailing gaps already discounted. No rotation of the read can change that:
 * the uncovered arc is in the middle whichever base is called first, which is
 * why rotating alone never fixed these.
 *
 * The longest such run, not all of them: a real deletion elsewhere in the read
 * is a separate, shorter run and stays counted.
 */
function coverageGapRun(referenceRow, readRow, from, to) {
  let best = { at: -1, len: 0 };
  let runStart = -1;
  for (let i = from; i <= to + 1; i++) {
    const isGap = i <= to && readRow[i] === '-' && referenceRow[i] !== '-';
    if (isGap) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      if (i - runStart > best.len) best = { at: runStart, len: i - runStart };
      runStart = -1;
    }
  }
  return best;
}

/* ------------------------------------------------- reads across the origin -- */

/*
 * A read that crosses the origin cannot be aligned against a linear reference.
 *
 * An alignment only moves forward along both sequences. Such a read has its
 * tail at a LOWER reference position than its head, so placing the tail after
 * the head would mean running backwards, which no gap penalty can buy -- MAFFT
 * leaves the tail dangling past the end instead, and it is counted as hundreds
 * of mismatches. Tuning gap costs does not touch this; it is the monotonicity
 * of alignment itself.
 *
 * The fix is to align against the reference written twice, where the same read
 * IS monotonic, and then fold the result back onto one turn. The origin does
 * not move and the coordinates stay as they are in the file: the read simply
 * lands in two pieces, which is what it is.
 */

/** Does this read hang off the end of the reference rather than fitting in it? */
function overhangsEnd(referenceRow, readRow) {
  const last = readRow.length - 1 - String(readRow).split('').reverse().join('').search(/[^-]/);
  if (last < 0) return 0;
  let run = 0;
  for (let i = last; i >= 0 && referenceRow[i] === '-'; i--) run++;
  return run;
}

/**
 * Place a read onto reference coordinates using an alignment against the
 * doubled reference.
 *
 * @returns {{placed: Array<string|null>, covered: Array<[number, number]>,
 *            insertions: number}}
 *   `placed[i]` is the read base sitting on reference position i, or null where
 *   the read has nothing there. `covered` is the reference the read actually
 *   reached, as inclusive ranges -- which is what tells a deletion (inside a
 *   covered stretch) apart from sequence the read never saw.
 */
function foldOntoReference(doubledRefRow, readRow, refLength) {
  const placed = new Array(refLength).fill(null);
  const order = new Array(refLength).fill(-1);
  let refPos = -1;
  let readPos = -1;
  let insertions = 0;

  for (let i = 0; i < doubledRefRow.length; i++) {
    const r = doubledRefRow[i];
    const q = readRow[i];
    if (r !== '-') refPos++;
    if (q !== '-') readPos++;
    if (refPos < 0) continue;
    if (r === '-') { if (q !== '-') insertions++; continue; }
    if (q === '-') continue;
    const at = refPos % refLength;
    placed[at] = q;
    order[at] = readPos;
  }

  // Contiguous stretches of reference the read put bases on, tagged with where
  // in the read they came from.
  const covered = [];
  let from = -1;
  for (let i = 0; i <= refLength; i++) {
    const has = i < refLength && order[i] >= 0;
    if (has && from < 0) from = i;
    else if (!has && from >= 0) { covered.push([from, i - 1]); from = -1; }
  }

  /*
   * Which of the uncovered stretches is a deletion and which was never read.
   *
   * Both are reference with no read base on it, and they are not the same
   * thing: one is sequence the clone has lost, the other is sequence this read
   * simply stopped short of. Read order tells them apart. Walking the segments
   * in the order the read produced them, the reference between one segment and
   * the next is sequence the read carried on through and did not find -- a
   * deletion. What is left over, between the last segment and the first, is the
   * arc it never reached.
   */
  const byRead = covered.slice().sort((a, b) => order[a[0]] - order[b[0]]);
  const deleted = [];
  for (let i = 0; i + 1 < byRead.length; i++) {
    const gapFrom = (byRead[i][1] + 1) % refLength;
    const gapTo = (byRead[i + 1][0] - 1 + refLength) % refLength;
    if (byRead[i][1] + 1 > byRead[i + 1][0] - 1 + refLength) continue;
    deleted.push([gapFrom, gapTo]);
  }

  /*
   * The read, reordered to match the row.
   *
   * Everything downstream -- the letters, the trace under them, the axis --
   * walks a row left to right and counts bases. A folded read breaks that: its
   * first base is in the right-hand piece. So the read is handed over in column
   * order, with `readIndex` recording where each base really came from, which
   * is what lets the axis still number them as read positions.
   */
  const bases = [];
  const readIndex = [];
  for (let i = 0; i < refLength; i++) {
    if (placed[i] === null) continue;
    bases.push(placed[i]);
    readIndex.push(order[i]);
  }

  return { placed, covered, deleted, insertions, sequence: bases.join(''), readIndex };
}

/**
 * Write a folded read back into the column space every other track shares.
 *
 * The shared reference row carries extra columns wherever some other read had
 * an insertion; those get a gap here, so all the rows stay the same length and
 * the viewer can still stack them.
 */
function toSharedColumns(placed, sharedReferenceRow) {
  const out = [];
  let refPos = -1;
  for (let i = 0; i < sharedReferenceRow.length; i++) {
    if (sharedReferenceRow[i] === '-') { out.push('-'); continue; }
    refPos++;
    const base = placed[refPos];
    out.push(base === null || base === undefined ? '-' : base);
  }
  return out.join('');
}

function countDifferences(referenceRow, readRow, opts = {}) {
  let substitutions = 0;
  let gaps = 0;
  let compared = 0;

  /*
   * A read folded across the origin brings its own coverage, because the span
   * between its first and last column is not what it saw: the arc it never
   * reached sits between its two ends. Everything inside the covered ranges is
   * comparison, everything outside is absence of coverage.
   */
  if (opts.covered) {
    /*
     * In scope: the reference the read put bases on, plus the stretches it read
     * straight through and found missing. Out of scope: the arc it never
     * reached, which is absence of coverage rather than disagreement.
     */
    const ranges = opts.covered.concat(opts.deleted || []);
    const inside = new Array(referenceRow.length).fill(false);
    let at = -1;
    for (let i = 0; i < referenceRow.length; i++) {
      if (referenceRow[i] !== '-') at++;
      inside[i] = at >= 0 && ranges.some(([from, to]) => (from <= to
        ? at >= from && at <= to
        : at >= from || at <= to));   // a deletion may wrap the origin
    }
    for (let i = 0; i < referenceRow.length; i++) {
      if (!inside[i]) continue;
      const r = referenceRow[i];
      const q = readRow[i];
      // A column the reference does not occupy belongs to some other read's
      // insertion. Folding drops insertions, so there is nothing to score.
      if (r === '-') continue;
      if (q === '-') { gaps++; continue; }
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

  const start = readRow.search(/[^-]/);
  const end = readRow.length - 1 - String(readRow).split('').reverse().join('').search(/[^-]/);
  // For a wrapping read, discount the arc it never covered (see above).
  const uncovered = opts.wraps && start >= 0
    ? coverageGapRun(referenceRow, readRow, start, end)
    : { at: -1, len: 0 };
  for (let i = 0; i < referenceRow.length; i++) {
    // Leading and trailing gaps are absence of coverage, not disagreement.
    if (start < 0 || i < start || i > end) continue;
    if (uncovered.len && i >= uncovered.at && i < uncovered.at + uncovered.len) continue;
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

/* --------------------------------------------------- mutated CDS codons -- */

const mod = (v, n) => ((v % n) + n) % n;

/** Does this feature cover reference position `pos`, origin wrap included? */
function covers(feature, pos) {
  const { start, end } = feature;
  if (typeof start !== 'number' || typeof end !== 'number') return false;
  return end >= start ? pos >= start && pos <= end : pos >= start || pos <= end;
}

/**
 * The three reference positions of the codon containing `pos`, ascending.
 *
 * Reading frame runs from the CDS start for a forward feature and from its end
 * for a reverse one, so which end you count from decides which bases share a
 * codon -- getting it backwards silently reports the wrong amino acid.
 */
function codonPositions(feature, pos, length) {
  const forward = feature.strand !== -1;
  const offset = forward ? mod(pos - feature.start, length) : mod(feature.end - pos, length);
  const first = offset - (offset % 3);
  const steps = [0, 1, 2].map((i) => (forward
    ? mod(feature.start + first + i, length)
    : mod(feature.end - first - i, length)));
  return steps.sort((a, b) => a - b);
}

/**
 * Codons in a read that carry a substitution and lie inside a CDS.
 *
 * Returned in READ coordinates, because that is where the viewer needs them:
 * handing OVE a translation over these positions makes it work out the amino
 * acid from the read's own bases, which is the whole point -- what the mutation
 * actually codes for, not what the reference said.
 *
 * A codon is skipped when its three bases are not contiguous in the read: an
 * indel inside the codon means there is no single triplet to translate, and
 * guessing one would be worse than saying nothing.
 */
function mutatedCodons(referenceRow, readRow, features, referenceLength) {
  const refToRead = new Map();
  const differing = [];
  let refPos = -1;
  let readPos = -1;

  for (let i = 0; i < referenceRow.length; i++) {
    const r = referenceRow[i];
    const q = readRow[i];
    if (r !== '-') refPos++;
    if (q !== '-') readPos++;
    if (r === '-' || q === '-') continue;
    refToRead.set(refPos, readPos);
    if (r.toUpperCase() !== q.toUpperCase()) differing.push(refPos);
  }

  const cdsFeatures = (features || []).filter((f) => /^cds$/i.test(String(f.type || '')));
  const byCodon = new Map();

  for (const at of differing) {
    for (const feature of cdsFeatures) {
      if (!covers(feature, at)) continue;
      const positions = codonPositions(feature, at, referenceLength);
      const reads = positions.map((p) => refToRead.get(p));
      if (reads.some((v) => v === undefined)) continue;
      const first = Math.min(...reads);
      const last = Math.max(...reads);
      if (last - first !== 2) continue; // an indel splits the codon
      byCodon.set(`${feature.id || feature.name}:${positions[0]}`, {
        start: first,
        end: last,
        strand: feature.strand === -1 ? -1 : 1,
        forward: feature.strand !== -1,
        cds: feature.name || feature.id || 'CDS',
        referencePositions: positions
      });
    }
  }
  return [...byCodon.values()];
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

  /*
   * Second pass for reads that ran off the end (see foldOntoReference).
   *
   * Only those reads, and one at a time: the shared run is what every ordinary
   * read is measured in, and doubling the reference for all of them would give
   * a read that does not cross the origin two equally good places to sit.
   */
  const sharedReferenceRow = aligned[0].sequence;
  const folded = new Array(pairs.length).fill(null);
  for (let i = 0; i < pairs.length; i++) {
    if (!overhangsEnd(pairs[i].referenceRow, pairs[i].readRow)) continue;
    /*
     * Only a read that fits within one turn. Folding maps every read base to a
     * reference position, so a read longer than the reference would have two
     * bases claiming the same position and the later one would quietly win.
     * A read that long is not a read crossing the origin anyway.
     */
    if (prepared[i].sequence.length > refSeq.length) continue;
    const twice = await runMafft(
      [{ name: 'reference', sequence: refSeq + refSeq },
        { name: prepared[i].key, sequence: prepared[i].sequence }],
      opts
    );
    const pair = splitPairs(twice)[0];
    const fold = foldOntoReference(pair.referenceRow, pair.readRow, refSeq.length);
    // Only keep it if it actually placed the read; a read that genuinely
    // belongs nowhere should stay as MAFFT left it rather than be forced on.
    if (fold.covered.length) {
      folded[i] = Object.assign(fold, {
        readRow: toSharedColumns(fold.placed, sharedReferenceRow)
      });
    }
  }

  /*
   * Folding a read out of its dangling position can leave columns no row
   * occupies -- the ones MAFFT opened for the overhang. Left in, the viewer
   * draws them as a blank band, so they go.
   */
  let msaReference = sharedReferenceRow;
  let msaRows = prepared.map((p, i) => (folded[i] ? folded[i].readRow : aligned[i + 1].sequence));
  if (folded.some(Boolean)) {
    const keep = [];
    for (let i = 0; i < msaReference.length; i++) {
      if (msaReference[i] !== '-' || msaRows.some((row) => row[i] !== '-')) keep.push(i);
    }
    if (keep.length !== msaReference.length) {
      const pick = (row) => keep.map((i) => row[i]).join('');
      msaReference = pick(msaReference);
      msaRows = msaRows.map(pick);
      for (let i = 0; i < folded.length; i++) {
        if (folded[i]) folded[i].readRow = msaRows[i];
      }
    }
  }

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
      reference: msaReference,
      rows: prepared.map((p, i) => ({ name: p.input.name, sequence: msaRows[i] }))
    },
    tracks: prepared.map((p, i) => {
      const pair = pairs[i];
      // MAFFT may have flipped a read anchoring could not orient.
      const strand = pair.flipped ? -p.strand : p.strand;
      const fold = folded[i];
      const readRow = fold ? fold.readRow : pair.readRow;
      const referenceRow = fold ? msaReference : pair.referenceRow;
      return {
        name: p.input.name,
        strand,
        anchored: p.anchored,
        offset: p.offset,
        seeds: p.seeds,
        rotation: p.rotation,
        flippedByMafft: pair.flipped,
        sequence: p.sequence,
        referenceRow,
        readRow,
        /*
         * Which reference the read actually reached, as inclusive ranges. Only
         * a folded read carries it: for everything else the covered stretch is
         * the span between its first and last base, which the viewer already
         * works out for itself.
         */
        covered: fold ? fold.covered : null,
        crossesOrigin: Boolean(fold),
        // Present only for a folded read: its bases in the order the row lays
        // them out, and where each one sits in the read as sequenced.
        columnOrderSequence: fold ? fold.sequence : null,
        readIndex: fold ? fold.readIndex : null,
        deleted: fold ? fold.deleted : null,
        ...countDifferences(referenceRow, readRow, {
          wraps: Boolean(p.rotation),
          covered: fold ? fold.covered : null,
          deleted: fold ? fold.deleted : null
        })
      };
    })
  };
}

module.exports = {
  align, anchor, rotateString, rotationFor, splitPairs, countDifferences,
  mutatedCodons, codonPositions, overhangsEnd, foldOntoReference, toSharedColumns,
  runMafft, parseFasta, toFasta, MISSING_MAFFT, DEFAULT_K
};
