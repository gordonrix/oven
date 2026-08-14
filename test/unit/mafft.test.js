'use strict';

/*
 * Finding MAFFT. These use real binaries that exist on any Unix -- /bin/echo
 * stands in for "something that runs but is not MAFFT", /tmp for "not an
 * executable", and a made-up path for "not there" -- so the tests exercise the
 * same code paths a misconfigured setting would, with no mocking.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { resolveMafft, probe, candidatePaths, notFoundMessage } = require('../../src/mafft');

const hasMafft = (() => {
  try {
    execFileSync('mafft', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const needsMafft = { skip: hasMafft ? false : 'MAFFT is not installed' };

/* ------------------------------------------------------------- candidates -- */

test('looks on PATH first, then where brew and conda actually install', () => {
  const list = candidatePaths('');
  assert.strictEqual(list[0], 'mafft', 'PATH must be tried before guessing');
  assert.ok(list.includes('/opt/homebrew/bin/mafft'));
  assert.ok(list.includes('/usr/local/bin/mafft'));
  assert.ok(list.some((p) => p.includes('miniforge3')) || list.some((p) => p.includes('miniconda3')));
});

test('includes named conda environments, which PATH can never reach', () => {
  // This is the case the whole resolver exists for: `conda install` into an env
  // puts mafft somewhere the login shell has never heard of.
  const list = candidatePaths('');
  const envPaths = list.filter((p) => p.includes(`${path.sep}envs${path.sep}`));
  if (!envPaths.length) {
    // No conda on this machine; the shape is still what matters.
    assert.ok(list.every((p) => typeof p === 'string'));
    return;
  }
  assert.ok(envPaths.every((p) => p.endsWith(path.join('bin', 'mafft'))), envPaths[0]);
  assert.ok(envPaths.every((p) => p.startsWith(os.homedir())));
});

test('a configured path is tried first and never duplicated', () => {
  const list = candidatePaths('/custom/mafft');
  assert.strictEqual(list[0], '/custom/mafft');
  assert.strictEqual(list.filter((p) => p === '/custom/mafft').length, 1);
});

/* ------------------------------------------------------------------ probe -- */

test('recognises MAFFT even though it prints its version to stderr', needsMafft, async () => {
  // Reading only stdout rejects the real thing, which is a fine way to tell
  // every user their working install is broken.
  const res = await probe('mafft');
  assert.strictEqual(res.ok, true);
  assert.match(res.version, /\d+\.\d+/);
});

test('rejects a binary that runs but is not MAFFT', async () => {
  const res = await probe('/bin/echo');
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /does not look like MAFFT/);
});

test('tells a directory and a missing file apart', async () => {
  assert.strictEqual((await probe(os.tmpdir())).reason, 'is not an executable file');
  assert.strictEqual((await probe('/nope/definitely/not/mafft')).reason, 'does not exist');
});

/* ---------------------------------------------------------------- resolve -- */

test('finds MAFFT with nothing configured', needsMafft, async () => {
  const res = await resolveMafft('');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.viaSetting, false);
  assert.ok(res.path);
});

test('a configured path that works is used as given', needsMafft, async () => {
  const found = await resolveMafft('');
  const real = found.path === 'mafft'
    ? execFileSync('which', ['mafft']).toString().trim()
    : found.path;

  const res = await resolveMafft(real);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.path, real);
  assert.strictEqual(res.viaSetting, true);
});

test('a broken configured path fails loudly instead of silently using another', async () => {
  // Falling back would be worse than failing: the user asked for a specific
  // binary, and quietly aligning with a different one hides a real mistake.
  const res = await resolveMafft('/bin/echo');
  assert.strictEqual(res.ok, false);
  assert.match(res.message, /oveCart\.mafftPath/);
  assert.match(res.message, /\/bin\/echo/);
  assert.deepStrictEqual(res.tried, ['/bin/echo'], 'a configured path must not fall through');
});

test('the not-found message says what to install AND to reload the window', () => {
  // The second failure people hit: install while VS Code is open, and it is
  // still not found, because PATH was read at startup.
  const m = notFoundMessage();
  assert.match(m, /brew install mafft/);
  assert.match(m, /conda install -c bioconda mafft/);
  assert.match(m, /reload the window/i);
  assert.match(m, /oveCart\.mafftPath/);
});
