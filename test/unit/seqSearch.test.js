'use strict';

/*
 * Searching a corpus of maps for a nucleotide or protein sequence.
 *
 * The parts worth pinning are the ones that are quietly wrong rather than
 * loudly broken: coordinates that come back off by a frame, a reverse-strand
 * hit reported against the wrong end of the sequence, and a ranking that puts a
 * short coincidence above a long gene.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  extractBases, translateFrames, searchSequence, searchCorpus, revComp
} = require('../../src/seqSearch');

/* --- pulling bases out of a GenBank file --------------------------------- */

const RECORD = [
  'LOCUS       demo        30 bp ds-DNA     circular',
  'FEATURES             Location/Qualifiers',
  '     misc_feature    1..10',
  '                     /label="not sequence"',
  'ORIGIN',
  '        1 acgtacgtaa ggccttacgt',
  '       21 tgcattagca',
  '//'
].join('\n');

test('bases come from the ORIGIN block, without the numbers or the header', () => {
  // The header and the feature table both contain letters; only what follows
  // ORIGIN is sequence.
  assert.strictEqual(extractBases(RECORD), 'ACGTACGTAAGGCCTTACGTTGCATTAGCA');
});

test('a second record is left alone', () => {
  /*
   * Its coordinates would mean nothing against the record a click then opens,
   * so the scan stops at the // that closes the first.
   */
  const two = RECORD + '\nLOCUS       other       6 bp\nORIGIN\n        1 tttttt\n//\n';
  assert.strictEqual(extractBases(two), 'ACGTACGTAAGGCCTTACGTTGCATTAGCA');
});

test('a file with no ORIGIN block yields nothing rather than throwing', () => {
  assert.strictEqual(extractBases('LOCUS x\nFEATURES\n//'), '');
  assert.strictEqual(extractBases(''), '');
});

/* --- exact ---------------------------------------------------------------- */

const TARGET = 'AAAAGAGTTTCATATGGCTAGCAAAGGAGAAGAACTTTTTT';

test('an exact hit is found on either strand', () => {
  const fwd = searchSequence(TARGET, 'CATATGGCTAGC', { kind: 'dna', exact: true });
  assert.strictEqual(fwd.length, 1);
  assert.deepStrictEqual([fwd[0].start, fwd[0].end, fwd[0].strand], [10, 21, 1]);

  const rev = searchSequence(TARGET, revComp('CATATGGCTAGC'), { kind: 'dna', exact: true });
  assert.strictEqual(rev.length, 1);
  assert.deepStrictEqual([rev[0].start, rev[0].end, rev[0].strand], [10, 21, -1]);
});

test('a palindrome is reported once, not once per strand', () => {
  // GAATTC is its own reverse complement; searching both strands would
  // otherwise report the same bases twice.
  const hits = searchSequence('TTTTGAATTCTTTT', 'GAATTC', { kind: 'dna', exact: true });
  assert.strictEqual(hits.length, 1);
});

/* --- fuzzy ---------------------------------------------------------------- */

const QUERY = 'GAGTTTCATATGGCTAGCAAAGGAGAAGAACTT';          // 33 bp

/** The query with base `at` changed, padded so it is not flush with either end. */
const withMismatches = (positions) => {
  const chars = QUERY.split('');
  for (const at of positions) chars[at] = chars[at] === 'C' ? 'A' : 'C';
  return 'TTTTT' + chars.join('') + 'TTTTT';
};

test('one mismatch is still a hit, with the identity it actually has', () => {
  const hits = searchSequence(withMismatches([16]), QUERY,
    { kind: 'dna', exact: false, minIdentity: 0.8 });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].length, 33);
  assert.ok(Math.abs(hits[0].identity - 32 / 33) < 1e-9,
    `identity ${hits[0].identity}, expected ${32 / 33}`);
  // matches - mismatches
  assert.strictEqual(hits[0].score, 31);
});

test('the identity threshold is applied', () => {
  /*
   * Three mismatches in the middle of 33 is 90.9%, which clears 0.85 and fails
   * 0.95. They have to be in the middle: the extension keeps the best-scoring
   * extent, so mismatches near an end are simply trimmed off and the hit comes
   * back shorter and perfect rather than longer and imperfect.
   */
  const target = withMismatches([14, 15, 16]);
  const loose = searchSequence(target, QUERY, { kind: 'dna', exact: false, minIdentity: 0.85 });
  const strict = searchSequence(target, QUERY, { kind: 'dna', exact: false, minIdentity: 0.95 });
  assert.strictEqual(loose.length, 1, 'should survive the looser threshold');
  assert.ok(Math.abs(loose[0].identity - 30 / 33) < 1e-9,
    `identity ${loose[0].identity}, expected ${30 / 33}`);
  assert.strictEqual(strict.length, 0, 'should be dropped by the stricter one');
});

test('a match with no exact stretch to seed on is not found', () => {
  /*
   * The cost of seeding: fuzzy matching needs one k-mer to agree exactly before
   * it will look at a region. Mismatches every fifth base leave no run of 11,
   * so a 33 bp query at 82% identity is invisible however low the threshold
   * goes. Worth knowing rather than discovering -- it is the trade that keeps a
   * corpus-wide search in the region of a second.
   */
  const target = withMismatches([4, 9, 14, 19, 24, 29]);
  const hits = searchSequence(target, QUERY, { kind: 'dna', exact: false, minIdentity: 0.5 });
  assert.strictEqual(hits.length, 0);
});

