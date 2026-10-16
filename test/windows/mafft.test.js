'use strict';

/*
 * MAFFT on a real Windows machine, the one place the rest of the suite cannot
 * reach. Run by .github/workflows/windows-mafft.yml, which first puts MAFFT
 * where a Windows user would:
 *
 *   OVEN_MAFFT=bat  the all-in-one zip, unzipped into Downloads by Extract All
 *   OVEN_MAFFT=wsl  apt's MAFFT, inside WSL
 *
 * and then checks that OVEN finds it with nothing configured, and that real
 * alignments come back through mafft.bat or wsl.exe intact. Anywhere else, or
 * with OVEN_MAFFT unset, every test skips.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveMafft, probe, describe } = require('../../src/mafft');
const { align, runMafft } = require('../../src/align');
const { revComp } = require('../../media/cartShared');

const KIND = process.env.OVEN_MAFFT;
const onWindows = { skip: process.platform === 'win32' && KIND ? false : 'Windows CI only' };
const batOnly = { skip: process.platform === 'win32' && KIND === 'bat' ? false : 'mafft.bat only' };
// mafft.bat can be slow to start under real-time virus scanning.
const SLOW = { timeoutMs: 300000 };

/** Deterministic sequence, mulberry32 as in test/unit/align.test.js. */
function make(len, seed, letters) {
  let a = seed >>> 0;
  let out = '';
  for (let i = 0; i < len; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out += letters[((t ^ (t >>> 14)) >>> 0) % letters.length];
  }
  return out;
}
const ungap = (s) => s.replace(/-/g, '');

const REF = make(1200, 20261015, 'ACGT');
const PREF = make(300, 20261002, 'ACDEFGHIKLMNPQRSTVWY');

let found;
test.before(async () => {
  if (process.platform === 'win32' && KIND) found = await resolveMafft('');
});

test('MAFFT is found with nothing configured', onWindows, () => {
  assert.strictEqual(found.ok, true, found.message);
  assert.strictEqual(found.viaSetting, false);
  assert.match(found.version, /^v7\.\d+/);
  if (KIND === 'bat') {
    assert.match(found.path, /\\Downloads\\mafft-7\.\d+-win64-signed\\mafft-win\\mafft\.bat$/i);
  } else {
    assert.strictEqual(found.path, 'wsl');
    assert.strictEqual(describe(found.path), 'MAFFT in WSL');
  }
  console.log(`found ${found.version} at ${describe(found.path)}`);
});

test('DNA: identical, a substitution, a deletion', onWindows, async () => {
  const opts = { ...SLOW, mafftPath: found.path };
  const reference = { name: 'ref', sequence: REF, circular: true };
  const snp = REF.slice(0, 400) + (REF[400] === 'A' ? 'C' : 'A') + REF.slice(401);
  const del = REF.slice(0, 700) + REF.slice(703);
  const { tracks } = await align(reference, [
    { name: 'same', sequence: REF },
    { name: 'snp', sequence: snp },
    { name: 'del', sequence: del }
  ], opts);
  assert.strictEqual(tracks[0].mismatches, 0);
  assert.strictEqual(tracks[1].substitutions, 1);
  assert.strictEqual(tracks[1].gaps, 0);
  assert.strictEqual(tracks[2].gaps, 3);
  assert.strictEqual(ungap(tracks[2].referenceRow), REF);
  assert.strictEqual(ungap(tracks[2].readRow), del);
});

test('DNA: a reverse-complemented read comes back flipped', onWindows, async () => {
  const { tracks } = await align({ name: 'ref', sequence: REF, circular: true },
    [{ name: 'rc', sequence: revComp(REF) }], { ...SLOW, mafftPath: found.path });
  assert.strictEqual(tracks[0].strand, -1);
  assert.strictEqual(tracks[0].mismatches, 0);
});

test('protein: a three-residue deletion', onWindows, async () => {
  const del = PREF.slice(0, 120) + PREF.slice(123);
  const { tracks, molecule } = await align({ name: 'enzyme', sequence: PREF, molecule: 'protein' },
    [{ name: 'del', sequence: del }], { ...SLOW, mafftPath: found.path });
  assert.strictEqual(molecule, 'protein');
  assert.strictEqual(tracks[0].gaps, 3);
  assert.strictEqual(tracks[0].substitutions, 0);
});

test('the user\'s own MAFFT arguments get through', onWindows, async () => {
  const records = [{ name: 'a', sequence: REF.slice(0, 300) }, { name: 'b', sequence: REF.slice(5, 300) }];
  const out = await runMafft(records,
    { ...SLOW, mafftPath: found.path, mafftArgs: '--localpair --maxiterate 10 --op 1.53 --ep 0.123' });
  assert.deepStrictEqual(out.map((r) => ungap(r.sequence).toUpperCase()), records.map((r) => r.sequence));
});

test('mafft.bat in a folder with spaces and parentheses', batOnly, async () => {
  // MAFFT's own page warns about parentheses; Windows adds " (1)" to a second download.
  const dest = path.join(os.tmpdir(), 'MAFFT copy (1) & co', 'mafft-win');
  fs.cpSync(path.dirname(found.path), dest, { recursive: true });
  try {
    const bat = path.join(dest, 'mafft.bat');
    const res = await probe(bat);
    assert.strictEqual(res.ok, true, res.reason);
    const out = await runMafft([{ name: 'a', sequence: 'ACGTACGTAC' }, { name: 'b', sequence: 'ACGTTCGTAC' }],
      { ...SLOW, mafftPath: bat });
    assert.strictEqual(out.length, 2);
  } finally {
    fs.rmSync(path.dirname(dest), { recursive: true, force: true });
  }
});
