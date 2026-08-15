/*
 * Sequence helpers shared by the extension host and the OVE webview.
 *
 * This file is BOTH require()d from src/ and <script src>-included into the
 * webview, so it must stay dependency-free and must never require('vscode').
 * Having one implementation is the point: if the host and the webview derived
 * primer sequences differently, the cart would disagree with the editor about
 * what you are ordering.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.CartShared = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COMPLEMENT = {
    A: 'T', C: 'G', G: 'C', T: 'A', U: 'A', N: 'N',
    R: 'Y', Y: 'R', S: 'S', W: 'W', K: 'M', M: 'K',
    B: 'V', V: 'B', D: 'H', H: 'D'
  };

  function revComp(seq) {
    if (!seq) return '';
    let out = '';
    for (let i = seq.length - 1; i >= 0; i--) {
      const c = seq[i].toUpperCase();
      out += COMPLEMENT[c] || 'N';
    }
    return out;
  }

  /**
   * Pull an annotation's own 5'->3' sequence out of the parent sequence.
   *
   * GenBank primer_bind features carry coordinates, not bases: only about 8%
   * of the ones in a real plasmid library have a /Sequence qualifier. So the
   * sequence is reconstructed here from start/end/strand, and the result is
   * uppercased because GenBank ORIGIN blocks are lowercase.
   *
   * start/end are 0-based inclusive, matching @teselagen/bio-parsers output.
   * A circular annotation that crosses the origin has end < start and wraps.
   */
  function deriveBases(sequence, start, end, strand, circular) {
    if (!sequence || typeof start !== 'number' || typeof end !== 'number') return '';
    const len = sequence.length;
    if (!len) return '';

    let raw;
    if (end >= start) {
      raw = sequence.slice(start, end + 1);
    } else if (circular) {
      raw = sequence.slice(start) + sequence.slice(0, end + 1);
    } else {
      // Malformed on a linear sequence; take what makes sense rather than throw.
      raw = sequence.slice(end, start + 1);
    }

    raw = raw.toUpperCase();
    return strand === -1 ? revComp(raw) : raw;
  }

  function wrapsOrigin(start, end, circular) {
    return Boolean(circular) && typeof start === 'number' && typeof end === 'number' && end < start;
  }

  /** Cart identity key. Two annotations with the same bases are one oligo to order. */
  function normalizeSeqKey(seq) {
    return String(seq || '').replace(/\s+/g, '').toUpperCase();
  }

  /* ------------------------------------------------- alignment verdicts -- */

  /*
   * A perfect stretch shorter than this is not evidence of anything -- a few
   * dozen bases will match somewhere by luck, and calling that a partial match
   * would dress up noise as a result.
   */
  const MIN_COVERED_BP = 50;

  /**
   * Reduce an aligned read to one of three verdicts.
   *
   *   match          perfect, and covers the reference end to end
   *   partial match  perfect over the window it covers
   *   mismatch       any substitution, insertion or deletion at all
   *
   * The distinction that matters is between "verified" and "verified as far as
   * it goes". A Sanger read covers a window, so it can only ever reach partial
   * match; claiming a plain "match" would say the whole construct was checked.
   * Only whole-plasmid sequencing turns the reference green. One wrong base is
   * one wrong base whether the read spans 800 bp or the lot, so any real
   * difference is a mismatch regardless of how much was covered.
   *
   * @param {{mismatches: number, compared: number}} read
   *   `compared` is how many reference positions the read actually spoke to.
   * @param {number} referenceLength
   * @returns {'match'|'partial match'|'mismatch'|null} null when not yet aligned
   */
  function alignmentVerdict(read, referenceLength, minCovered) {
    if (!read || read.mismatches === undefined || read.mismatches === null) return null;
    const floor = minCovered === undefined ? MIN_COVERED_BP : minCovered;
    const covered = read.compared || 0;

    // Substitutions and gapped columns are both counted in `mismatches`, so
    // this is the "any indel or mismatch" case in one test.
    if (read.mismatches > 0) return 'mismatch';
    if (covered < floor) return 'mismatch';
    // An insertion or deletion would have failed the test above, so a read that
    // reaches here and spans the reference has matched it exactly.
    if (referenceLength && covered === referenceLength) return 'match';
    return 'partial match';
  }

  /* ---------------------------------------------- origin-spanning joins -- */

  /**
   * True when an annotation's `locations` say nothing its wrapped start/end
   * does not already say.
   *
   * GenBank spells an origin-spanning feature as join(4113..4130,1..17), and
   * the parser turns that into BOTH a wrapped start/end (4112 -> 16) and a
   * two-entry `locations` array holding those same two halves. OVE maps an
   * annotation to rows once for its own span and again for each location, so
   * such a feature is drawn twice, stacked, in every row it touches.
   *
   * A genuine multi-exon join is not this: its halves do not butt against the
   * origin, so it fails this test and keeps its locations.
   */
  function locationsRestateOrigin(ann, sequenceLength) {
    if (!ann || !Array.isArray(ann.locations) || ann.locations.length !== 2) return false;
    if (typeof ann.start !== 'number' || typeof ann.end !== 'number') return false;
    if (ann.end >= ann.start) return false; // does not wrap
    if (!(sequenceLength > 0)) return false;

    // Order-insensitive; the parser's ordering is not guaranteed.
    const [tail, head] = ann.locations[0].start === 0
      ? [ann.locations[1], ann.locations[0]]
      : [ann.locations[0], ann.locations[1]];
    return Boolean(tail && head) &&
      tail.start === ann.start && tail.end === sequenceLength - 1 &&
      head.start === 0 && head.end === ann.end;
  }

  const WRAPPABLE = ['features', 'primers', 'parts'];

  function eachAnnotation(sequenceData, fn) {
    if (!sequenceData || typeof sequenceData.sequence !== 'string') return 0;
    const len = sequenceData.sequence.length;
    let changed = 0;
    WRAPPABLE.forEach((kind) => {
      const group = sequenceData[kind];
      if (!group) return;
      Object.keys(group).forEach((id) => { if (fn(group[id], len)) changed++; });
    });
    return changed;
  }

  /**
   * Strip those redundant locations from every annotation type, in place.
   *
   * Kept here rather than patched into the OVE bundle so that a real spliced
   * join still renders per-exon, and so the host and the webview cannot end up
   * disagreeing about what a feature covers.
   *
   * This is a DISPLAY-ONLY transform. The GenBank writer emits join(...) from
   * `locations` and falls back to a non-standard "4113..17" without them, so
   * anything on its way back to disk must go through restoreWrapLocations
   * first -- otherwise saving a plasmid would quietly rewrite valid joins into
   * something other tools may not read.
   *
   * @returns {number} how many annotations were changed.
   */
  function dropRedundantWrapLocations(sequenceData) {
    return eachAnnotation(sequenceData, (ann, len) => {
      if (!locationsRestateOrigin(ann, len)) return false;
      delete ann.locations;
      return true;
    });
  }

  /**
   * The inverse: give every origin-spanning annotation back the two locations
   * that make the writer emit join(...).
   *
   * Applied to anything that wraps, not only to what we stripped, so a primer
   * drawn across the origin inside the editor is written out as a proper join
   * as well.
   *
   * @returns {number} how many annotations were changed.
   */
  function restoreWrapLocations(sequenceData) {
    return eachAnnotation(sequenceData, (ann, len) => {
      if (!ann || typeof ann.start !== 'number' || typeof ann.end !== 'number') return false;
      if (ann.end >= ann.start) return false;
      if (Array.isArray(ann.locations) && ann.locations.length) return false;
      ann.locations = [
        { start: ann.start, end: len - 1 },
        { start: 0, end: ann.end }
      ];
      return true;
    });
  }

  /* ------------------------------------------------------------------ Tm -- */

  /*
   * NEB Q5 nearest-neighbour melting temperature (SantaLucia 1998), ported
   * from tm_neb_q5() in the user's gibson_planner.py so the extension agrees
   * with the pipeline their existing primers were designed against.
   *
   * It lives here, in the dual-use module, because both sides need it: the
   * host computes Tm for cart items and search hits, and the webview computes
   * it live for the current selection.
   *
   * Deliberate divergence from the Python, which raises on short or
   * degenerate input: that would abort a cart add or blank the whole editor,
   * so these return null and the caller renders a dash.
   */
  const NN_R = 1.987;
  const NN_TERM_DS = { g: -2.8, a: 4.1, t: 4.1, c: -2.8 };
  const NN_TERM_DH = { g: 0.1, a: 2.3, t: 2.3, c: 0.1 };
  const NN_DS = {
    gg: -19.9, ga: -22.2, gt: -22.4, gc: -27.2,
    ag: -21.0, aa: -22.2, at: -20.4, ac: -22.4,
    tg: -22.7, ta: -21.3, tt: -22.2, tc: -22.2,
    cg: -27.2, ca: -22.7, ct: -21.0, cc: -19.9
  };
  const NN_DH = {
    gg: -8.0, ga: -8.2, gt: -8.4, gc: -10.6,
    ag: -7.8, aa: -7.9, at: -7.2, ac: -8.4,
    tg: -8.5, ta: -7.2, tt: -7.9, tc: -8.2,
    cg: -10.6, ca: -8.5, ct: -7.8, cc: -8.0
  };
  // NEB Q5 reaction conditions, matching the Python defaults.
  const NA = 0.05;
  const MG = 0.0015;
  const PRIMER_TOTAL = 2e-7;

  /** @returns {number|null} Tm in °C, or null for <2 bases or any non-ACGT. */
  function tmNebQ5(seq, opts) {
    const o = opts || {};
    const na = o.na === undefined ? NA : o.na;
    const mg = o.mg === undefined ? MG : o.mg;
    const primerTotal = o.primerTotal === undefined ? PRIMER_TOTAL : o.primerTotal;

    const s = String(seq || '').trim().toLowerCase();
    if (s.length < 2) return null;
    if (!/^[acgt]+$/.test(s)) return null;

    let ds = 0;
    let dh = 0;
    ds += 0.368 * (s.length - 1) * Math.log(na + mg * 140);
    ds += NN_TERM_DS[s[0]] + NN_TERM_DS[s[s.length - 1]];
    dh += NN_TERM_DH[s[0]] + NN_TERM_DH[s[s.length - 1]];
    for (let i = 0; i < s.length - 1; i++) {
      const pair = s.slice(i, i + 2);
      ds += NN_DS[pair];
      dh += NN_DH[pair];
    }
    return (1000 * dh) / (ds + NN_R * Math.log(primerTotal / 2)) - 273.15;
  }

  /*
   * Shortest oligo the nearest-neighbour model is meaningful for.
   *
   * A guide for callers, not a limit applied here: this function is a faithful
   * port of the reference implementation the primer pipeline designs against,
   * and it stays that way down to a dinucleotide so the two can be compared.
   * The model is two-state, though, and below this length the initiation terms
   * swamp the stacking terms -- it reads -0.5 C at 6 nt and -161 C at 2. Any UI
   * showing a Tm should decline rather than print that.
   */
  const MIN_TM_BP = 8;

  /** @returns {number|null} GC fraction 0..1, or null when there is nothing to count. */
  function gcFraction(seq) {
    const s = String(seq || '');
    if (!s.length) return null;
    const gc = (s.match(/[gcGC]/g) || []).length;
    return gc / s.length;
  }

  return {
    revComp, deriveBases, wrapsOrigin, normalizeSeqKey, tmNebQ5, gcFraction, MIN_TM_BP,
    locationsRestateOrigin, dropRedundantWrapLocations, restoreWrapLocations,
    alignmentVerdict, MIN_COVERED_BP
  };
});
