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
   * Melting temperature, ported from Teselagen's `calculateNebTm`
   * (packages/sequence-utils in github.com/TeselaGen/tg-oss, MIT).
   *
   * This replaced a local nearest-neighbour implementation that had the GC
   * dinucleotide's enthalpy and entropy wrong -- it carried CG's values
   * (-10.6 / -27.2) instead of GC's (-9.8 / -24.4), so it could not tell
   * GCGCGC... from CGCGCG... and read 12 C low on a GC-alternating 20-mer.
   *
   * Ported rather than called through the editor bundle because the extension
   * host needs it too, for the cart and for primer search, and one
   * implementation is the only way the status bar and the cart can be
   * guaranteed to agree.
   *
   * Note this is the NEB model as Teselagen implements it: a monovalent salt
   * correction applied to 1/Tm, no Mg2+ term, and R*ln(Ct) rather than
   * R*ln(Ct/2).
   */
  const NEB_R = 1.987;
  const NEB_KELVIN = 273.15;

  /* SantaLucia 1998 unified parameters, keyed by duplex. */
  const NEB_DH = {
    'AA/TT': -7.9, 'AT/TA': -7.2, 'TA/AT': -7.2, 'CA/GT': -8.5, 'GT/CA': -8.4,
    'CT/GA': -7.8, 'GA/CT': -8.2, 'CG/GC': -10.6, 'GC/CG': -9.8, 'GG/CC': -8,
    'TT/AA': -7.9, 'TG/AC': -8.5, 'AC/TG': -8.4, 'AG/TC': -7.8, 'TC/AG': -8.2,
    'CC/GG': -8, initGC: 0.1, initAT: 2.3
  };
  const NEB_DS = {
    'AA/TT': -22.2, 'AT/TA': -20.4, 'TA/AT': -21.3, 'CA/GT': -22.7, 'GT/CA': -22.4,
    'CT/GA': -21, 'GA/CT': -22.2, 'CG/GC': -27.2, 'GC/CG': -24.4, 'GG/CC': -19.9,
    'TT/AA': -22.2, 'TG/AC': -22.7, 'AC/TG': -22.4, 'AG/TC': -21, 'TC/AG': -22.2,
    'CC/GG': -19.9, initGC: -2.8, initAT: 4.1
  };

  /**
   * @param {string} seq single-stranded DNA
   * @param {{monovalentCationConc?: number, primerConc?: number}} [opts]
   * @returns {number|null} Tm in Celsius, or null for anything unusable --
   *   degenerate bases, or too short to have a single dimer.
   */
  function nebTm(seq, opts) {
    const o = opts || {};
    const mono = o.monovalentCationConc === undefined ? 0.05 : o.monovalentCationConc;
    const primerConc = o.primerConc === undefined ? 5e-7 : o.primerConc;

    const s = String(seq || '').trim().toUpperCase();
    if (s.length < 2 || /[^ATGC]/.test(s)) return null;

    let dh = 0;
    let ds = 0;
    for (let i = 0; i < s.length; i++) {
      if (i === 0 || i === s.length - 1) {
        const gc = s[i] === 'G' || s[i] === 'C';
        dh += gc ? NEB_DH.initGC : NEB_DH.initAT;
        ds += gc ? NEB_DS.initGC : NEB_DS.initAT;
      }
      if (i < s.length - 1) {
        const dimer = s[i] + s[i + 1];
        const duplex = `${dimer}/${revComp(dimer).split('').reverse().join('')}`;
        if (NEB_DH[duplex] === undefined) return null;
        dh += NEB_DH[duplex];
        ds += NEB_DS[duplex];
      }
    }

    const tm = (dh * 1000) / (ds + NEB_R * Math.log(primerConc)) - NEB_KELVIN;
    if (!mono) return tm;

    // Owczarzy-style monovalent correction, applied to 1/Tm.
    const lnMono = Math.log(mono);
    const gcFrac = ((s.match(/[GC]/g) || []).length / s.length);
    const correction = (4.29 * gcFrac - 3.95) * 1e-5 * lnMono + Math.pow(9.4, -6) * lnMono * lnMono;
    return 1 / (1 / (tm + NEB_KELVIN) + correction) - NEB_KELVIN;
  }

  /** @returns {number|null} GC fraction 0..1, or null when there is nothing to count. */
  function gcFraction(seq) {
    const s = String(seq || '');
    if (!s.length) return null;
    const gc = (s.match(/[gcGC]/g) || []).length;
    return gc / s.length;
  }

  return {
    revComp, deriveBases, wrapsOrigin, normalizeSeqKey, nebTm, gcFraction,
    locationsRestateOrigin, dropRedundantWrapLocations, restoreWrapLocations,
    alignmentVerdict, MIN_COVERED_BP
  };
});
