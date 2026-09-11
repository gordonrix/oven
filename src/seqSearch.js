/*
 * Finding a nucleotide or protein sequence across a corpus of GenBank maps.
 *
 * The reverse of primer search: one query, many files, rather than many primers
 * against the one plasmid on screen.
 *
 * Everything here is pure -- no vscode, no filesystem -- so the matching can be
 * tested without a window. Reading files and reporting progress is
 * src/seqSearchPanel.js.
 *
 * Two things make this fast enough to run over thousands of maps:
 *
 *   1. Bases are pulled out of the ORIGIN block by hand rather than by parsing
 *      the file. Measured over 200 real maps, genbankToJson costs 47 ms each
 *      and extractBases costs 0.10 ms -- a search does not need the features,
 *      and the full parse only happens when a result is opened.
 *   2. Fuzzy matching seeds on shared k-mers and extends without gaps, which is
 *      the cheap half of what BLAST does. An indel is not spanned: a hit
 *      containing one comes back as two adjacent hits.
 */
'use strict';

/**
 * How much of the query a fuzzy hit has to span, as a fraction. Half is enough
 * to keep a partial match -- a truncated gene, one end of a cassette -- while
 * cutting the incidental k-mer matches that any large genome supplies.
 */
const DEFAULT_MIN_COVERAGE = 0.5;

/** Default seed length. Long enough to be rare, short enough to seed a 20 bp query. */
const DEFAULT_K = 11;

/** Below this a query is too short to seed; it is searched exactly instead. */
const MIN_FUZZY_QUERY = DEFAULT_K;

const COMPLEMENT = { A: 'T', T: 'A', G: 'C', C: 'G', N: 'N' };

/** The standard genetic code, built once. */
const CODONS = (() => {
  const bases = 'TCAG';
  const acids = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG';
  const table = {};
  let i = 0;
  for (const a of bases) for (const b of bases) for (const c of bases) table[a + b + c] = acids[i++];
  return table;
})();

function revComp(seq) {
  let out = '';
  for (let i = seq.length - 1; i >= 0; i--) out += COMPLEMENT[seq[i]] || 'N';
  return out;
}

/**
 * The bases of a GenBank record, without parsing it.
 *
 * ORIGIN is followed by soft-wrapped lines carrying a position number and six
 * blocks of ten, so everything that is not a letter is noise. A multi-record
 * file stops at the `//` that closes the first record -- searching the rest
 * would report hits at coordinates that mean nothing against the record a
 * click then opens.
 *
 * @returns {string} uppercase bases, or '' when the file has no ORIGIN block
 */
function extractBases(text) {
  const s = String(text || '');
  const at = /^ORIGIN/m.exec(s);
  if (!at) return '';
  let body = s.slice(at.index + at[0].length);
  const end = body.indexOf('\n//');
  if (end >= 0) body = body.slice(0, end);
  return body.replace(/[^a-zA-Z]/g, '').toUpperCase();
}

/**
 * All six reading frames of a nucleotide sequence.
 *
 * Frames are numbered the way a sequence viewer numbers them: +1..+3 read along
 * the given strand from offsets 0..2, and -1..-3 along its reverse complement.
 *
 * @returns {Array<{frame: number, protein: string, offset: number}>}
 *   `offset` is where the frame starts, on its own strand.
 */
function translateFrames(sequence) {
  const seq = String(sequence || '').toUpperCase();
  const out = [];
  for (const strand of [1, -1]) {
    const s = strand === 1 ? seq : revComp(seq);
    for (let offset = 0; offset < 3; offset++) {
      let protein = '';
      for (let i = offset; i + 3 <= s.length; i += 3) protein += CODONS[s.substr(i, 3)] || 'X';
      out.push({ frame: strand * (offset + 1), protein, offset });
    }
  }
  return out;
}

/**
 * Where a run of amino acids sits in nucleotide coordinates.
 *
 * A hit found on a reverse frame was found against the reverse complement, so
 * its coordinates have to be turned back around: position r there is
 * length-1-r here, which also swaps start and end.
 */
function proteinRangeToNucleotide(frame, offset, aaStart, aaLength, sequenceLength) {
  const from = offset + aaStart * 3;
  const to = from + aaLength * 3 - 1;
  if (frame > 0) return { start: from, end: to };
  return { start: sequenceLength - 1 - to, end: sequenceLength - 1 - from };
}

