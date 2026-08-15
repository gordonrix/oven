/*
 * Working out which three bases a residue is made of, and rewriting them.
 *
 * Kept apart from the dialog and free of any DOM so it can be tested directly.
 * The whole risk of Change Amino Acid lives in here: an edit that writes the
 * right codon to the wrong bases, or the right bases in the wrong orientation,
 * produces a sequence that still looks plausible and is silently wrong.
 *
 * Two things make that easy to get wrong:
 *
 *   Strand.  OVE gives `codonRange` in ascending sequence coordinates whatever
 *   the strand, but a reverse CDS is *read* as the reverse complement of those
 *   bases. So the codon shown to the user is not what is stored, and a codon
 *   the user picks has to be complemented back before it is written.
 *
 *   The origin.  On a circular sequence a codon can straddle position 0, and
 *   then `codonRange.start > codonRange.end`. Slicing that range gives nothing,
 *   or -- worse -- something of the right length taken from the wrong place.
 */
(function (root, factory) {
  const api = factory(
    typeof module !== 'undefined' && module.exports
      ? require('./cartShared')
      : root.CartShared
  );
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.OveCodonEdit = api;
  }
})(typeof self !== 'undefined' ? self : this, function (shared) {
  'use strict';

  const revComp = shared.revComp;

  /** Is this range written the short way round, i.e. across the origin? */
  function wraps(range) {
    return Boolean(range) && range.start > range.end;
  }

  /**
   * The positions a codon occupies, in the order they are read on the top
   * strand. Three of them, even when the codon straddles the origin.
   */
  function codonPositions(range, sequenceLength) {
    if (!range) return [];
    const out = [];
    if (!wraps(range)) {
      for (let i = range.start; i <= range.end; i++) out.push(i);
      return out;
    }
    for (let i = range.start; i < sequenceLength; i++) out.push(i);
    for (let i = 0; i <= range.end; i++) out.push(i);
    return out;
  }

  /** The bases at those positions, as stored on the top strand. */
  function basesAt(sequence, range) {
    return codonPositions(range, sequence.length).map((i) => sequence[i]).join('').toUpperCase();
  }

  /**
   * What a residue in a translation is made of.
   *
   * @param {string} sequence the plasmid's top strand
   * @param {object} annotation the translation OVE handed the right-click
   * @param {number} aminoAcidIndex which residue, counting from 0
   * @returns {{codon, stored, range, forward, positions, aminoAcid}|null}
   *   `codon` is what the user sees -- already reverse-complemented for a
   *   reverse CDS -- and `stored` is what is actually in the sequence.
   */
  function codonAt(sequence, annotation, aminoAcidIndex) {
    const seq = String(sequence || '').toUpperCase();
    const entry = (annotation && annotation.aminoAcids || [])
      .find((a) => a && a.aminoAcidIndex === aminoAcidIndex);
    if (!entry || !entry.codonRange || !seq.length) return null;

    // `forward` is the field OVE sets on the annotation; `strand` is the older
    // spelling and some sources only carry that one.
    const forward = annotation.forward !== undefined
      ? Boolean(annotation.forward)
      : annotation.strand !== -1;

    const stored = basesAt(seq, entry.codonRange);
    return {
      range: entry.codonRange,
      positions: codonPositions(entry.codonRange, seq.length),
      forward,
      stored,
      codon: forward ? stored : revComp(stored),
      aminoAcid: entry.aminoAcid && entry.aminoAcid.value
    };
  }

  /* One codon either side is what decides the case of an edit. */
  const FLANK = 3;

  /**
   * Which case to write an edit in, so that it stands out from its neighbours.
   *
   * Judged from the codons either side rather than from the bases being
   * replaced. Flipping a codon's own case works until two codons next to each
   * other are edited: the second would be flipped relative to the first, and
   * the pair would end up in opposite cases with neither reading as the edit.
   *
   * Positions outside the sequence are simply not sampled -- an edit at the
   * very start has only a right-hand neighbour to go on, which is one-sided but
   * not ambiguous.
   *
   * @returns {'upper'|'lower'} upper when the neighbours disagree, or when
   *   there is nothing to go on.
   */
  function caseFromFlanks(seq, positions) {
    const first = positions[0];
    const last = positions[positions.length - 1];
    let upper = 0;
    let lower = 0;

    for (let i = 1; i <= FLANK; i++) {
      for (const at of [first - i, last + i]) {
        const ch = at >= 0 && at < seq.length ? seq[at] : '';
        // Only characters that have a case at all: a digit or a gap says
        // nothing either way.
        if (!ch || ch.toUpperCase() === ch.toLowerCase()) continue;
        if (ch === ch.toUpperCase()) upper++;
        else lower++;
      }
    }

    if (upper && !lower) return 'lower';
    if (lower && !upper) return 'upper';
    return 'upper';
  }

  /**
   * Write a chosen codon back into the sequence, cased to stand out.
   *
   * `codon` is in the orientation the user picked it in -- the same one the
   * dialog displays -- so on a reverse CDS it is complemented before it lands.
   *
   * The case is a marker and nothing downstream reads it: an edited codon can
   * be picked out of the sequence at a glance afterwards, which matters when
   * the change is silent or a single base.
   *
   * @returns {string} the whole sequence, with exactly three bases changed.
   */
  function applyCodon(sequence, target, codon) {
    const seq = String(sequence || '');
    const chosen = String(codon || '').toUpperCase().replace(/U/g, 'T');
    if (!target || chosen.length !== 3) return seq;

    // Back to top-strand orientation and top-strand order, which is the order
    // `positions` is in.
    const oriented = target.forward ? chosen : revComp(chosen);
    const toWrite = caseFromFlanks(seq, target.positions) === 'lower'
      ? oriented.toLowerCase()
      : oriented.toUpperCase();

    const out = seq.split('');
    target.positions.forEach((at, i) => { out[at] = toWrite[i]; });
    return out.join('');
  }

  return { codonAt, applyCodon, codonPositions, basesAt, wraps, caseFromFlanks };
});
