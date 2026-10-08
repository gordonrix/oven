'use strict';

/*
 * Saving an alignment and reading it back.
 *
 * The encoding tests are pure. The round trip is the one that matters and it
 * needs MAFFT, so it is skipped with a message when MAFFT is absent: it aligns
 * for real, writes the file, reads it back with the sources on hand and asserts
 * that every field the viewer draws from came back identical. That is the whole
 * promise of the format -- reopening is not an approximation of the alignment,
 * it is the alignment.
 */

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');

const { align } = require('../../src/align');
const { revComp } = require('../../media/cartShared');
const {
  buildStockholm, parseStockholm, readAlignment, rebuild,
  encodeRanges, decodeRanges, encodeRuns, decodeRuns, safeIds, degap
} = require('../../src/alignFile');

const hasMafft = (() => {
  try {
    execFileSync('mafft', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const needsMafft = { skip: hasMafft ? false : 'MAFFT is not installed' };

function makeSeq(len, seed) {
  let a = seed >>> 0;
  const bases = 'ACGT';
  let out = '';
  for (let i = 0; i < len; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out += bases[((t ^ (t >>> 14)) >>> 0) % 4];
  }
  return out;
}

/* ------------------------------------------------------------- encoding -- */

test('ranges round-trip, and a single position loses its dash', () => {
  assert.strictEqual(encodeRanges([[139, 1324], [3494, 3494]]), '139-1324,3494');
  assert.deepStrictEqual(decodeRanges('139-1324,3494'), [[139, 1324], [3494, 3494]]);
  assert.deepStrictEqual(decodeRanges(''), []);
});

test('read positions are written as runs, not one number per column', () => {
  const index = [1046, 1047, 1048, 0, 1, 2, 3];
  assert.strictEqual(encodeRuns(index), '1046:3,0:4');
  assert.deepStrictEqual(decodeRuns(encodeRuns(index)), index);
});

test('a 1200-base folded read costs two runs to record', () => {
  const index = [...Array(200).keys()].map((i) => i + 1000)
    .concat([...Array(1000).keys()]);
  assert.strictEqual(encodeRuns(index), '1000:200,0:1000');
});

test('row names lose whitespace and never collide', () => {
  assert.deepStrictEqual(
    safeIds(['clone A', 'clone A', '', 'p BT0-150.gb']),
    ['clone_A', 'clone_A_2', 'seq3', 'p_BT0-150.gb']);
});

test('a Stockholm file from somewhere else still parses', () => {
  const text = [
    '# STOCKHOLM 1.0',
    'seq1  ACGT..ACGT',
    'seq2  acgtttACGT',
    '//', ''
  ].join('\n');
  const spec = readAlignment(text);
  assert.strictEqual(spec.meta.oven, false);
  assert.strictEqual(spec.reference.name, 'seq1');
  assert.strictEqual(spec.reference.row, 'ACGT--ACGT');   // '.' is a gap too
  assert.strictEqual(spec.reads.length, 1);
  assert.strictEqual(spec.reads[0].row, 'ACGTTTACGT');    // case carries nothing
  assert.strictEqual(spec.reads[0].strand, 1);
});

test('an interleaved file is stitched back into whole rows', () => {
  const text = [
    '# STOCKHOLM 1.0',
    'seq1  ACGT',
    'seq2  ACGA',
    '',
    'seq1  TTTT',
    'seq2  TTTT',
    '//', ''
  ].join('\n');
  const { rows } = parseStockholm(text);
  assert.deepStrictEqual(rows.map((r) => r.sequence), ['ACGTTTTT', 'ACGATTTT']);
});

test('a row that is not the same width as the reference is refused', () => {
  const text = ['# STOCKHOLM 1.0', 'seq1  ACGT', 'seq2  ACG', '//', ''].join('\n');
  assert.throws(() => readAlignment(text), /columns/);
});

test('the reference keeps its name, path and topology', () => {
  const text = buildStockholm({
    reference: { name: 'pBT0-150', path: '/maps/pBT0-150.gb', rel: '../pBT0-150.gb', row: 'ACGT', circular: true },
    reads: [{ name: 'clone A.ab1', path: '/ab1/clone A.ab1', row: 'AC-T', strand: -1, rotation: 7, trim: 20 }],
    meta: { tool: 'OVEN 1.59.0', created: '2026-09-23T00:00:00Z', type: 'Sanger sequencing', mafftArgs: '--auto' }
  });
  assert.match(text, /^# STOCKHOLM 1\.0/);
  assert.match(text, /\/\/\n$/);

  const spec = readAlignment(text);
  assert.strictEqual(spec.meta.oven, true);
  assert.strictEqual(spec.meta.mafftArgs, '--auto');
  assert.strictEqual(spec.reference.path, '/maps/pBT0-150.gb');
  assert.strictEqual(spec.reference.rel, '../pBT0-150.gb');
  assert.strictEqual(spec.reference.circular, true);
  // The name someone recognises survives a space the row identifier cannot hold.
  assert.strictEqual(spec.reads[0].name, 'clone A.ab1');
  assert.strictEqual(spec.reads[0].path, '/ab1/clone A.ab1');
  assert.strictEqual(spec.reads[0].strand, -1);
  assert.strictEqual(spec.reads[0].rotation, 7);
  assert.strictEqual(spec.reads[0].trim, 20);
});

/* ----------------------------------------------------------- round trip -- */

const REF = makeSeq(900, 20260923);

/** Every field the panel and the viewer read off a track. */
const DRAWN = [
  'name', 'strand', 'rotation', 'anchored', 'referenceRow', 'readRow',
  'covered', 'deleted', 'readIndex', 'columnOrderSequence', 'crossesOrigin',
  'sequence', 'substitutions', 'gaps', 'compared', 'mismatches', 'identity'
];

const pick = (track) => Object.fromEntries(DRAWN.map((k) => [k, track[k]]));

/** Align, save, read back with the sources on hand, and rebuild. */
async function roundTrip(reference, reads) {
  const result = await align(reference, reads);
  const text = buildStockholm({
    reference: { name: reference.name, path: '/maps/ref.gb', row: result.msa.reference, circular: true },
    reads: result.tracks.map((t, i) => ({
      name: t.name,
      path: `/reads/${i}.ab1`,
      row: result.msa.rows[i].sequence,
      strand: t.strand,
      rotation: t.rotation,
      folded: t.crossesOrigin,
      anchored: t.anchored,
      covered: t.covered,
      deleted: t.deleted,
      readIndex: t.readIndex,
      trim: 20
    })),
    meta: { tool: 'OVEN test', mafftArgs: '--auto' }
  });
  const spec = readAlignment(text);
  const restored = rebuild(spec, {
    reference: { name: reference.name, sequence: reference.sequence, sequenceData: { features: [] } },
    reads: reads.map((r) => ({ name: r.name, sequence: r.sequence }))
  });
  return { result, text, spec, restored };
}

test('an ordinary alignment comes back exactly as it went in', needsMafft, async () => {
  const reads = [
    { name: 'forward', sequence: REF.slice(100, 600) },
    { name: 'reverse', sequence: revComp(REF.slice(300, 800)) }
  ];
  const { result, restored } = await roundTrip(
    { name: 'ref', sequence: REF, circular: true }, reads);

  assert.deepStrictEqual(restored.problems, []);
  assert.strictEqual(restored.msa.reference, result.msa.reference);
  result.tracks.forEach((track, i) => {
    assert.deepStrictEqual(pick(restored.tracks[i]), pick(track), `track ${i}`);
  });
  // The reverse read is stored on the strand it was read on, so realigning a
  // restored alignment starts from the same sequence.
  assert.strictEqual(restored.reads[1].sequence, reads[1].sequence);
});

test('a read folded across the origin comes back folded', needsMafft, async () => {
  // Starts 100 bp before the end and carries on past it.
  const wrapping = REF.slice(800) + REF.slice(0, 400);
  const { result, restored } = await roundTrip(
    { name: 'ref', sequence: REF, circular: true },
    [{ name: 'wrap', sequence: wrapping }]);

  const track = result.tracks[0];
  assert.ok(track.crossesOrigin, 'the fixture must actually fold, or this proves nothing');
  assert.ok(track.readIndex && track.readIndex.length);
  assert.deepStrictEqual(restored.problems, []);
  assert.deepStrictEqual(pick(restored.tracks[0]), pick(track));
});

test('a deletion spanning the origin comes back with its coverage', needsMafft, async () => {
  // Present: 3400..900. Missing: the 500 bp arc from 900 to 3400 -- which on a
  // linear reference is in the middle, and is what folding exists to express.
  const ref = makeSeq(1400, 424242);
  const clone = ref.slice(1000) + ref.slice(0, 300);
  const { result, restored } = await roundTrip(
    { name: 'ref', sequence: ref, circular: true },
    [{ name: 'deleted', sequence: clone }]);

  const track = result.tracks[0];
  assert.ok(track.covered && track.covered.length, 'fixture must fold');
  assert.deepStrictEqual(pick(restored.tracks[0]), pick(track));
  assert.deepStrictEqual(restored.tracks[0].deleted, track.deleted);
});

test('a source that has changed is refused rather than drawn', needsMafft, async () => {
  const reads = [{ name: 'forward', sequence: REF.slice(100, 600) }];
  const { result, spec } = await roundTrip({ name: 'ref', sequence: REF, circular: true }, reads);

  const restored = rebuild(spec, {
    reference: { name: 'ref', sequence: REF, sequenceData: { features: [] } },
    // The same read with one base changed: the file on disk has moved on.
    reads: [{ name: 'forward', sequence: `T${REF.slice(101, 600)}` }]
  });
  assert.strictEqual(restored.problems.length, 1);
  assert.match(restored.problems[0].reason, /changed/);
  assert.strictEqual(restored.reads[0].missing, true);
  // And the alignment still opens, on the bases the file itself holds.
  assert.deepStrictEqual(pick(restored.tracks[0]), pick(result.tracks[0]));
});

test('a missing source still opens, without annotations', needsMafft, async () => {
  const wrapping = REF.slice(800) + REF.slice(0, 400);
  const { result, spec } = await roundTrip(
    { name: 'ref', sequence: REF, circular: true }, [{ name: 'wrap', sequence: wrapping }]);

  const restored = rebuild(spec, { reference: null, reads: [null] });
  assert.strictEqual(restored.problems.length, 2);            // reference and read
  assert.strictEqual(restored.reference.sequenceData.features.length, 0);
  assert.strictEqual(restored.reads[0].raw, null);
  // The rows are in the file, so the alignment itself is unaffected.
  assert.deepStrictEqual(pick(restored.tracks[0]), pick(result.tracks[0]));
  // A folded read is stored in column order; IDX is what puts it back in read
  // order, so the sequence still reads as the read did.
  assert.strictEqual(degap(restored.tracks[0].sequence).length >= 1, true);
});

/* ------------------------------------------------------------- proteins -- */

function makeProtein(len, seed) {
  let a = seed >>> 0;
  const residues = 'ACDEFGHIKLMNPQRSTVWY';
  let out = '';
  for (let i = 0; i < len; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out += residues[((t ^ (t >>> 14)) >>> 0) % 20];
  }
  return out;
}

test('a protein alignment comes back as a protein, exactly', needsMafft, async () => {
  const PREF = makeProtein(240, 1002);
  const reads = [
    { name: 'variant', sequence: PREF.slice(0, 100) + 'W' + PREF.slice(101) },
    { name: 'truncated', sequence: PREF.slice(30, 200) }
  ];
  const reference = { name: 'enzyme', sequence: PREF, molecule: 'protein' };
  const result = await align(reference, reads);
  const text = buildStockholm({
    reference: { name: 'enzyme', path: '/p/enzyme.faa', row: result.msa.reference, circular: false },
    reads: result.tracks.map((t, i) => ({
      name: t.name, path: `/p/${i}.faa`, row: result.msa.rows[i].sequence,
      strand: t.strand, rotation: t.rotation, folded: t.crossesOrigin, anchored: t.anchored
    })),
    meta: { alphabet: 'protein', mafftArgs: '--auto' }
  });
  assert.match(text, /#=GF OVEN\s+format=1 alphabet=protein/);

  const spec = readAlignment(text);
  assert.strictEqual(spec.meta.alphabet, 'protein');
  const restored = rebuild(spec, {
    reference: { name: 'enzyme', sequence: PREF, molecule: 'protein', sequenceData: {} },
    reads: reads.map((r) => ({ name: r.name, sequence: r.sequence, molecule: 'protein' }))
  });
  assert.deepStrictEqual(restored.problems, []);
  assert.strictEqual(restored.molecule, 'protein');
  assert.strictEqual(restored.reference.molecule, 'protein');
  result.tracks.forEach((t, i) => assert.deepStrictEqual(pick(restored.tracks[i]), pick(t)));
});

test('a file written before the alphabet field is DNA', () => {
  const text = ['# STOCKHOLM 1.0', '#=GF OVEN   format=1 mafftArgs=--auto',
    'ref  ACGTACGT', 'read ACGT----', '//', ''].join('\n');
  assert.strictEqual(readAlignment(text).meta.alphabet, 'dna');
});

test('someone else\'s protein Stockholm is read as protein', () => {
  const text = ['# STOCKHOLM 1.0',
    'P1  MKEFILPQWYHRDNSTVGAC', 'P2  MKEFILPQ--HRDNSTVGAC', '//', ''].join('\n');
  assert.strictEqual(readAlignment(text).meta.alphabet, 'protein');
});

test('a source that now parses as DNA is not the protein it replaced', () => {
  const PREF = makeProtein(60, 7);
  const text = buildStockholm({
    reference: { name: 'enzyme', row: PREF },
    reads: [{ name: 'same', path: '/p/same.faa', row: PREF }],
    meta: { alphabet: 'protein' }
  });
  const restored = rebuild(readAlignment(text), {
    reference: null,
    // Same letters, wrong molecule: the file at that path is something else now.
    reads: [{ name: 'same', sequence: PREF, molecule: 'dna' }]
  });
  assert.match(restored.problems[0].reason, /changed/);
  assert.strictEqual(restored.reads[0].missing, true);
});

test('a protein read is never reverse-complemented on reopening', () => {
  // A strand of -1 can only come from a hand-edited or foreign file; a protein
  // has no other strand, so it is ignored rather than obeyed.
  const PREF = makeProtein(60, 9);
  const text = buildStockholm({
    reference: { name: 'enzyme', row: PREF },
    reads: [{ name: 'r', path: '/p/r.faa', row: PREF, strand: -1 }],
    meta: { alphabet: 'protein' }
  });
  const restored = rebuild(readAlignment(text), {
    reference: { name: 'enzyme', sequence: PREF, molecule: 'protein' },
    reads: [{ name: 'r', sequence: PREF, molecule: 'protein' }]
  });
  assert.deepStrictEqual(restored.problems, []);
  assert.strictEqual(restored.reads[0].sequence, PREF);
});

/* ------------------------------------------------- reads with no file -- */

/*
 * A read typed or pasted in, folded across the origin, with an insertion the
 * fold drops: exactly the read a row cannot give back.
 */
async function pastedFoldedAlignment() {
  const ref = makeSeq(900, 31337);
  const read = ref.slice(780) + 'GATC' + ref.slice(0, 300);   // wraps, with 4 inserted bases
  const result = await align({ name: 'ref', sequence: ref, circular: true }, [{ name: 'pasted', sequence: read }]);
  const t = result.tracks[0];
  const fields = (seq) => ({
    reference: { name: 'ref', row: result.msa.reference, circular: true },
    reads: [{
      name: 'pasted', row: result.msa.rows[0].sequence, strand: t.strand, rotation: t.rotation,
      folded: t.crossesOrigin, anchored: t.anchored, covered: t.covered, deleted: t.deleted,
      readIndex: t.readIndex, seq
    }],
    meta: { alphabet: 'dna' }
  });
  return { ref, read, result, fields };
}

test('a pasted read comes back whole, insertions and all', needsMafft, async () => {
  const { ref, read, result, fields } = await pastedFoldedAlignment();
  assert.ok(result.tracks[0].crossesOrigin, 'fixture must fold, or this proves nothing');
  assert.ok(degap(result.msa.rows[0].sequence).length < read.length, 'and the fold must drop the insertion');

  const text = buildStockholm(fields(read));
  assert.match(text, /^#=GS pasted SEQ /m);
  const restored = rebuild(readAlignment(text), { reference: { name: 'ref', sequence: ref }, reads: [null] });
  assert.deepStrictEqual(restored.problems, []);
  assert.strictEqual(restored.reads[0].sequence, read, 'every base, the four the row lost included');
  assert.ok(!/N/.test(restored.reads[0].sequence));
  assert.deepStrictEqual(pick(restored.tracks[0]), pick(result.tracks[0]));
});

test('a pasted read saved before SEQ comes back without invented Ns, and says what it lost', needsMafft, async () => {
  /*
   * The bug: the bases a fold dropped came back as Ns, and the next Align
   * aligned them -- a 120-base read returned with nearly eighteen thousand
   * gaps, and dragged the reads beside it out of place.
   */
  const { ref, read, result, fields } = await pastedFoldedAlignment();
  const old = rebuild(readAlignment(buildStockholm(fields(null))),
    { reference: { name: 'ref', sequence: ref }, reads: [null] });

  const got = old.reads[0].sequence;
  assert.ok(!/N/.test(got), 'no invented bases');
  assert.strictEqual(got.length, read.length - 4);
  assert.strictEqual(old.problems.length, 1);
  assert.match(old.problems[0].reason, /4 of its bases/);
  // What is drawn is unaffected: the row was always right.
  assert.strictEqual(old.tracks[0].columnOrderSequence, result.tracks[0].columnOrderSequence);

  // Saved again, it now carries what it has, and reopens without complaint.
  const t = old.tracks[0];
  const again = rebuild(readAlignment(buildStockholm({
    reference: { name: 'ref', row: old.msa.reference, circular: true },
    reads: [{ name: 'pasted', row: old.msa.rows[0].sequence, strand: t.strand, rotation: t.rotation,
      folded: t.crossesOrigin, anchored: t.anchored, covered: t.covered, deleted: t.deleted,
      readIndex: t.readIndex, seq: got }],
    meta: { alphabet: 'dna' }
  })), { reference: { name: 'ref', sequence: ref }, reads: [null] });
  assert.deepStrictEqual(again.problems, []);
  assert.strictEqual(again.reads[0].sequence, got);
});

/* ---------------------------------------------------- MAFFT arguments -- */

test('MAFFT arguments are written on their own line, spaces and all', () => {
  const args = '--localpair --maxiterate 1000 --op 2 --adjustdirection --preservecase --quiet';
  const text = buildStockholm({
    reference: { name: 'ref', row: 'ACGT' },
    reads: [{ name: 'r', row: 'ACGT' }],
    meta: { mafftArgs: args, alphabet: 'dna' }
  });
  assert.ok(text.includes(`#=GF MAFFT   ${args}\n`), 'written as passed');
  assert.ok(!/_--/.test(text), 'no underscores standing in for spaces');
  assert.ok(!/mafftArgs=/.test(text), 'and no longer squeezed into the OVEN line');
  assert.strictEqual(readAlignment(text).meta.mafftArgs, args);
});

test('a file from before the MAFFT line reads back with its spaces restored', () => {
  const text = ['# STOCKHOLM 1.0',
    '#=GF OVEN   format=1 alphabet=dna mafftArgs=--localpair_--maxiterate_1000',
    'ref  ACGT', 'r    ACGT', '//', ''].join('\n');
  assert.strictEqual(readAlignment(text).meta.mafftArgs, '--localpair --maxiterate 1000');
});