/* ------------------------------------------------------------------ exact -- */

/** Every occurrence of `query` in `target`, as [start, end] pairs. */
function findAll(target, query) {
  const out = [];
  if (!query) return out;
  let at = target.indexOf(query);
  while (at >= 0) {
    out.push(at);
    at = target.indexOf(query, at + 1);
  }
  return out;
}

/* ------------------------------------------------------------------ fuzzy -- */

/**
 * Seeded, ungapped local matches.
 *
 * Each shared k-mer is a seed; the match is extended both ways while the
 * running score holds up, which is the classic ungapped extension. Overlapping
 * seeds in the same diagonal collapse into the one hit they describe, so a long
 * match is reported once rather than once per seed.
 *
 * Scoring is `matches - mismatches`, which is what ranks a long near-perfect
 * hit above a short exact one. Ranking on identity alone inverts that, and a
 * list where a 12 bp coincidence outranks a 900 bp gene is no use.
 *
 * A hit must also cover `minCoverage` of the query. Without that floor a seed
 * that extends nowhere is still a hit at 100% identity, and any megabase target
 * contains every 11-mer several times over: searching 33 bp against E. coli
 * returned dozens of incidental 12-16 bp fragments before this existed. BLAST
 * gets the same effect from the E-value, which needs a lot more machinery to
 * arrive at the same answer.
 *
 * @param {number} minIdentity 0..1, hits below it are dropped
 * @param {number} minCoverage 0..1 of the query length, likewise
 */
function extendSeeds(target, query,
  { k = DEFAULT_K, minIdentity = 0.8, minCoverage = DEFAULT_MIN_COVERAGE, dropOff = 8 } = {}) {
  const hits = [];
  if (query.length < k || target.length < k) return hits;

  const seeds = new Map();               // k-mer -> first position in the query
  for (let i = 0; i + k <= query.length; i++) {
    const kmer = query.substr(i, k);
    if (!seeds.has(kmer)) seeds.set(kmer, i);
  }

  // One hit per diagonal: a diagonal is (target position - query position), so
  // every seed of the same ungapped match shares one.
  const seenDiagonals = new Set();

  for (let t = 0; t + k <= target.length; t++) {
    const q = seeds.get(target.substr(t, k));
    if (q === undefined) continue;
    const diagonal = t - q;
    if (seenDiagonals.has(diagonal)) continue;
    seenDiagonals.add(diagonal);

    let matches = k;
    let mismatches = 0;

    // Backwards, keeping the best point rather than where the score ran out.
    let score = k;
    let best = score;
    let bestT = t;
    let bestQ = q;
    let ti = t - 1;
    let qi = q - 1;
    let backMatches = 0;
    let backMismatches = 0;
    let bestBackMatches = 0;
    let bestBackMismatches = 0;
    while (ti >= 0 && qi >= 0) {
      if (target[ti] === query[qi]) { score++; backMatches++; } else { score--; backMismatches++; }
      if (score > best) {
        best = score;
        bestT = ti;
        bestQ = qi;
        bestBackMatches = backMatches;
        bestBackMismatches = backMismatches;
      }
      if (best - score > dropOff) break;
      ti--;
      qi--;
    }
    matches += bestBackMatches;
    mismatches += bestBackMismatches;

    // Forwards, the same way.
    score = best;
    let bestEndT = t + k - 1;
    let fwdMatches = 0;
    let fwdMismatches = 0;
    let bestFwdMatches = 0;
    let bestFwdMismatches = 0;
    let bestForward = score;
    ti = t + k;
    qi = q + k;
    while (ti < target.length && qi < query.length) {
      if (target[ti] === query[qi]) { score++; fwdMatches++; } else { score--; fwdMismatches++; }
      if (score > bestForward) {
        bestForward = score;
        bestEndT = ti;
        bestFwdMatches = fwdMatches;
        bestFwdMismatches = fwdMismatches;
      }
      if (bestForward - score > dropOff) break;
      ti++;
      qi++;
    }
    matches += bestFwdMatches;
    mismatches += bestFwdMismatches;

    const length = bestEndT - bestT + 1;
    const identity = length ? matches / length : 0;
    if (identity < minIdentity) continue;
    if (length < query.length * minCoverage) continue;

    hits.push({
      start: bestT,
      end: bestEndT,
      queryStart: bestQ,
      length,
      identity,
      score: matches - mismatches
    });
  }
  return hits;
}

