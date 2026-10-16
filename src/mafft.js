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
 * actually put things, and only then give up.
 *
 * Windows has neither package manager. MAFFT comes for it two ways, and both
 * are looked for:
 *
 *   - mafft-win, a zip with mafft.bat at its top and a small Cygwin inside. It
 *     is unzipped wherever the user likes, usually Downloads, and is never on
 *     PATH. Node will not start a .bat itself -- doing that safely needs
 *     cmd.exe's quoting -- so it goes through cmd.exe with a command line built
 *     here (see invocation).
 *   - The Ubuntu package, installed into WSL with apt. wsl.exe hands it the
 *     arguments, stdin and stdout untouched, so it needs no path at all and is
 *     stored as the word "wsl". A configured path is never
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
/*
 * Windows gets longer. mafft.bat sets up its Cygwin first, which MAFFT's own
 * page warns is slow under real-time virus scanning, and the first call into
 * WSL starts its virtual machine.
 */
const WINDOWS_VERSION_TIMEOUT_MS = 30000;

/* oven.mafftPath's value for MAFFT installed inside WSL. */
const WSL = 'wsl';

const WINDOWS_DOWNLOAD = 'https://mafft.cbrc.jp/alignment/software/windows_without_cygwin.html';

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

/**
 * Everywhere worth looking, in the order worth looking.
 *
 * `sys` stands in for the machine, so Windows can be tested from anywhere.
 */
function candidatePaths(configuredPath, sys = {}) {
  const platform = sys.platform || process.platform;
  const env = sys.env || process.env;
  const home = sys.home || os.homedir();
  const out = [];
  const seen = new Set();
  const add = (p) => {
    if (p && !seen.has(p)) { seen.add(p); out.push(p); }
  };

  if (configuredPath && configuredPath !== 'mafft') add(configuredPath);
  if (platform === 'win32') {
    windowsCandidates(env, home).forEach(add);
    return out;
  }
  add('mafft'); // whatever PATH says, which is the common case
  FIXED_DIRS.forEach((dir) => add(path.join(dir, 'mafft')));

  for (const root of CONDA_ROOTS) {
    const base = path.join(home, root);
    add(path.join(base, 'bin', 'mafft'));
    // Named environments, which are the case PATH cannot help with.
    subfolders(path.join(base, 'envs')).forEach((name) => add(path.join(base, 'envs', name, 'bin', 'mafft')));
  }
  return out;
}

/*
 * Windows: PATH, then wherever mafft-win was unzipped, then WSL.
 *
 * PATH is read here rather than left to the system, which only finds .exe and
 * .com files on it, and MAFFT is a .bat. The zip unzips to
 * mafft-7.xxx-win64-signed\mafft-win\mafft.bat with Extract All's defaults, or
 * to mafft-win\mafft.bat by hand, so both shapes are looked for in the folders
 * a download usually ends up in.
 */
function windowsCandidates(env, home) {
  const out = [];
  for (const dir of String(env.PATH || env.Path || '').split(';').filter(Boolean)) {
    ['mafft.bat', 'mafft.cmd', 'mafft.exe'].forEach((name) => out.push(path.join(dir, name)));
  }
  const localApp = env.LOCALAPPDATA;
  const roots = [
    home,
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    localApp && path.join(localApp, 'Programs'),
    localApp,
    env.ProgramFiles,
    env.SystemDrive && env.SystemDrive + path.sep
  ].filter(Boolean);
  for (const root of roots) {
    out.push(path.join(root, 'mafft-win', 'mafft.bat'));
    // Newest first, when several versions sit side by side.
    const versions = subfolders(root).filter((name) => /^mafft/i.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const name of versions) {
      out.push(path.join(root, name, 'mafft-win', 'mafft.bat'));
      out.push(path.join(root, name, 'mafft.bat'));
    }
  }
  const system = env.SystemRoot || env.windir || 'C:\\Windows';
  if (fs.existsSync(path.join(system, 'System32', 'wsl.exe'))) out.push(WSL);
  return out;
}

function subfolders(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return []; // not there
  }
}

/**
 * The program to start for a MAFFT, and how.
 *
 * Anywhere but Windows that is just the binary. On Windows a .bat goes through
 * cmd.exe and MAFFT in WSL through wsl.exe, and no console window may flash up
 * for either. Everything that runs MAFFT comes through here.
 *
 * @returns {{file: string, args: string[], options: object}}
 */
function invocation(binary, args, platform = process.platform) {
  if (platform !== 'win32') return { file: binary, args, options: {} };
  const options = { windowsHide: true };
  if (isWsl(binary)) {
    // -e runs mafft itself rather than a shell, so nothing is re-read on the way.
    return { file: 'wsl.exe', args: ['-e', 'mafft', ...args], options };
  }
  if (/\.(bat|cmd)$/i.test(binary)) {
    // cmd.exe /s strips the outer quotes and runs what is inside them as typed.
    const line = [cmdWord(binary, true), ...args.map((a) => cmdWord(a, false))].join(' ');
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      // Run from its own folder, as when double-clicked: mafft.bat moves to
      // whatever folder it starts in, and the extension host's may be anywhere.
      options: { ...options, windowsVerbatimArguments: true, cwd: path.dirname(binary) }
    };
  }
  return { file: binary, args, options };
}

