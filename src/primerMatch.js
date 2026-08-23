/*
 * Finds primers from an inventory that bind a plasmid, exact matches only.
 *
 * Anchored on the 3' end rather than matching whole sequences, because a third
 * of the reference inventory carries a 5' overhang that is deliberately absent
 * from the template -- a Gibson tail, a restriction site, a barcode. Those
 * primers still bind; only their 3' portion anneals. Whole-string matching
 * would miss every one of them.
 *
 * Case is NOT used to find the overhang. The convention is unreliable in real
 * data: of 1308 reference primers, 352 write the tail lowercase, 34 do the
 * opposite, and 777 are uniformly uppercase. So the annealing length is
 * measured against the template instead -- anchor on the last k bases of the
 * 3' end, then walk 5' for as long as the bases keep agreeing.
 *
 * Cost is one pass to index the plasmid plus one hash lookup per primer per
 * strand: ~2 ms to index a 10 kb plasmid and ~2 ms to scan all 1308 primers.
 */
'use strict';

const { revComp } = require('../media/cartShared');
const { nebTm } = require('./tm');

const DEFAULT_K = 12;
const DEFAULT_MIN_ANNEAL = 15;

/*
 * Ceiling on base-comparison steps for one search.
 *
 * Cost is normally trivial -- a few thousand steps for a real plasmid. But it
 * scales with (anchor occurrences x extension length), and a low-complexity
 * tract makes both large at once: a poly-A linker gives an all-A anchor
 * hundreds of positions, each of which then extends through the whole tract.
 * A synthetic fully-periodic sequence took 23 s before this cap existed. The
 * budget bounds the pathological case while sitting orders of magnitude above
 * anything real, and exceeding it reports `truncated` rather than hanging.
 */
const DEFAULT_MAX_WORK = 5e6;

/**
 * k-mer position index over the plasmid.
 *
 * For a circular sequence the first (maxPrimerLen - 1) bases are appended so a
 * primer spanning the origin is found by the same linear scan; positions are
 * taken modulo the true length on the way out.
 */
function buildIndex(sequence, circular, maxPrimerLen, k) {
  const K = k || DEFAULT_K;
  const seq = String(sequence || '').toUpperCase();
  const n = seq.length;
  if (!n) return { T: '', idx: new Map(), n: 0, k: K, circular: false };

  const padLen = circular ? Math.max(0, Math.min((maxPrimerLen || 0) - 1, n - 1)) : 0;
  const T = padLen ? seq + seq.slice(0, padLen) : seq;

  const idx = new Map();
  for (let i = 0; i + K <= T.length; i++) {
    const kmer = T.substr(i, K);
    const at = idx.get(kmer);
    if (at) at.push(i);
    else idx.set(kmer, [i]);
  }
  return { T, idx, n, k: K, circular: Boolean(circular) };
}

/** Is position p inside [start, end], honouring an origin-spanning window? */
function inWindow(p, start, end) {
  if (start <= end) return p >= start && p <= end;
  return p >= start || p <= end; // window wraps the origin
}

/**
 * @param {object} index from buildIndex
 * @param {Array<{name,sequence,extra}>} entries inventory primers
 * @param {object} [opts] minAnneal, selection {start,end} (0-based inclusive), maxHits
 * @returns {{hits: object[], scanned: number, skipped: number, truncated: boolean}}
 */
function search(index, entries, opts) {
  const o = opts || {};
  const { T, idx, n, k: K } = index;
  const minAnneal = Math.max(o.minAnneal || DEFAULT_MIN_ANNEAL, K);
  const maxHits = o.maxHits || Infinity;
  const sel = o.selection && o.selection.start >= 0 && o.selection.end >= 0 ? o.selection : null;

  const maxWork = o.maxWork || DEFAULT_MAX_WORK;

  const hits = [];
  const seen = new Set();
  let scanned = 0;
  let skipped = 0;
  let truncated = false;
  let work = 0;

  for (const entry of entries || []) {
    const S = String(entry.sequence || '').replace(/\s+/g, '').toUpperCase();
    // Degenerate bases have no exact match by definition; short ones cannot be anchored.
    if (S.length < K || /[^ACGT]/.test(S)) { skipped++; continue; }
    scanned++;

    for (const strand of [1, -1]) {
      // Q is the primer written along the top strand. Its own 3' end is Q's
      // right edge when forward, and Q's left edge when reverse.
      const Q = strand === 1 ? S : revComp(S);
      const anchor = strand === 1 ? Q.slice(Q.length - K) : Q.slice(0, K);
      const positions = idx.get(anchor);
      if (!positions) continue;

      work += positions.length;
      if (work > maxWork) { truncated = true; break; }

      for (const at of positions) {
        let anneal = K;
        if (strand === 1) {
          let q = Q.length - K - 1;
          let t = at - 1;
          while (q >= 0 && t >= 0 && Q[q] === T[t]) { anneal++; q--; t--; work++; }
        } else {
          let q = K;
          let t = at + K;
          while (q < Q.length && t < T.length && Q[q] === T[t]) { anneal++; q++; t++; work++; }
        }
        if (anneal < minAnneal) continue;

        // Top-strand span of the annealing footprint, and the primer's own 3' base.
        const leftT = strand === 1 ? at + K - anneal : at;
        const rightT = strand === 1 ? at + K - 1 : at + anneal - 1;
        const start = ((leftT % n) + n) % n;
        const end = rightT % n;
        const threePrime = strand === 1 ? end : start;

        // A selection filters on where the primer's 3' end lands. The match is
        // allowed to run outside the window -- that is the whole point of
        // scoping by 3' end rather than by containment.
        if (sel && !inWindow(threePrime, sel.start, sel.end)) continue;

        const key = `${entry.name}|${strand}|${threePrime}`;
        if (seen.has(key)) continue; // duplicate inventory rows land here
        seen.add(key);

        if (hits.length >= maxHits) { truncated = true; break; }

        const annealSeq = strand === 1 ? Q.slice(Q.length - anneal) : Q.slice(0, anneal);
        const tm = nebTm(annealSeq);
        hits.push({
          name: entry.name,
          // Every non-name, non-sequence cell from the row, keyed by header.
          // Which of them the table draws is the user's choice, made in the
          // webview, so the host sends them all rather than guessing.
          extra: entry.extra || {},
          sequence: entry.sequence,          // original case, as ordered
          strand,
          anneal,
          annealSeq,
          overhang: S.length - anneal,       // 0 means the whole primer matched
          start,
          end,
          threePrime,
          wraps: end < start,
          tm: tm === null ? null : Math.round(tm * 10) / 10
        });
      }
      if (truncated) break;
    }
    if (truncated) break;
  }

  // Along the plasmid, cleanest variant of a shared site first.
  hits.sort((a, b) => a.threePrime - b.threePrime || a.overhang - b.overhang ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { hits, scanned, skipped, truncated, work };
}

/** Convenience wrapper: index and search in one call. */
function searchPlasmid(sequence, circular, entries, opts) {
  const maxPrimerLen = (entries || []).reduce(
    (m, e) => Math.max(m, String(e.sequence || '').length), 0);
  const index = buildIndex(sequence, circular, maxPrimerLen, (opts || {}).k);
  return search(index, entries, opts);
}

module.exports = { buildIndex, search, searchPlasmid, inWindow, DEFAULT_K, DEFAULT_MIN_ANNEAL };
