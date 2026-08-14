/*
 * Finding MAFFT, and being clear about it when we cannot.
 *
 * The alignment tool shells out to MAFFT, which the user installs themselves.
 * Two things make "just use PATH" insufficient in practice:
 *
 *   - VS Code captures the login shell's environment when it starts. Installing
 *     MAFFT while VS Code is open leaves it invisible until the window is
 *     reloaded, so the obvious next move -- install, press Align again -- fails
 *     a second time for a reason the first error did not mention.
 *   - `conda install -c bioconda mafft` into a named environment puts the
 *     binary somewhere that is never on the login shell's PATH at all. Without
 *     help, that user has to run `which mafft` in an activated terminal and
 *     paste an absolute path into a setting.
 *
 * So: check PATH, then the handful of places these two package managers
 * actually put things, and only then give up. A configured path is never
 * silently fallen back from -- if someone set it, being told it is wrong is
 * more useful than quietly using a different binary.
 *
 * Verification runs `--version`, which MAFFT prints to STDERR and exits 0 for.
 * Reading only stdout rejects the real thing.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const VERSION_TIMEOUT_MS = 5000;

/* Conda distributions, in the layouts they install themselves into. */
const CONDA_ROOTS = ['miniforge3', 'miniconda3', 'anaconda3', 'mambaforge', 'micromamba', 'miniforge-pypy3'];

/* Package managers that put binaries somewhere fixed. */
const FIXED_DIRS = [
  '/opt/homebrew/bin',  // Homebrew on Apple silicon
  '/usr/local/bin',     // Homebrew on Intel, and most manual installs
  '/opt/local/bin',     // MacPorts
  '/usr/bin'
];

let cached = null;

/** Everywhere worth looking, in the order worth looking. */
function candidatePaths(configuredPath) {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    if (p && !seen.has(p)) { seen.add(p); out.push(p); }
  };

  if (configuredPath && configuredPath !== 'mafft') add(configuredPath);
  add('mafft'); // whatever PATH says, which is the common case
  FIXED_DIRS.forEach((dir) => add(path.join(dir, 'mafft')));

  const home = os.homedir();
  for (const root of CONDA_ROOTS) {
    const base = path.join(home, root);
    add(path.join(base, 'bin', 'mafft'));
    // Named environments, which are the case PATH cannot help with.
    const envs = path.join(base, 'envs');
    let names = [];
    try {
      names = fs.readdirSync(envs, { withFileTypes: true })
        .filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { /* no such distribution installed */ }
    names.forEach((name) => add(path.join(envs, name, 'bin', 'mafft')));
  }
  return out;
}

/**
 * Does this path run, and is it actually MAFFT?
 *
 * @returns {Promise<{ok: boolean, version?: string, reason?: string}>}
 */
function probe(binary) {
  return new Promise((resolve) => {
    execFile(binary, ['--version'], { timeout: VERSION_TIMEOUT_MS }, (err, stdout, stderr) => {
      // MAFFT prints its version to stderr, so both streams matter.
      const output = `${stdout || ''}${stderr || ''}`.trim();
      // Phrased to read after "which ...", which is how they are reported.
      if (err && err.code === 'ENOENT') return resolve({ ok: false, reason: 'does not exist' });
      if (err && (err.code === 'EACCES' || err.code === 'EISDIR')) {
        return resolve({ ok: false, reason: 'is not an executable file' });
      }
      if (err && err.killed) return resolve({ ok: false, reason: 'did not respond' });
      // A version banner, either naming itself or looking like "v7.526".
      if (/mafft/i.test(output) || /^v?\d+\.\d+/m.test(output)) {
        return resolve({ ok: true, version: output.split('\n')[0].trim() });
      }
      resolve({
        ok: false,
        reason: output
          ? `ran, but does not look like MAFFT (said "${output.split('\n')[0].slice(0, 60)}")`
          : 'ran, but printed no version'
      });
    });
  });
}

/**
 * Locate a usable MAFFT.
 *
 * @param {string} configuredPath value of oveCart.mafftPath ('mafft' when unset)
 * @returns {Promise<{ok, path?, version?, viaSetting?, message?, tried?}>}
 */
async function resolveMafft(configuredPath) {
  const configured = String(configuredPath || '').trim();
  const explicit = Boolean(configured && configured !== 'mafft');

  if (explicit) {
    const res = await probe(configured);
    if (res.ok) return { ok: true, path: configured, version: res.version, viaSetting: true };
    // Do not quietly use something else: they told us where it is.
    return {
      ok: false,
      viaSetting: true,
      message: `oveCart.mafftPath points at "${configured}", which ${res.reason}.`,
      tried: [configured]
    };
  }

  const tried = [];
  for (const candidate of candidatePaths(configured)) {
    // Only spawn for something that is actually there. A machine with a dozen
    // conda environments would otherwise pay a process per environment on every
    // failed lookup. The bare name has to go through PATH, so it is exempt.
    if (candidate !== 'mafft' && !fs.existsSync(candidate)) continue;
    const res = await probe(candidate);
    tried.push(candidate);
    if (res.ok) return { ok: true, path: candidate, version: res.version, viaSetting: false };
  }

  return { ok: false, viaSetting: false, message: notFoundMessage(), tried };
}

function notFoundMessage() {
  return 'MAFFT was not found. Install it with "brew install mafft" or ' +
    '"conda install -c bioconda mafft", then reload the window — VS Code reads your ' +
    'PATH when it starts, so a fresh install is invisible until it does. ' +
    'If it lives somewhere unusual, set oveCart.mafftPath to its full path.';
}

/** Cached across calls; the panel invalidates this when the setting changes. */
async function get(configuredPath) {
  if (cached && cached.forPath === configuredPath) return cached.result;
  const result = await resolveMafft(configuredPath);
  cached = { forPath: configuredPath, result };
  return result;
}

function invalidate() {
  cached = null;
}

module.exports = { resolveMafft, get, invalidate, probe, candidatePaths, notFoundMessage };
