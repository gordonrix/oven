'use strict';

/*
 * Finding MAFFT. These use real binaries that exist on any Unix -- /bin/echo
 * stands in for "something that runs but is not MAFFT", /tmp for "not an
 * executable", and a made-up path for "not there" -- so the tests exercise the
 * same code paths a misconfigured setting would, with no mocking.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  resolveMafft, probe, candidatePaths, invocation, describe, notFoundMessage, installHints
} = require('../../src/mafft');

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
  assert.match(res.message, /oven\.mafftPath/);
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
  assert.match(m, /oven\.mafftPath/);
});

/* ---------------------------------------------------------------- Windows -- */

/*
 * Windows cannot be run here, so these check what would be started there: the
 * folders looked in, and the exact command line cmd.exe and wsl.exe are given.
 */

test('elsewhere MAFFT is started as itself', () => {
  const run = invocation('/opt/homebrew/bin/mafft', ['--auto', '-'], 'darwin');
  assert.deepStrictEqual(run, { file: '/opt/homebrew/bin/mafft', args: ['--auto', '-'], options: {} });
});

test('on Windows mafft.bat goes through cmd.exe, with its path quoted', () => {
  const bat = 'C:\\Users\\A B\\Downloads\\mafft-7.526-win64-signed (1)\\mafft-win\\mafft.bat';
  const run = invocation(bat, ['--auto', '--op', '1.53', '--preservecase', '--quiet', '-'], 'win32');
  assert.match(run.file, /cmd(\.exe)?$/i);
  assert.deepStrictEqual(run.args, ['/d', '/s', '/c',
    `""${bat}" --auto --op 1.53 --preservecase --quiet -"`]);
  // Node would otherwise quote the line again, and cmd.exe would see the quotes.
  assert.strictEqual(run.options.windowsVerbatimArguments, true);
  assert.strictEqual(run.options.windowsHide, true, 'no console window may flash up');
  assert.strictEqual(run.options.cwd, path.dirname(bat));
});

test('on Windows a word cmd.exe would change is refused, not mangled', () => {
  assert.throws(() => invocation('C:\\100%\\mafft.bat', ['-'], 'win32'), /Move or rename/);
  // mafft.bat itself cannot cope with these in its folder's name.
  assert.throws(() => invocation('C:\\Tom & Jerry\\mafft.bat', ['-'], 'win32'), /Move or rename/);
  assert.throws(() => invocation('C:\\a^b\\mafft.bat', ['-'], 'win32'), /Move or rename/);
  assert.throws(() => invocation('C:\\m\\mafft.bat', ['--op', '!x'], 'win32'), /% or !/);
  assert.throws(() => invocation('C:\\m\\mafft.bat', ['a"b'], 'win32'), /% or !/);
  // Anything else unusual is quoted rather than refused.
  const run = invocation('C:\\m\\mafft.bat', ['a&b'], 'win32');
  assert.ok(run.args[3].endsWith(' "a&b""'), run.args[3]);
});

test('on Windows MAFFT in WSL is reached through wsl.exe, untouched', () => {
  const run = invocation('wsl', ['--auto', '-'], 'win32');
  assert.deepStrictEqual([run.file, ...run.args], ['wsl.exe', '-e', 'mafft', '--auto', '-']);
  assert.strictEqual(run.options.windowsHide, true);
  assert.strictEqual(describe('wsl'), 'MAFFT in WSL');
  assert.strictEqual(describe('/usr/bin/mafft'), '/usr/bin/mafft');
});

test('on Windows the unzipped download is found, then WSL', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oven-win-'));
  try {
    const home = path.join(root, 'home');
    const bat = path.join(home, 'Downloads', 'mafft-7.526-win64-signed', 'mafft-win', 'mafft.bat');
    const older = path.join(home, 'Downloads', 'mafft-7.490-win64-signed', 'mafft-win', 'mafft.bat');
    for (const f of [bat, older]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, '@echo off\n');
    }
    const system = path.join(root, 'Windows');
    fs.mkdirSync(path.join(system, 'System32'), { recursive: true });
    fs.writeFileSync(path.join(system, 'System32', 'wsl.exe'), '');

    const env = { PATH: `${path.join(root, 'tools')};${path.join(root, 'bin')}`, SystemRoot: system };
    const list = candidatePaths('', { platform: 'win32', env, home });
    assert.strictEqual(list[0], path.join(root, 'tools', 'mafft.bat'), 'PATH first, read by hand');
    assert.ok(!list.includes('mafft'), 'Windows cannot find a .bat by its bare name');
    assert.ok(list.indexOf(bat) > 0 && list.indexOf(bat) < list.indexOf(older), 'newest version first');
    assert.strictEqual(list[list.length - 1], 'wsl');

    // Without wsl.exe, WSL is not offered.
    fs.rmSync(path.join(system, 'System32', 'wsl.exe'));
    assert.ok(!candidatePaths('', { platform: 'win32', env, home }).includes('wsl'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mafft.bat talks before its version, and the version is still found', async () => {
  // What mafft-win's mafft.bat prints for --version, all on stderr.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oven-bat-'));
  try {
    const fake = path.join(dir, 'mafft');
    fs.writeFileSync(fake, '#!/bin/sh\nprintf "Active code page: 65001\\r\\n\\r\\nPreparing environment ' +
      'to run MAFFT on Windows.\\r\\nv7.526 (2024/Apr/26)\\n" >&2\n', { mode: 0o755 });
    const res = await probe(fake);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.version, 'v7.526 (2024/Apr/26)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a mafft.bat that is not there says so, even through cmd.exe', async () => {
  const res = await probe('C:\\nope\\mafft-win\\mafft.bat'.replace(/\\/g, path.sep), 'win32');
  assert.deepStrictEqual(res, { ok: false, reason: 'does not exist' });
});

test('each platform is told how to get MAFFT there', () => {
  assert.deepStrictEqual(installHints('darwin').commands,
    ['brew install mafft', 'conda install -c bioconda mafft']);
  assert.ok(installHints('linux').commands.includes('sudo apt install mafft'));
  const win = installHints('win32');
  assert.match(win.download, /^https:\/\/mafft\.cbrc\.jp\//);
  assert.ok(!win.commands.some((c) => /brew|bioconda/.test(c)), 'neither exists on Windows');
  const m = notFoundMessage('win32');
  assert.match(m, /mafft\.bat/);
  assert.match(m, /WSL/);
  assert.doesNotMatch(m, /brew/);
});
