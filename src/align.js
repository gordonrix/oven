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
function anchor(reference, read, { k: kGiven, circular = true } = {}) {
  const ref = String(reference || '').toUpperCase();
  const fwd = String(read || '').toUpperCase();
  /*
   * A short read gets short seeds, laid at every position.
   *
   * A 20-mer seeds at all only if it matches the reference exactly, so a primer
   * or a short insert with a single difference never anchored: nothing then
   * decided its strand before MAFFT, and MAFFT's own direction guess is a
   * coin-toss on twenty bases. Half the read's length, but never under 8, is
   * long enough that chance hits on a plasmid are rare and voting outweighs
   * them, and short enough that two differences cannot cover every window.
   */
  const short = fwd.length < 2 * DEFAULT_K;
  const k = kGiven || (short ? Math.max(8, Math.floor(fwd.length / 2)) : DEFAULT_K);
  const stride = short ? 1 : SEED_STRIDE;
  if (ref.length < k || fwd.length < k) return null;

  const idx = buildIndex(ref, k);
  const len = ref.length;
  let best = null;

  for (const [strand, seq] of [[1, fwd], [-1, revComp(fwd)]]) {
    const votes = new Map();
    const seeds = [];
    for (let i = 0; i + k <= seq.length && seeds.length < MAX_SEEDS; i += stride) {
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
 * The arguments MAFFT is run with.
 *
 * The user's oven.mafftArgs come first and ours after them, so ours win where
 * they overlap. For DNA that adds `--adjustdirection`, which lets MAFFT
 * reverse-complement a read anchoring could not orient.
 *
 * A protein has no reverse complement, and `--adjustdirection` on one is at
 * best meaningless. So it goes, along with any `--nuc` the user set for their
 * DNA work, and `--amino` is added after their arguments, because MAFFT obeys
 * whichever of `--nuc` and `--amino` it reads last. `--anysymbol` keeps the
 * rarer residue codes -- U, O, B, Z, J, X -- as themselves rather than letting
 * MAFFT refuse or rewrite them; newer builds already imply it with
 * `--preservecase`, older ones do not.
 */
function mafftArgsFor(opts = {}) {
  const extra = (opts.mafftArgs || '--auto').split(/\s+/).filter(Boolean);
  if (opts.molecule === 'protein') {
    const kept = extra.filter((a) => !/^--(nuc|amino|adjustdirection)/.test(a));
    return [...kept, '--amino', '--anysymbol', '--preservecase', '--quiet', '-'];
  }
  return [...extra, '--adjustdirection', '--preservecase', '--quiet', '-'];
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
  const args = mafftArgsFor(opts);

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

/* ---------------------------------------------- stray ends as insertions -- */

/* A gap in the read at least this long separates two blocks of it. */
const BLOCK_BREAK = 10;
/*
 * How much a block has to match to be more than chance: its matches, less two
 * for every mismatch, at least this. Identity alone will not do -- MAFFT
 * searches the whole reference to park a novel end, and short stretches of
 * chance resemblance at 70-80% are easy to find: a random 29-mer came back as
 * blocks of 9 in 11 and 10 in 14. Twelve exact bases is about one in sixteen
 * million, far rarer than anything a plasmid offers by chance, while a real
 * 15-base match after a genuine deletion still clears it.
 */
const STRAY_SCORE = 12;

/** The read's blocks: runs of its bases, split wherever it skips BLOCK_BREAK or more reference. */
function readBlocks(refRow, readRow) {
  const blocks = [];
  let cur = null;
  let skipped = 0;
  for (let c = 0; c < refRow.length; c++) {
    if (readRow[c] === '-') {
      if (refRow[c] !== '-') skipped++;
      continue;
    }
    if (!cur || skipped >= BLOCK_BREAK) {
      cur = { from: c, to: c, bases: 0, compared: 0, same: 0, gapBefore: cur ? skipped : 0 };
      blocks.push(cur);
    }
    skipped = 0;
    cur.to = c;
    cur.bases++;
    if (refRow[c] !== '-') {
      cur.compared++;
      if (refRow[c].toUpperCase() === readRow[c].toUpperCase()) cur.same++;
    }
  }
  return blocks;
}

/**
 * Show a read's novel end as an insertion, not as a stray match far away.
 *
 * MAFFT aligns a read end to end, so an end that is not in the reference at
 * all -- a primer's 5' tail, the insert in a clone, a read running into a
 * vector the map does not have -- still has to go somewhere. It goes wherever
 * it half-matches, across a long gap: a 64-base read whose first 35 bases
 * matched exactly had its other 29 put 82 bp further on, at 48% identity. No
 * MAFFT strategy does better, because paying for an insertion to gain a few
 * matches is never worth it to an aligner.
 *
 * So afterwards: a first or last block of the read that sits across a gap
 * longer than itself, matching no better than chance (STRAY_SCORE), is taken back and laid
 * down as an insertion beside the block it belongs with -- new columns, gapped
 * in every other row. A real deletion keeps its far block, because that block
 * matches.
 *
 * @param {Array<{name: string, sequence: string}>} aligned reference first
 * @returns {Array<{name: string, sequence: string}>} the same rows, tidied
 */
function tidyStrayEnds(aligned) {
  let rows = aligned.map((r) => ({ name: r.name, chars: r.sequence.split('') }));

  /** Insert columns at `at`: the read's bases there, a gap in every other row. */
  const insertColumns = (i, at, bases) => {
    rows = rows.map((r, k) => {
      const insert = k === i ? bases : bases.map(() => '-');
      return { name: r.name, chars: [...r.chars.slice(0, at), ...insert, ...r.chars.slice(at)] };
    });
  };

  for (let i = 1; i < rows.length; i++) {
    for (const end of ['last', 'first']) {
      // Peel stray blocks off this end until the end block is a real match:
      // MAFFT can scatter one novel end across several places, and each is
      // moved in beside its neighbour, so they gather back in read order.
      for (let guard = 0; guard < 50; guard++) {
        const ref = rows[0].chars;
        const read = rows[i].chars;
        const blocks = readBlocks(ref.join(''), read.join(''));
        if (blocks.length < 2) break;
        const stray = end === 'last' ? blocks[blocks.length - 1] : blocks[0];
        const anchor = end === 'last' ? blocks[blocks.length - 2] : blocks[1];
        const gap = end === 'last' ? stray.gapBefore : anchor.gapBefore;
        const score = stray.same - 2 * (stray.compared - stray.same);
        if (gap <= stray.bases || score >= STRAY_SCORE) break;

        // Take the stray bases out, in read order.
        const bases = [];
        for (let c = stray.from; c <= stray.to; c++) {
          if (read[c] !== '-') { bases.push(read[c]); read[c] = '-'; }
        }

        /*
         * Bases that go on matching the reference straight on from the anchor
         * are placed there, not inserted -- MAFFT sometimes leaves the last base
         * of the matching part among the strays.
         */
        const placeNext = (from, step) => {
          for (let c = from; c >= 0 && c < ref.length; c += step) {
            if (ref[c] === '-') continue;
            return read[c] === '-' ? c : -1;
          }
          return -1;
        };
        if (end === 'last') {
          let c = placeNext(anchor.to + 1, 1);
          while (bases.length && c >= 0 && ref[c].toUpperCase() === bases[0].toUpperCase()) {
            read[c] = bases.shift();
            c = placeNext(c + 1, 1);
          }
          if (!bases.length) continue;
          // After the last base the read has, matched or newly placed.
          let at = anchor.to + 1;
          for (let c2 = anchor.to + 1; c2 < read.length && c2 <= stray.from; c2++) if (read[c2] !== '-') at = c2 + 1;
          insertColumns(i, at, bases);
        } else {
          let c = placeNext(anchor.from - 1, -1);
          while (bases.length && c >= 0 && ref[c].toUpperCase() === bases[bases.length - 1].toUpperCase()) {
            read[c] = bases.pop();
            c = placeNext(c - 1, -1);
          }
          if (!bases.length) continue;
          // Before the first base the read has, matched or newly placed.
          let at = anchor.from;
          for (let c2 = anchor.from - 1; c2 >= stray.to && c2 >= 0; c2--) if (read[c2] !== '-') at = c2;
          insertColumns(i, at, bases);
        }
      }
    }
  }
  // Columns the stray bases left behind may now be gaps in every row.
  const keep = rows[0].chars.map((_, c) => rows.some((r) => r.chars[c] !== '-'));
  return rows.map((r) => ({ name: r.name, sequence: r.chars.filter((_, c) => keep[c]).join('') }));
}

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
  /*
   * Past the end of the reference, not merely in a gap in it: bases the read
   * has and the reference lacks, partway along, are an insertion -- which is
   * how a novel end is laid down (tidyStrayEnds) -- and folding one across
   * the origin would make a crossing out of a clone with an insert.
   */
  if (/[^-]/.test(String(referenceRow).slice(last + 1))) return 0;
  let run = 0;
  for (let i = last; i >= 0 && referenceRow[i] === '-'; i--) run++;
  return run;
}

/**
 * How many separate pieces the read was placed in.
 *
 * One is an ordinary read. Two is a read sitting either side of the origin.
 * More than that means MAFFT could not express what the read actually says and
 * scattered it instead -- which is what a deletion spanning the origin looks
 * like against a linear reference, since the read's two halves are in the wrong
 * order to be joined by a gap.
 */
function readRunCount(readRow) {
  let runs = 0;
  let inRun = false;
  for (let i = 0; i < readRow.length; i++) {
    const has = readRow[i] !== '-';
    if (has && !inRun) runs++;
    inRun = has;
  }
  return runs;
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
 * How far round the reference a folded read goes: its covered pieces plus the
 * deletions between them, as foldOntoReference worked them out.
 */
function foldTraversal(fold, refLength) {
  const span = ([from, to]) => (to >= from ? to - from + 1 : refLength - from + to + 1);
  return [...fold.covered, ...(fold.deleted || [])].reduce((sum, range) => sum + span(range), 0);
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
  if (reference.molecule === 'protein') return alignProtein(reference, reads, opts);
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
      /*
       * Both forms are needed. The rotated one goes into the joint alignment,
       * where it reads linearly. The unrotated one is what is contiguous
       * against a doubled reference, which is how a wrapping read gets folded
       * back onto the circle -- rotating it first would split it there too.
       */
      oriented,
      sequence: rotateString(oriented, rotation)
    };
  });

  const aligned = tidyStrayEnds(await runMafft(
    [{ name: 'reference', sequence: refSeq },
      ...prepared.map((p) => ({ name: p.key, sequence: p.sequence }))],
    opts
  ));

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
    /*
     * Two ways a read crosses the origin, and both need folding.
     *
     * One runs off the right-hand end, which is what overhangsEnd sees. The
     * other was rotated to undo the wrap before the joint alignment: it does
     * not dangle, so nothing saw it, and that was the bug. Rotating makes a
     * read linear only in its own frame -- against the reference it is still
     * two pieces, and MAFFT places them as two runs. Where the pieces meet,
     * any base matching both ends can go to either, and the arbitrary choice
     * showed up as a short stretch of reference the read appeared not to
     * cover when it plainly had.
     */
    const wraps = Boolean(prepared[i].rotation);
    const dangles = Boolean(overhangsEnd(pairs[i].referenceRow, pairs[i].readRow));
    /*
     * A third way, and the one that looks least like the others: the read does
     * not cross the origin, the *deletion* does. A clone missing an arc that
     * spans the origin joins two reference stretches whose order is reversed
     * on a linear reference, and no arrangement of gaps can say that -- so
     * MAFFT shreds the read into fragments rather than admitting defeat. A
     * 1,186 bp read came back in eight pieces spread over 2 kb, at 91%
     * identity with 935 gaps, none of it true.
     *
     * Against a doubled reference the two stretches are in order and one gap
     * joins them, which is exactly what folding is for.
     */
    const scattered = readRunCount(pairs[i].readRow) > 2;
    /*
     * And a fourth, which is not about the origin at all: the joint alignment
     * simply put the read in the wrong place. MAFFT aligns every read at once,
     * and a short read among long ones is placed by the company it keeps -- a
     * 20-mer that lands exactly right on its own came back split across two
     * places with fourteen substitutions once four other reads were aligned
     * with it. A read whose placement accounts for less than nine tenths of its
     * own bases gets the same second, pairwise look.
     */
    const explains = (stats) => stats.compared - stats.substitutions;
    const asIs = countDifferences(pairs[i].referenceRow, pairs[i].readRow, { wraps });
    const poor = explains(asIs) < 0.9 * prepared[i].sequence.length;
    if (!wraps && !dangles && !scattered && !poor) continue;
    /*
     * Only a read that fits within one turn. Folding maps every read base to a
     * reference position, so a read longer than the reference would have two
     * bases claiming the same position and the later one would quietly win.
     * A read that long is not a read crossing the origin anyway.
     */
    if (prepared[i].sequence.length > refSeq.length) continue;
    // Tidied the same way as the joint alignment, or a novel end parked on a
    // chance match there would count as "explaining" more of the read and
    // win the comparison below.
    const twice = tidyStrayEnds(await runMafft(
      [{ name: 'reference', sequence: refSeq + refSeq },
        { name: prepared[i].key, sequence: prepared[i].oriented }],
      opts
    ));
    const pair = splitPairs(twice)[0];
    const fold = foldOntoReference(pair.referenceRow, pair.readRow, refSeq.length);
    // Only keep it if it actually placed the read; a read that genuinely
    // belongs nowhere should stay as MAFFT left it rather than be forced on.
    if (!fold.covered.length) continue;
    /*
     * And only if a single read could have produced it. A read is one stretch
     * of one molecule, so walking its pieces in read order -- each piece, and
     * each deletion between them -- can go round the plasmid at most once. A
     * fold that needs more is not a read with deletions; it is a read whose own
     * sequence is not in the reference, stitched together from short chance
     * matches. One 64-base read matching for its first 35 bases came back as
     * three pieces 1.6 kb apart, joined by "deletions" of 2.5 and 2.0 kb, the
     * second running back over the very stretch that matched -- so the part
     * that did match was drawn as deleted. A real deletion, even a large one
     * across the origin, stays well inside one turn.
     */
    if (foldTraversal(fold, refSeq.length) > refSeq.length) continue;

    const candidate = Object.assign(fold, {
      readRow: toSharedColumns(fold.placed, sharedReferenceRow),
      /*
       * MAFFT may turn the read round here even when the joint alignment did
       * not, if anchoring could not orient it. The fold's bases and its
       * readIndex are then those of the reverse complement, and the track has to
       * say so, or its trace and annotations are drawn the wrong way round.
       */
      flipped: pair.flipped
    });

    /*
     * Keep whichever explains more of the read.
     *
     * Not fewer mismatches: a deletion the clone really has is counted as
     * mismatch, and the honest answer -- a 2 kb deletion -- therefore scores
     * far worse than the shredded one that quietly pretends the bases are
     * scattered about. What matters is how much of the read the reference
     * accounts for, so that is what is compared. Ties go to the fold, which is
     * the one that knows what it covered -- but only for a read that crosses
     * the origin or was shredded. One looked at again merely for placing badly
     * has to be strictly better placed: folding drops a read's insertions, so
     * on a tie a clone with a real insertion would lose it from view.
     */
    const asFolded = countDifferences(sharedReferenceRow, candidate.readRow, {
      covered: fold.covered,
      deleted: fold.deleted
    });
    const gain = explains(asFolded) - explains(asIs);
    if (gain > 0 || (gain === 0 && (wraps || dangles || scattered))) folded[i] = candidate;
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
    molecule: 'dna',
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
      // MAFFT may have flipped a read anchoring could not orient -- in the
      // joint alignment, or in the pairwise one if the read was folded.
      const fold = folded[i];
      const flipped = fold ? fold.flipped : pair.flipped;
      const strand = flipped ? -p.strand : p.strand;
      const readRow = fold ? fold.readRow : pair.readRow;
      const referenceRow = fold ? msaReference : pair.referenceRow;
      return {
        name: p.input.name,
        strand,
        anchored: p.anchored,
        offset: p.offset,
        seeds: p.seeds,
        /*
         * Zero once folded, and that is not bookkeeping: the trace follows
         * this. followAlignment flips, then rotates, then reorders by
         * readIndex -- and readIndex now counts along the unrotated read, so
         * rotating first would put the trace out of step with its own letters.
         */
        rotation: fold ? 0 : p.rotation,
        flippedByMafft: flipped,
        // The bases in the order the row holds them: a read MAFFT turned round
        // is its reverse complement there, and has to be here too, or the
        // letters drawn would not be the ones aligned.
        sequence: fold
          ? (fold.flipped ? revComp(p.oriented) : p.oriented)
          : (pair.flipped ? revComp(p.sequence) : p.sequence),
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

/**
 * Put one read back into the shared column space from its own pairwise
 * alignment with the reference.
 *
 * Unlike toSharedColumns, which a fold uses and which drops insertions, this
 * keeps them: the read's inserted residues go into the insertion columns
 * already between those two reference positions, and new columns -- gapped in
 * every other row -- are added if it needs more. Every other row keeps its
 * characters in the same order. The read's old placement is discarded, and
 * columns it alone occupied are dropped.
 *
 * @param {Array<{name: string, sequence: string}>} rows reference first
 * @param {number} k  the read's row
 * @param {string} pairRef  the reference row of the read's pairwise alignment
 * @param {string} pairRead the read row of it
 */
function mergeIntoShared(rows, k, pairRef, pairRead) {
  const ref = rows[0].sequence;
  // Columns of each reference position in the shared rows, and the insertion
  // columns in each slot between them (slot j sits after reference position j;
  // slot -1 is before the first).
  const refCols = [];
  for (let c = 0; c < ref.length; c++) if (ref[c] !== '-') refCols.push(c);
  const L = refCols.length;
  const sharedSlot = (j) => {
    const from = j < 0 ? 0 : refCols[j] + 1;
    const to = j + 1 < L ? refCols[j + 1] : ref.length;
    const cols = [];
    for (let c = from; c < to; c++) cols.push(c);
    return cols;
  };
  // The read in the pairwise alignment: what sits on each reference position,
  // and what it inserts in each slot.
  const readAt = new Array(L).fill('-');
  const inserted = new Map();
  let at = -1;
  for (let c = 0; c < pairRef.length; c++) {
    if (pairRef[c] !== '-') { at++; readAt[at] = pairRead[c]; continue; }
    if (pairRead[c] === '-') continue;
    if (!inserted.has(at)) inserted.set(at, []);
    inserted.get(at).push(pairRead[c]);
  }

  const out = rows.map(() => []);
  const emitSlot = (j) => {
    const cols = sharedSlot(j);
    const mine = inserted.get(j) || [];
    const n = Math.max(cols.length, mine.length);
    for (let t = 0; t < n; t++) {
      rows.forEach((r, i) => {
        if (i === k) out[i].push(t < mine.length ? mine[t] : '-');
        else out[i].push(t < cols.length ? r.sequence[cols[t]] : '-');
      });
    }
  };
  emitSlot(-1);
  for (let j = 0; j < L; j++) {
    rows.forEach((r, i) => out[i].push(i === k ? readAt[j] : r.sequence[refCols[j]]));
    emitSlot(j);
  }
  // The read's old insertion columns may now be gaps in every row.
  const keep = out[0].map((_, c) => out.some((row) => row[c] !== '-'));
  return rows.map((r, i) => ({ name: r.name, sequence: out[i].filter((_, c) => keep[c]).join('') }));
}

/**
 * Align proteins against a protein reference.
 *
 * Everything above that is not a plain MAFFT call exists because of DNA: which
 * strand a read came off, where on a circular plasmid it starts, and how to
 * fold a read that runs past the origin back onto the one turn. None of it has
 * a protein equivalent -- a protein has one direction and two ends -- and some
 * of it is actively wrong here: reverse-complementing a protein turns it into a
 * reversed string of plausible-looking residues and Ns, and folding would move
 * a C-terminal tail onto the N-terminus. So a protein is one MAFFT call, carved
 * into pairs exactly as the reads are, and counted the same way.
 *
 * The tracks keep the shape the DNA ones have -- forward, unrotated, unfolded --
 * so the panel, the viewer and the saved file need no protein case of their own
 * to read them.
 */
async function alignProtein(reference, reads, opts = {}) {
  const refSeq = String(reference.sequence || '').toUpperCase();
  if (!refSeq) throw new Error('The reference has no sequence.');
  if (!reads.length) return { reference, molecule: 'protein', tracks: [] };

  const prepared = reads.map((read, i) => ({
    input: read,
    key: `read${i}`,
    sequence: String(read.sequence || '').toUpperCase()
  }));

  const proteinOpts = Object.assign({}, opts, { molecule: 'protein' });
  let aligned = await runMafft(
    [{ name: 'reference', sequence: refSeq },
      ...prepared.map((p) => ({ name: p.key, sequence: p.sequence }))],
    proteinOpts
  );

  /*
   * A second look for any read the joint alignment placed badly.
   *
   * MAFFT aligns everything at once, and aligns similar reads to each other
   * before the reference, so reads that resemble one another are stacked into
   * the same columns and placed on the reference together. Two variants of a
   * reference's first domain, aligned alongside four of its second, were
   * carried into the second domain with the rest: 44 of 59 residues identical
   * there, against 54 of 58 in the first domain, where each lands aligned on
   * its own. Closer variants fare worse: a read can be split between the two
   * domains, half in each, matching nearly everywhere and gapped by the whole
   * of the other domain in its middle.
   *
   * So a placement is scored by the residues it accounts for less every gapped
   * column -- a read cut in two is badly placed however well each half
   * matches -- and a read scoring under nine tenths of its length is aligned
   * to the reference alone, and moved if that scores strictly better.
   */
  const quality = (refRow, readRow) => {
    const d = countDifferences(refRow, readRow);
    return d.compared - d.substitutions - d.gaps;
  };
  for (let i = 0; i < prepared.length; i++) {
    const length = prepared[i].sequence.length;
    const joint = splitPairs(aligned)[i];
    const asIs = quality(joint.referenceRow, joint.readRow);
    if (asIs >= 0.9 * length) continue;
    const solo = await runMafft(
      [{ name: 'reference', sequence: refSeq }, { name: prepared[i].key, sequence: prepared[i].sequence }],
      proteinOpts
    );
    const pair = splitPairs(solo)[0];
    if (quality(pair.referenceRow, pair.readRow) > asIs) {
      aligned = mergeIntoShared(aligned, i + 1, solo[0].sequence, solo[1].sequence);
    }
  }
  const pairs = splitPairs(aligned);

  return {
    reference,
    molecule: 'protein',
    msa: {
      reference: aligned[0].sequence,
      rows: prepared.map((p, i) => ({ name: p.input.name, sequence: aligned[i + 1].sequence }))
    },
    tracks: prepared.map((p, i) => ({
      name: p.input.name,
      strand: 1,
      // Nothing to anchor, and nothing found missing: true is what keeps every
      // reader of this flag from taking the read for a different sequence.
      anchored: true,
      offset: null,
      seeds: 0,
      rotation: 0,
      flippedByMafft: false,
      sequence: p.sequence,
      referenceRow: pairs[i].referenceRow,
      readRow: pairs[i].readRow,
      covered: null,
      crossesOrigin: false,
      columnOrderSequence: null,
      readIndex: null,
      deleted: null,
      ...countDifferences(pairs[i].referenceRow, pairs[i].readRow)
    }))
  };
}

module.exports = {
  align, alignProtein, mafftArgsFor, anchor, rotateString, rotationFor, splitPairs, countDifferences,
  mutatedCodons, codonPositions, overhangsEnd, foldOntoReference, foldTraversal, toSharedColumns,
  tidyStrayEnds, readBlocks, mergeIntoShared,
  runMafft, parseFasta, toFasta, MISSING_MAFFT, DEFAULT_K
};