/*
 * One word of a cmd.exe command line. Plain words go as they are and anything
 * else in double quotes, inside which cmd.exe takes & | < > ( ) ^ and spaces
 * literally. What it does not take literally even there -- " itself, and the %
 * and ! that mafft.bat expands -- is refused rather than half escaped.
 */
function cmdWord(word, quote) {
  if (/["%!\r\n]/.test(word)) {
    throw new Error(`${JSON.stringify(word)} has a " % or ! in it, which Windows would change ` +
      'before MAFFT saw it.');
  }
  return quote || !/^[\w.,:=+/\\-]+$/.test(word) ? `"${word}"` : word;
}

function isWsl(binary) {
  return String(binary).toLowerCase() === WSL;
}

/** How to name a MAFFT to the user. */
function describe(binary) {
  return isWsl(binary) ? 'MAFFT in WSL' : binary;
}

/**
 * Does this path run, and is it actually MAFFT?
 *
 * @returns {Promise<{ok: boolean, version?: string, reason?: string}>}
 */
function probe(binary, platform = process.platform) {
  return new Promise((resolve) => {
    // Through cmd.exe a missing .bat is a complaint, not ENOENT, so ask first.
    if (/[\\/]/.test(binary) && !fs.existsSync(binary)) return resolve({ ok: false, reason: 'does not exist' });
    let run;
    try {
      run = invocation(binary, ['--version'], platform);
    } catch {
      return resolve({ ok: false, reason: 'has a " % or ! in its path, which Windows would change' });
    }
    const timeout = platform === 'win32' ? WINDOWS_VERSION_TIMEOUT_MS : VERSION_TIMEOUT_MS;
    execFile(run.file, run.args, { ...run.options, timeout }, (err, stdout, stderr) => {
      // MAFFT prints its version to stderr, so both streams matter. wsl.exe
      // writes its own complaints in UTF-16, hence the NULs.
      const output = `${stdout || ''}${stderr || ''}`.replace(/\0/g, '').trim();
      const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      // Phrased to read after "which ...", which is how they are reported.
      if (err && err.code === 'ENOENT') return resolve({ ok: false, reason: 'does not exist' });
      if (err && (err.code === 'EACCES' || err.code === 'EISDIR')) {
        return resolve({ ok: false, reason: 'is not an executable file' });
      }
      if (err && err.killed) return resolve({ ok: false, reason: 'did not respond' });
      // A version banner, looking like "v7.526", or a line naming itself.
      // mafft.bat says a few things first, so look past them.
      const version = lines.find((l) => /^v?\d+\.\d+/.test(l));
      const named = lines.find((l) => /mafft/i.test(l));
      // WSL without MAFFT names it too, in its error, so there only a clean
      // exit with a version will do.
      const found = isWsl(binary) && platform === 'win32' ? !err && version : version || named;
      if (found) return resolve({ ok: true, version: version || named });
      resolve({
        ok: false,
        reason: output
          ? `ran, but does not look like MAFFT (said "${lines[0].slice(0, 60)}")`
          : 'ran, but printed no version'
      });
    });
  });
}

/**
 * Locate a usable MAFFT.
 *
 * @param {string} configuredPath value of oven.mafftPath ('mafft' when unset)
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
      message: `oven.mafftPath points at "${configured}", which ${res.reason}.`,
      tried: [configured]
    };
  }

  const tried = [];
  for (const candidate of candidatePaths(configured)) {
    // Only spawn for something that is actually there. A machine with a dozen
    // conda environments would otherwise pay a process per environment on every
    // failed lookup. The bare name has to go through PATH, so it is exempt.
    if (candidate !== 'mafft' && !isWsl(candidate) && !fs.existsSync(candidate)) continue;
    const res = await probe(candidate);
    tried.push(candidate);
    if (res.ok) return { ok: true, path: candidate, version: res.version, viaSetting: false };
  }

  return { ok: false, viaSetting: false, message: notFoundMessage(), tried };
}

function notFoundMessage(platform = process.platform) {
  if (platform === 'win32') {
    return 'MAFFT was not found. Download MAFFT for Windows (the all-in-one zip), unzip it ' +
      '— Downloads is fine — and press Re-check, or Locate MAFFT… and pick the mafft.bat in ' +
      'it. MAFFT installed in WSL ("sudo apt install mafft" in Ubuntu) is found too.';
  }
  return 'MAFFT was not found. Install it with "brew install mafft" or ' +
    '"conda install -c bioconda mafft", then reload the window — VS Code reads your ' +
    'PATH when it starts, so a fresh install is invisible until it does. ' +
    'If it lives somewhere unusual, set oven.mafftPath to its full path.';
}

/** What to show someone who has no MAFFT: commands to copy, and a page to download from. */
function installHints(platform = process.platform) {
  if (platform === 'win32') return { commands: ['wsl sudo apt install mafft'], download: WINDOWS_DOWNLOAD };
  if (platform === 'linux') {
    return { commands: ['sudo apt install mafft', 'conda install -c bioconda mafft'], download: null };
  }
  return { commands: ['brew install mafft', 'conda install -c bioconda mafft'], download: null };
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

module.exports = {
  resolveMafft, get, invalidate, probe, candidatePaths, invocation, describe,
  notFoundMessage, installHints, WINDOWS_DOWNLOAD
};
