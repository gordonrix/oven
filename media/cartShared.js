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

  /*
   * The same floor for a protein, at the same odds.
   *
   * Fifty bases is fifty draws from four letters: a chance perfect match that
   * long is about one in 2^100. A residue is one draw from twenty, worth log2 20
   * = 4.3 bits rather than 2, so the same 2^100 takes 100 / 4.3 = 23.1 residues
   * -- 24, rounded up. Weighting by how often each residue actually occurs gives
   * the same answer. A third of 50, the codon equivalent, would be a floor some
   * hundred million times easier to clear by luck.
   */
  const MIN_COVERED_AA = 24;

  /**
   * How much of an aligned protein is identical, as a label.
   *
   * For a protein, "mismatch" on its own says almost nothing: two homologues are
   * never identical, and it is how far apart they are that you are reading for.
   * Gapped columns count against identity -- a read that dropped residues is
   * not 100% identical to anything -- and the figure is rounded down, so a
   * protein that differs at all can never be shown as 100.0%.
   */
  function identityLabel(read) {
    if (!read) return '';
    const aligned = (read.compared || 0) + (read.gaps || 0);
    if (!aligned) return '';
    const same = (read.compared || 0) - (read.substitutions || 0);
    const pct = Math.floor((1000 * same) / aligned) / 10;
    return `${pct.toFixed(1)}% identical`;
  }

  /* ------------------------------------------------------- molecule type -- */

  /* The residues the sequence parser keeps for a protein. */
  const PROTEIN_LETTERS = 'ACDEFGHIKLMNPQRSTVWYBXZJUO';
  /* IUPAC nucleotide codes, ambiguity codes included. */
  const DNA_LETTERS = 'ACGTURYSWKMBDHVN';

  /**
   * DNA or protein, by the parser's own rule.
   *
   * The sequence parser calls a sequence DNA when more than 90% of it is
   * nucleotide letters -- ambiguity codes included, its "loose" mode -- and
   * this is that rule, so a sequence pasted into the panel is classified exactly
   * as the same sequence read from a file would be. Loose matters: counting only
   * G A T C U, a read that is one-tenth N would be taken for a protein.
   */
  function guessMolecule(seq) {
    const s = String(seq || '').toUpperCase();
    if (!s.length) return 'dna';
    let dna = 0;
    for (let i = 0; i < s.length; i++) if (DNA_LETTERS.includes(s[i])) dna++;
    return dna / s.length > 0.9 ? 'dna' : 'protein';
  }

  /* ---------------------------------------------------- remembered view -- */

  /*
   * The View menu settings kept from one file to the next.
   *
   * How things are drawn, never what is shown: these read the same in any
   * plasmid, so a choice made in one is the one wanted in the next. Features,
   * parts, primers, cut sites and a file's own translations are left out on
   * purpose -- hidden in one file to see past them, they must not open hidden
   * in the next, where they would look as if they were not there. Labels are a
   * separate part of OVE's state, so they have their own list.
   *
   * Here rather than in viewPrefs.js because the host checks what it stores
   * against the same list the editor reports from.
   */
  const VIEW_PREFS = {
    visibility: [
      'aminoAcidNumbers', 'axis', 'axisNumbers',
      'orfs', 'orfTranslations', 'cdsFeatureTranslations',
      'reverseSequence', 'fivePrimeThreePrimeHints', 'dnaColors'
    ],
    labels: ['features', 'parts', 'primers', 'cutsites']
  };

  /**
   * Only the remembered settings, and only true or false: what the host
   * stores and what it applies. Labels go under `labels`.
   */
  function pickViewPrefs(prefs) {
    const out = {};
    const src = prefs || {};
    for (const key of VIEW_PREFS.visibility) {
      if (typeof src[key] === 'boolean') out[key] = src[key];
    }
    const labels = {};
    for (const key of VIEW_PREFS.labels) {
      if (src.labels && typeof src.labels[key] === 'boolean') labels[key] = src.labels[key];
    }
    if (Object.keys(labels).length) out.labels = labels;
    return out;
  }

  /* ------------------------------------------------ pasted sequence tables -- */

  /* Every letter a sequence can hold -- residues include all the IUPAC bases. */
  const SEQUENCE_CHARS = /^[ACDEFGHIKLMNPQRSTVWYBXZJUO*]+$/;
  const HEADER_SEQUENCE = /^(seq|sequence|sequences|bases|dna|protein|aa|residues)$/i;
  const HEADER_NAME = /^(name|names|id|label|primer|oligo)$/i;

  /** The letters of a cell, with the spacing and numbering pasted sequence carries. */
  const letters = (cell) => String(cell || '').replace(/[\s\d]/g, '').toUpperCase();
  const looksLikeSequence = (cell) => {
    const l = letters(cell);
    return l.length >= 5 && SEQUENCE_CHARS.test(l);
  };

  /** Split a line into cells: tabs first (a spreadsheet), then commas (a CSV). */
  function cellsOf(line, sep) {
    if (sep === '\t') return line.split('\t').map((c) => c.trim());
    // A quoted CSV cell may hold the separator; nothing in a name/sequence
    // table needs more CSV than that.
    const out = [];
    let cur = '';
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') { quoted = !quoted; continue; }
      if (ch === ',' && !quoted) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  /**
   * Read pasted text as name/sequence pairs.
   *
   * What gets pasted, in the order it is recognised:
   *
   *   FASTA                  ">name" lines, each followed by its sequence
   *   a spreadsheet's rows   tab-separated, which is what Excel and Sheets copy;
   *                          or comma-separated, as from a CSV
   *   "name sequence" lines  two words to a line, the second a sequence
   *   one sequence, wrapped  a GenBank ORIGIN block, numbered, or lines all
   *                          the same length but the last
   *   a column of sequences  one to a line, no names
   *
   * In a table the sequence is whichever column looks most like one, so the
   * columns can come in either order and a spreadsheet's extra columns -- a
   * length, a note -- are ignored; the name is the first other column with
   * anything in it. A header row ("Name", "Sequence") is dropped. Sequences
   * come back as pasted: checking their letters is the host's job, against the
   * reference they have to align to.
   *
   * @returns {Array<{name: string, sequence: string}>}
   */
  function parseSequenceTable(text) {
    const raw = String(text || '').replace(/\r\n?/g, '\n');
    const lines = raw.split('\n').filter((l) => l.trim());
    if (!lines.length) return [];

    if (lines[0].trim().startsWith('>')) {
      const out = [];
      for (const line of lines) {
        if (line.trim().startsWith('>')) out.push({ name: line.trim().slice(1).trim(), sequence: '' });
        else if (out.length) out[out.length - 1].sequence += line.trim();
      }
      return out;
    }

    const sep = lines.some((l) => l.includes('\t')) ? '\t'
      : (lines.every((l) => l.includes(',')) ? ',' : null);
    if (sep) {
      const rows = lines.map((l) => cellsOf(l, sep));
      const width = Math.max(...rows.map((r) => r.length));
      // The sequence column: the most sequence-like cells, then the longest.
      let seqCol = 0;
      let best = [-1, -1];
      for (let c = 0; c < width; c++) {
        const cells = rows.map((r) => r[c] || '');
        const score = [cells.filter(looksLikeSequence).length,
          cells.reduce((a, cell) => a + letters(cell).length, 0)];
        if (score[0] > best[0] || (score[0] === best[0] && score[1] > best[1])) { best = score; seqCol = c; }
      }
      /*
       * The name: the first other column holding words rather than only
       * numbers -- a row number or a length is not a name -- or failing that,
       * the first other column with anything in it.
       */
      const nameCol = (() => {
        const others = [...Array(width).keys()].filter((c) => c !== seqCol &&
          rows.some((r) => (r[c] || '').trim()));
        const wordy = others.find((c) => rows.slice(1).some((r) => /[^\d\s.,-]/.test(r[c] || '')) ||
          (rows.length === 1 && /[^\d\s.,-]/.test(rows[0][c] || '')));
        return wordy !== undefined ? wordy : (others.length ? others[0] : -1);
      })();
      const pairs = rows.map((r) => ({
        name: nameCol >= 0 ? (r[nameCol] || '').trim() : '',
        sequence: (r[seqCol] || '').trim()
      }));
      const first = pairs[0];
      if (first && (HEADER_SEQUENCE.test(first.sequence) || HEADER_NAME.test(first.name) ||
          (!looksLikeSequence(first.sequence) && pairs.length > 1))) {
        pairs.shift();
      }
      return pairs.filter((p) => p.name || p.sequence);
    }

    // Two words to a line, the second a sequence: "T7 TAATACGACTCACTATAGGG".
    const words = lines.map((l) => l.trim().split(/\s+/));
    if (words.every((w) => w.length === 2 && looksLikeSequence(w[1]) && !/^\d+$/.test(w[0]))) {
      return words.map(([name, sequence]) => ({ name, sequence }));
    }

    // One sequence, wrapped: numbered like a GenBank ORIGIN block, or every
    // line but the last the same length.
    const numbered = lines.every((l) => /^\s*\d+\s/.test(l));
    const widths = lines.map((l) => letters(l).length);
    const wrapped = lines.length > 1 && widths[0] >= 40 &&
      widths.slice(0, -1).every((w) => w === widths[0]) && widths[widths.length - 1] <= widths[0];
    if (numbered || wrapped) return [{ name: '', sequence: lines.map((l) => l.trim()).join(' ') }];

    return lines.map((l) => ({ name: '', sequence: l.trim() }));
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
    alignmentVerdict, MIN_COVERED_BP, MIN_COVERED_AA, identityLabel,
    guessMolecule, PROTEIN_LETTERS, DNA_LETTERS, parseSequenceTable,
    VIEW_PREFS, pickViewPrefs
  };
});