/* ----------------------------------------------------------------- search -- */

/**
 * Search one target sequence.
 *
 * @param {string} sequence   the target, uppercase
 * @param {string} query      uppercase; bases for 'dna', residues for 'protein'
 * @param {object} opts       {kind: 'dna'|'protein', exact, minIdentity, minCoverage, k}
 * @returns {Array<object>} hits in the target's own coordinates
 */
function searchSequence(sequence, query, opts = {}) {
  const kind = opts.kind === 'protein' ? 'protein' : 'dna';
  const exact = opts.exact !== false;
  const minIdentity = opts.minIdentity === undefined ? 0.8 : opts.minIdentity;
  const minCoverage = opts.minCoverage === undefined ? DEFAULT_MIN_COVERAGE : opts.minCoverage;
  const k = opts.k || DEFAULT_K;
  const seq = String(sequence || '').toUpperCase();
  const q = String(query || '').toUpperCase().replace(/\s/g, '');
  if (!seq || !q) return [];

  const out = [];

  if (kind === 'dna') {
    for (const strand of [1, -1]) {
      const probe = strand === 1 ? q : revComp(q);
      if (strand === -1 && probe === q) continue;   // palindrome: do not report twice
      if (exact) {
        for (const at of findAll(seq, probe)) {
          out.push({
            start: at, end: at + probe.length - 1, strand,
            length: probe.length, identity: 1, score: probe.length, frame: null
          });
        }
      } else {
        for (const h of extendSeeds(seq, probe, { k, minIdentity, minCoverage })) {
          out.push({
            start: h.start, end: h.end, strand,
            length: h.length, identity: h.identity, score: h.score, frame: null
          });
        }
      }
    }
    return rank(out);
  }

  /*
   * Protein: search each reading frame, then put the coordinates back into
   * nucleotide space so a click selects the right bases.
   *
   * Translating is the expensive half of a protein search -- about 2.3 ms per
   * file, so a couple of seconds across a real corpus -- and it is done afresh
   * every search rather than cached. Six frames is six times the bases, which
   * is over 100 MB for a corpus this size and several hundred for a large one;
   * holding that in the extension host to save two seconds is the wrong trade.
   */
  for (const { frame, protein, offset } of translateFrames(seq)) {
    const found = exact
      ? findAll(protein, q).map((at) => ({
        start: at, end: at + q.length - 1, length: q.length, identity: 1, score: q.length
      }))
      : extendSeeds(protein, q, {
        k: Math.min(k, Math.max(3, Math.floor(q.length / 2))), minIdentity, minCoverage
      });
    for (const h of found) {
      const range = proteinRangeToNucleotide(frame, offset, h.start, h.length, seq.length);
      out.push({
        start: range.start, end: range.end,
        strand: frame > 0 ? 1 : -1,
        frame,
        length: h.length,              // in residues
        identity: h.identity,
        score: h.score
      });
    }
  }
  return rank(out);
}

/** Best first: score, then identity, then position so the order is stable. */
function rank(hits) {
  return hits.sort((a, b) => (b.score - a.score)
    || (b.identity - a.identity)
    || (a.start - b.start));
}

/**
 * Search a whole corpus.
 *
 * @param {Array<{file: string, name: string, sequence: string}>} targets
 * @returns {Array<object>} every hit, best first, each tagged with its file
 */
function searchCorpus(targets, query, opts = {}) {
  const all = [];
  const limit = opts.maxHits || 500;
  for (const target of targets || []) {
    for (const hit of searchSequence(target.sequence, query, opts)) {
      all.push(Object.assign({ file: target.file, name: target.name }, hit));
    }
  }
  return rank(all).slice(0, limit);
}

module.exports = {
  extractBases, translateFrames, proteinRangeToNucleotide,
  searchSequence, searchCorpus, extendSeeds, findAll, revComp, rank,
  DEFAULT_K, MIN_FUZZY_QUERY
};