test('a long match is reported once, not once per shared k-mer', () => {
  // A 33 bp exact stretch shares 23 seeds at k=11; collapsing by diagonal is
  // what keeps that one hit.
  const hits = searchSequence('TTTTT' + QUERY + 'TTTTT', QUERY,
    { kind: 'dna', exact: false, minIdentity: 0.8 });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].identity, 1);
});

/* --- protein -------------------------------------------------------------- */

const PEPTIDE = 'MKLVAGIE';
const CODON = { M: 'ATG', K: 'AAA', L: 'CTG', V: 'GTC', A: 'GCC', G: 'GGA', I: 'ATC', E: 'GAA' };
const ORF = PEPTIDE.split('').map((c) => CODON[c]).join('');

test('six frames are translated, numbered the way a viewer numbers them', () => {
  const frames = translateFrames('ATGAAACTG');
  assert.deepStrictEqual(frames.map((f) => f.frame), [1, 2, 3, -1, -2, -3]);
  assert.strictEqual(frames[0].protein, 'MKL');
});

test('a protein hit on a forward frame lands on the codons that encode it', () => {
  const target = `G${ORF}TTTTTT`;               // one base of padding -> frame +2
  const hits = searchSequence(target, PEPTIDE, { kind: 'protein', exact: true });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].frame, 2);
  assert.strictEqual(target.slice(hits[0].start, hits[0].end + 1), ORF,
    'the reported range must be the bases that code for the peptide');
});

test('a protein hit on a reverse frame is turned back around', () => {
  /*
   * The frame was read against the reverse complement, so position r there is
   * length-1-r here -- which swaps start and end as well. Getting this wrong
   * puts the hit at the mirror-image position, which still looks plausible.
   */
  const target = `TT${revComp(ORF)}GGGGG`;
  const hits = searchSequence(target, PEPTIDE, { kind: 'protein', exact: true });
  assert.strictEqual(hits.length, 1);
  assert.ok(hits[0].frame < 0, `expected a reverse frame, got ${hits[0].frame}`);
  assert.strictEqual(revComp(target.slice(hits[0].start, hits[0].end + 1)), ORF);
});

/* --- ranking -------------------------------------------------------------- */

test('a long near-perfect hit outranks a short exact one', () => {
  /*
   * This is the whole point of scoring on matches - mismatches. Rank on
   * identity and the shorter perfect hit wins, which makes the list useless:
   * a 900 bp gene at 99% is the answer, a 20 bp coincidence is not.
   */
  const long = 'TTTTT' + withMismatches([16]).slice(5, 38) + 'TTTTT';
  const hits = searchCorpus([
    { file: '/a.gb', name: 'short exact', sequence: `AAAA${QUERY.slice(0, 20)}AAAA` },
    { file: '/b.gb', name: 'long near-perfect', sequence: long }
  ], QUERY, { kind: 'dna', exact: false, minIdentity: 0.8 });

  assert.ok(hits.length >= 2, `expected hits from both files, got ${hits.length}`);
  assert.strictEqual(hits[0].name, 'long near-perfect');
  assert.ok(hits[0].score > hits[1].score);
});

test('a hit covering too little of the query is not a hit', () => {
  /*
   * Every 11-mer occurs many times over in a megabase target, so without a
   * coverage floor a seed that extends nowhere comes back at 100% identity and
   * buries the real answer. Searching 33 bp against E. coli produced dozens of
   * these 12-16 bp fragments.
   *
   * The 20 bp piece is 61% of the query and survives; the 12 bp piece is 36%
   * and does not. Both are perfect matches, so identity cannot tell them apart
   * -- only length relative to what was asked for can.
   */
  const opts = { kind: 'dna', exact: false, minIdentity: 0.8 };
  const piece = (n) => `GGGG${QUERY.slice(0, n)}GGGG`;
  const coverage = (hit) => hit.length / QUERY.length;

  // Lengths here are approximate on purpose: extension runs a little way into
  // the padding, since it is allowed to cross a mismatch. Coverage is what the
  // floor is actually about.
  const kept = searchSequence(piece(20), QUERY, opts);
  assert.strictEqual(kept.length, 1);
  assert.ok(coverage(kept[0]) >= 0.5, `covered ${coverage(kept[0]).toFixed(2)}`);

  const dropped = searchSequence(piece(12), QUERY, opts);
  assert.deepStrictEqual(dropped, []);

  // Still reachable for anyone who genuinely wants the fragments.
  const asked = searchSequence(piece(12), QUERY, Object.assign({ minCoverage: 0.3 }, opts));
  assert.strictEqual(asked.length, 1);
  assert.ok(coverage(asked[0]) < 0.5, `covered ${coverage(asked[0]).toFixed(2)}`);
});

test('every hit says which file it came from', () => {
  const hits = searchCorpus([
    { file: '/x.gb', name: 'x', sequence: TARGET }
  ], 'CATATGGCTAGC', { kind: 'dna', exact: true });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].file, '/x.gb');
  assert.strictEqual(hits[0].name, 'x');
});
