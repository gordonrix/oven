/*
 * Codon usage tables, for the Change Amino Acid dialog.
 *
 * Embedded rather than fetched: a webview's content-security policy blocks the
 * network, and these numbers do not change.
 *
 * Source: the Codon Usage Database (https://www.kazusa.or.jp/codon/), Nakamura,
 * Gojobori & Ikemura (2000) Nucleic Acids Res 28:292, built from GenBank. Each
 * entry is a codon, the fraction of its amino acid's codons that it accounts
 * for, and its frequency per thousand codons.
 *
 * Only those two numbers are stored. The amino acid a codon encodes is derived
 * from the genetic code below instead of being repeated per organism, so the
 * two cannot disagree -- and every table was checked against that code, each
 * amino acid's fractions checked to sum to 1, and every codon checked to have
 * been seen at all, before being written here.
 *
 * That last check matters. Kazusa has several E. coli entries and the obvious
 * one, K-12 (taxid 83333), is built from too few CDSs to contain an amber stop:
 * it reports TAG at a fraction and frequency of exactly zero, which reads as
 * "E. coli never uses TAG". W3110 (316407) is the same organism from 4,332
 * CDSs and reports TAG at 0.07 and 0.2 per thousand.
 */
(function () {
  'use strict';

  const BASES = 'TCAG';
  /* The standard code, in TCAG order: index = 16*b1 + 4*b2 + b3. */
  const CODE = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG';

  const THREE_LETTER = {
    A: 'Ala', R: 'Arg', N: 'Asn', D: 'Asp', C: 'Cys', Q: 'Gln', E: 'Glu', G: 'Gly',
    H: 'His', I: 'Ile', L: 'Leu', K: 'Lys', M: 'Met', F: 'Phe', P: 'Pro', S: 'Ser',
    T: 'Thr', W: 'Trp', Y: 'Tyr', V: 'Val',
    /* Stop stays an asterisk in both notations: it is not a residue, and
     * "Stop" in a column of three-letter codes reads as one. */
    '*': '*'
  };

  const FULL_NAME = {
    A: 'Alanine', R: 'Arginine', N: 'Asparagine', D: 'Aspartic acid', C: 'Cysteine',
    Q: 'Glutamine', E: 'Glutamic acid', G: 'Glycine', H: 'Histidine', I: 'Isoleucine',
    L: 'Leucine', K: 'Lysine', M: 'Methionine', F: 'Phenylalanine', P: 'Proline',
    S: 'Serine', T: 'Threonine', W: 'Tryptophan', Y: 'Tyrosine', V: 'Valine',
    '*': 'Stop codon'
  };

  /*
   * The organisms offered, with the Kazusa species id each table came from so
   * the dialog can link back to the exact page rather than to the site.
   */
  const ORGANISMS = [
    { key: 'S. cerevisiae', label: 'Saccharomyces cerevisiae', taxid: 4932 },
    { key: 'E. coli', label: 'Escherichia coli (K-12 W3110)', taxid: 316407 },
    { key: 'H. sapiens', label: 'Homo sapiens', taxid: 9606 },
    { key: 'M. musculus', label: 'Mus musculus', taxid: 10090 }
  ];

  /* Each block is "codon fraction frequency", whitespace separated. */
  const RAW = {
    'S. cerevisiae': `
    TTT 0.59 26.1  TTC 0.41 18.4  TTA 0.28 26.2  TTG 0.29 27.2
    TCT 0.26 23.5  TCC 0.16 14.2  TCA 0.21 18.7  TCG 0.10 8.6
    TAT 0.56 18.8  TAC 0.44 14.8  TAA 0.47 1.1  TAG 0.23 0.5
    TGT 0.63 8.1  TGC 0.37 4.8  TGA 0.30 0.7  TGG 1.00 10.4
    CTT 0.13 12.3  CTC 0.06 5.4  CTA 0.14 13.4  CTG 0.11 10.5
    CCT 0.31 13.5  CCC 0.15 6.8  CCA 0.42 18.3  CCG 0.12 5.3
    CAT 0.64 13.6  CAC 0.36 7.8  CAA 0.69 27.3  CAG 0.31 12.1
    CGT 0.14 6.4  CGC 0.06 2.6  CGA 0.07 3.0  CGG 0.04 1.7
    ATT 0.46 30.1  ATC 0.26 17.2  ATA 0.27 17.8  ATG 1.00 20.9
    ACT 0.35 20.3  ACC 0.22 12.7  ACA 0.30 17.8  ACG 0.14 8.0
    AAT 0.59 35.7  AAC 0.41 24.8  AAA 0.58 41.9  AAG 0.42 30.8
    AGT 0.16 14.2  AGC 0.11 9.8  AGA 0.48 21.3  AGG 0.21 9.2
    GTT 0.39 22.1  GTC 0.21 11.8  GTA 0.21 11.8  GTG 0.19 10.8
    GCT 0.38 21.2  GCC 0.22 12.6  GCA 0.29 16.2  GCG 0.11 6.2
    GAT 0.65 37.6  GAC 0.35 20.2  GAA 0.70 45.6  GAG 0.30 19.2
    GGT 0.47 23.9  GGC 0.19 9.8  GGA 0.22 10.9  GGG 0.12 6.0
  `,
    'E. coli': `
    TTT 0.57 22.2  TTC 0.43 16.5  TTA 0.13 13.8  TTG 0.13 13.6
    TCT 0.15 8.4  TCC 0.15 8.6  TCA 0.12 7.0  TCG 0.15 8.9
    TAT 0.57 16.1  TAC 0.43 12.2  TAA 0.64 2.0  TAG 0.07 0.2
    TGT 0.44 5.1  TGC 0.56 6.4  TGA 0.29 0.9  TGG 1.00 15.2
    CTT 0.10 11.0  CTC 0.10 11.1  CTA 0.04 3.8  CTG 0.50 53.1
    CCT 0.16 7.0  CCC 0.12 5.5  CCA 0.19 8.4  CCG 0.53 23.4
    CAT 0.57 13.0  CAC 0.43 9.8  CAA 0.35 15.4  CAG 0.65 29.0
    CGT 0.38 21.0  CGC 0.40 22.3  CGA 0.06 3.5  CGG 0.10 5.4
    ATT 0.51 30.4  ATC 0.42 25.2  ATA 0.07 4.2  ATG 1.00 27.8
    ACT 0.16 8.8  ACC 0.44 23.5  ACA 0.13 6.9  ACG 0.27 14.4
    AAT 0.45 17.6  AAC 0.55 21.6  AAA 0.76 33.6  AAG 0.24 10.3
    AGT 0.15 8.7  AGC 0.28 16.1  AGA 0.04 2.0  AGG 0.02 1.1
    GTT 0.26 18.2  GTC 0.22 15.3  GTA 0.15 10.9  GTG 0.37 26.3
    GCT 0.16 15.2  GCC 0.27 25.7  GCA 0.21 20.1  GCG 0.36 33.9
    GAT 0.63 32.2  GAC 0.37 19.1  GAA 0.69 39.7  GAG 0.31 18.0
    GGT 0.34 24.7  GGC 0.41 29.8  GGA 0.11 7.9  GGG 0.15 11.0
  `,
    'H. sapiens': `
    TTT 0.46 17.6  TTC 0.54 20.3  TTA 0.08 7.7  TTG 0.13 12.9
    TCT 0.19 15.2  TCC 0.22 17.7  TCA 0.15 12.2  TCG 0.05 4.4
    TAT 0.44 12.2  TAC 0.56 15.3  TAA 0.30 1.0  TAG 0.24 0.8
    TGT 0.46 10.6  TGC 0.54 12.6  TGA 0.47 1.6  TGG 1.00 13.2
    CTT 0.13 13.2  CTC 0.20 19.6  CTA 0.07 7.2  CTG 0.40 39.6
    CCT 0.29 17.5  CCC 0.32 19.8  CCA 0.28 16.9  CCG 0.11 6.9
    CAT 0.42 10.9  CAC 0.58 15.1  CAA 0.27 12.3  CAG 0.73 34.2
    CGT 0.08 4.5  CGC 0.18 10.4  CGA 0.11 6.2  CGG 0.20 11.4
    ATT 0.36 16.0  ATC 0.47 20.8  ATA 0.17 7.5  ATG 1.00 22.0
    ACT 0.25 13.1  ACC 0.36 18.9  ACA 0.28 15.1  ACG 0.11 6.1
    AAT 0.47 17.0  AAC 0.53 19.1  AAA 0.43 24.4  AAG 0.57 31.9
    AGT 0.15 12.1  AGC 0.24 19.5  AGA 0.21 12.2  AGG 0.21 12.0
    GTT 0.18 11.0  GTC 0.24 14.5  GTA 0.12 7.1  GTG 0.46 28.1
    GCT 0.27 18.4  GCC 0.40 27.7  GCA 0.23 15.8  GCG 0.11 7.4
    GAT 0.46 21.8  GAC 0.54 25.1  GAA 0.42 29.0  GAG 0.58 39.6
    GGT 0.16 10.8  GGC 0.34 22.2  GGA 0.25 16.5  GGG 0.25 16.5
  `,
    'M. musculus': `
    TTT 0.44 17.2  TTC 0.56 21.8  TTA 0.07 6.7  TTG 0.13 13.4
    TCT 0.20 16.2  TCC 0.22 18.1  TCA 0.14 11.8  TCG 0.05 4.2
    TAT 0.43 12.2  TAC 0.57 16.1  TAA 0.28 1.0  TAG 0.23 0.8
    TGT 0.48 11.4  TGC 0.52 12.3  TGA 0.49 1.6  TGG 1.00 12.5
    CTT 0.13 13.4  CTC 0.20 20.2  CTA 0.08 8.1  CTG 0.39 39.5
    CCT 0.31 18.4  CCC 0.30 18.2  CCA 0.29 17.3  CCG 0.10 6.2
    CAT 0.41 10.6  CAC 0.59 15.3  CAA 0.26 12.0  CAG 0.74 34.1
    CGT 0.08 4.7  CGC 0.17 9.4  CGA 0.12 6.6  CGG 0.19 10.2
    ATT 0.34 15.4  ATC 0.50 22.5  ATA 0.16 7.4  ATG 1.00 22.8
    ACT 0.25 13.7  ACC 0.35 19.0  ACA 0.29 16.0  ACG 0.10 5.6
    AAT 0.43 15.6  AAC 0.57 20.3  AAA 0.39 21.9  AAG 0.61 33.6
    AGT 0.15 12.7  AGC 0.24 19.7  AGA 0.22 12.1  AGG 0.22 12.2
    GTT 0.17 10.7  GTC 0.25 15.4  GTA 0.12 7.4  GTG 0.46 28.4
    GCT 0.29 20.0  GCC 0.38 26.0  GCA 0.23 15.8  GCG 0.09 6.4
    GAT 0.45 21.0  GAC 0.55 26.0  GAA 0.41 27.0  GAG 0.59 39.4
    GGT 0.18 11.4  GGC 0.33 21.2  GGA 0.26 16.8  GGG 0.23 15.2
  `
  };

  /** The amino acid a codon encodes, or '' if it is not a plain DNA triplet. */
  function translate(codon) {
    const c = String(codon || '').toUpperCase().replace(/U/g, 'T');
    if (c.length !== 3) return '';
    let index = 0;
    for (const base of c) {
      const at = BASES.indexOf(base);
      if (at < 0) return ''; // an ambiguity code -- no single amino acid
      index = index * 4 + at;
    }
    return CODE[index];
  }

  /** Parse a block once, into {codon: {codon, aa, fraction, frequency}}. */
  function parse(text) {
    const parts = String(text).trim().split(/\s+/);
    const table = {};
    for (let i = 0; i < parts.length; i += 3) {
      const codon = parts[i];
      table[codon] = {
        codon,
        aa: translate(codon),
        fraction: Number(parts[i + 1]),
        frequency: Number(parts[i + 2])
      };
    }
    return table;
  }

  const TABLES = {};
  for (const name of Object.keys(RAW)) TABLES[name] = parse(RAW[name]);

  /*
   * The order a genetic-code table is conventionally printed in: T, C, A, G at
   * every position, rather than alphabetical. Textbook tables use U for RNA;
   * this is a DNA editor and the bases it writes are what is shown, so T.
   */
  const ORDER = ['T', 'C', 'A', 'G'];

  /**
   * The 64 codons as the classic table arranges them.
   *
   * `GRID[first][second]` is the four codons of one cell, varying in the third
   * base. Rows are blocks of four by first base, columns are the second base --
   * which puts every synonymous codon in one cell, so the alternatives to a
   * residue are the block it sits in.
   */
  const GRID = ORDER.map((first) =>
    ORDER.map((second) => ORDER.map((third) => first + second + third)));

  /** Where the Kazusa table for an organism lives. */
  function sourceUrl(key) {
    const organism = ORGANISMS.find((o) => o.key === key);
    return organism
      ? `https://www.kazusa.or.jp/codon/cgi-bin/showcodon.cgi?species=${organism.taxid}`
      : 'https://www.kazusa.or.jp/codon/';
  }

  /**
   * A number as the tables print it: no trailing zeros, so a fraction of
   * exactly 1 reads "1" rather than "1.00" and 34.0 per thousand reads "34".
   */
  function num(value) {
    return String(Number(value));
  }

  /**
   * Every codon for an amino acid in one organism, commonest first.
   *
   * Sorted by fraction rather than by frequency: the question the dialog is
   * answering is "which codon should I use for this residue", and that is a
   * choice within the amino acid's own family.
   *
   * @returns {Array<{codon, aa, fraction, frequency}>}
   */
  function codonsFor(organism, aa) {
    const table = TABLES[organism];
    if (!table) return [];
    return Object.values(table)
      .filter((entry) => entry.aa === aa)
      .sort((a, b) => b.fraction - a.fraction || a.codon.localeCompare(b.codon));
  }

  /** One codon's row, or null if the organism or codon is unknown. */
  function lookup(organism, codon) {
    const table = TABLES[organism];
    const c = String(codon || '').toUpperCase().replace(/U/g, 'T');
    return (table && table[c]) || null;
  }

  /** How an amino acid is written, in whichever notation is showing. */
  function label(aa, threeLetter) {
    if (!aa) return '';
    return threeLetter ? (THREE_LETTER[aa] || aa) : aa;
  }

  window.OveCodonUsage = {
    ORGANISMS, TABLES, GRID, ORDER, translate, codonsFor, lookup, label, sourceUrl, num,
    THREE_LETTER, FULL_NAME,
    SOURCE: 'Codon Usage Database (kazusa.or.jp/codon), Nakamura et al. 2000, from GenBank'
  };
})();
