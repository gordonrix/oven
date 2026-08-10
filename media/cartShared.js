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

  return { revComp, deriveBases, wrapsOrigin, normalizeSeqKey };
});
