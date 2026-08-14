'use strict';

/*
 * The aligner. Anchoring is pure JS and always runs; the stages that shell out
 * to MAFFT are skipped with a message when it is not installed, so the suite
 * still passes on a machine without it.
 */

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');

const {
  align, anchor, rotateString, rotationFor, splitPairs, countDifferences, MISSING_MAFFT
} = require('../../src/align');
const { revComp } = require('../../media/cartShared');

const hasMafft = (() => {
  try {
    execFileSync('mafft', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const needsMafft = { skip: hasMafft ? false : 'MAFFT is not installed' };

/** Deterministic sequence: mulberry32, as used by the plasmid fixture. */
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

const REF = makeSeq(900, 20260814);
const ungap = (s) => s.replace(/-/g, '');

/* ------------------------------------------------------------- anchoring -- */

test('anchors a forward read at its true offset', () => {
  const hit = anchor(REF, REF.slice(300, 700));
  assert.strictEqual(hit.strand, 1);
  assert.strictEqual(hit.offset, 300);
});

test('anchors a reverse-complemented read, reporting where its flipped form starts', () => {
  const hit = anchor(REF, revComp(REF.slice(300, 700)));
  assert.strictEqual(hit.strand, -1);
  assert.strictEqual(hit.offset, 300);
});

test('an origin-spanning read anchors to one offset, not two half-votes', () => {
  // The real failure mode: the two diagonals either side of the origin differ
  // by exactly the reference length, so without the modulo they compete and
  // the read is anchored to whichever half happens to be longer.
  for (const cut of [1, 137, 450, 899]) {
    const read = REF.slice(cut) + REF.slice(0, cut);
    const hit = anchor(REF, read, { circular: true });
    assert.strictEqual(hit.strand, 1, `cut ${cut}`);
    assert.strictEqual(hit.offset, cut, `cut ${cut} anchored to the wrong origin`);
  }
});

test('an indel is not mistaken for a wrap', () => {
  // The regression this guards: an insertion puts the larger half of the read
  // on a shifted diagonal, which wins the popular vote. Anchoring off that
  // rotated the read by the size of the indel for no reason at all.
  for (const size of [1, 3, 25]) {
    const ins = REF.slice(0, 400) + 'G'.repeat(size) + REF.slice(400);
    const hit = anchor(REF, ins, { circular: true });
    assert.strictEqual(hit.wraps, false, `${size} bp insertion read as a wrap`);
    assert.strictEqual(hit.offset, 0, `${size} bp insertion moved the reported start`);

    const del = REF.slice(0, 400) + REF.slice(400 + size);
    const dhit = anchor(REF, del, { circular: true });
    assert.strictEqual(dhit.wraps, false, `${size} bp deletion read as a wrap`);
    assert.strictEqual(dhit.offset, 0);
  }
});

test('a wrap is still detected when the read also carries an indel', () => {
  const cut = 400;
  const wrapped = REF.slice(cut) + REF.slice(0, cut);
  const withIndel = wrapped.slice(0, 200) + 'TTTTT' + wrapped.slice(200);
  const hit = anchor(REF, withIndel, { circular: true });
  assert.strictEqual(hit.wraps, true);
  assert.strictEqual(hit.offset, cut);
});

test('a linear reference does not wrap a read around the origin', () => {
  const read = REF.slice(800) + makeSeq(200, 7); // hangs off the end
  const hit = anchor(REF, read, { circular: false });
  assert.strictEqual(hit.offset, 800, 'a linear reference must report a plain diagonal');
});

test('returns null when nothing seeds', () => {
  assert.strictEqual(anchor(REF, 'ACGT'), null, 'a read shorter than k cannot anchor');
  assert.strictEqual(anchor(REF, makeSeq(400, 999)), null);
});

/* -------------------------------------------------------------- rotation -- */

test('rotation puts the base belonging at reference 0 first', () => {
  for (const cut of [1, 137, 450]) {
    const read = REF.slice(cut) + REF.slice(0, cut);
    const rot = rotationFor(read.length, cut, REF.length);
    assert.strictEqual(rotateString(read, rot), REF, `cut ${cut}`);
  }
});

test('rotating by zero is a no-op and rotation is reversible', () => {
  assert.strictEqual(rotateString(REF, 0), REF);
  assert.strictEqual(rotateString(rotateString(REF, 137), REF.length - 137), REF);
});

/* ------------------------------------------------------ MSA -> pairwise -- */

test('drops columns gapped in both rows but keeps a real insertion', () => {
  // Column 3 is gapped in both -- it exists only because some *other* read had
  // an insertion there, and keeping it would shift this pair off the
  // reference's coordinates.
  const msa = [
    { name: 'reference', sequence: 'ACG-T-A' },
    { name: 'read0', sequence: 'ACG-TGA' }
  ];
  const [pair] = splitPairs(msa);
  assert.strictEqual(pair.referenceRow, 'ACGT-A');
  assert.strictEqual(pair.readRow, 'ACGTGA');
  assert.strictEqual(ungap(pair.referenceRow), 'ACGTA');
});

test('strips the _R_ marker MAFFT puts on a sequence it flipped', () => {
  const [pair] = splitPairs([
    { name: 'reference', sequence: 'ACGT' },
    { name: '_R_read0', sequence: 'ACGT' }
  ]);
  assert.strictEqual(pair.name, 'read0');
  assert.strictEqual(pair.flipped, true);
});

/* ------------------------------------------------------------ difference -- */

test('leading and trailing gaps are missing coverage, not mismatches', () => {
  const d = countDifferences('ACGTACGT', '--GTAC--');
  assert.strictEqual(d.mismatches, 0);
  assert.strictEqual(d.compared, 4);
});

test('counts substitutions and internal gaps', () => {
  const d = countDifferences('ACGTACGT', 'ACCTA-GT');
  assert.strictEqual(d.substitutions, 1);
  assert.strictEqual(d.gaps, 1);
  assert.strictEqual(d.mismatches, 2);
});

/* ------------------------------------------------------ the whole pipeline -- */

const reference = { name: 'ref', sequence: REF, circular: true };

test('an identical read aligns with no differences', needsMafft, async () => {
  const { tracks } = await align(reference, [{ name: 'same', sequence: REF }]);
  assert.strictEqual(tracks[0].mismatches, 0);
  assert.strictEqual(tracks[0].identity, 1);
  assert.strictEqual(tracks[0].referenceRow.length, REF.length, 'no gaps should be introduced');
});

test('a single substitution is reported as exactly one', needsMafft, async () => {
  const read = REF.slice(0, 400) + (REF[400] === 'A' ? 'C' : 'A') + REF.slice(401);
  const { tracks } = await align(reference, [{ name: 'snp', sequence: read }]);
  assert.strictEqual(tracks[0].substitutions, 1);
  assert.strictEqual(tracks[0].gaps, 0);
});

test('a deletion shows as gaps, and the rows still ungap to their inputs', needsMafft, async () => {
  const read = REF.slice(0, 400) + REF.slice(403);
  const { tracks } = await align(reference, [{ name: 'del', sequence: read }]);
  const t = tracks[0];
  assert.strictEqual(t.gaps, 3);
  // The sharpest check on traceback: strip the gaps and you must get back
  // exactly what went in.
  assert.strictEqual(ungap(t.referenceRow), REF);
  assert.strictEqual(ungap(t.readRow), read);
});

test('an insertion is carried in the reference row', needsMafft, async () => {
  const read = REF.slice(0, 400) + 'GGG' + REF.slice(400);
  const { tracks } = await align(reference, [{ name: 'ins', sequence: read }]);
  assert.strictEqual(ungap(tracks[0].readRow), read);
  assert.strictEqual(ungap(tracks[0].referenceRow), REF);
});

test('a reverse-complemented read is flipped and aligns cleanly', needsMafft, async () => {
  const { tracks } = await align(reference, [{ name: 'rc', sequence: revComp(REF) }]);
  assert.strictEqual(tracks[0].strand, -1);
  assert.strictEqual(tracks[0].mismatches, 0);
});

test('an origin-spanning read aligns end to end, not in two pieces', needsMafft, async () => {
  // Without the rotation this is the 2140-mismatch case from the real data.
  const cut = 617;
  const read = REF.slice(cut) + REF.slice(0, cut);
  const { tracks } = await align(reference, [{ name: 'wrap', sequence: read }]);
  const t = tracks[0];
  assert.strictEqual(t.offset, cut);
  assert.strictEqual(t.rotation, REF.length - cut);
  assert.strictEqual(t.mismatches, 0, 'a rotated read must align gap-free');
  assert.strictEqual(t.referenceRow.length, REF.length);
});

test('several reads align in one call and keep their order', needsMafft, async () => {
  const snp = REF.slice(0, 100) + (REF[100] === 'A' ? 'C' : 'A') + REF.slice(101);
  const { tracks } = await align(reference, [
    { name: 'a', sequence: REF },
    { name: 'b', sequence: snp },
    { name: 'c', sequence: REF.slice(300) + REF.slice(0, 300) }
  ]);
  assert.deepStrictEqual(tracks.map((t) => t.name), ['a', 'b', 'c']);
  assert.deepStrictEqual(tracks.map((t) => t.mismatches), [0, 1, 0]);
});

test('a missing MAFFT is reported as something the user can act on', async () => {
  await assert.rejects(
    () => align(reference, [{ name: 'x', sequence: REF }], { mafftPath: 'mafft-does-not-exist' }),
    (err) => {
      assert.strictEqual(err.message, MISSING_MAFFT);
      assert.match(err.message, /brew install mafft|conda install/);
      return true;
    }
  );
});
