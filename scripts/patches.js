#!/usr/bin/env node
/*
 * Keeps the vendored-bundle patches honest.
 *
 * media/index.umd.js and media/bioparser2.umd.js are prebuilt third-party
 * files, 8 MB between them, and a handful of fixes are applied directly inside
 * them because there is no build-from-source path here (see README.md next to
 * this script's patches). Editing generated code has two failure modes worth
 * engineering against:
 *
 *   - it is invisible in review. A diff of a machine-generated bundle is
 *     unreadable, so a real change and an accident look identical.
 *   - it is silently lost. Drop in a newer bundle and every fix disappears
 *     with no error and no failing build; the symptoms just come back.
 *
 * So the changes are also kept as unified diffs in patches/*.patch -- 220
 * reviewable lines instead of 8 MB -- and this script checks that what is on
 * disk still matches them.
 *
 * The bundles are stored ALREADY PATCHED, deliberately. Storing pristine copies
 * and applying on install is the other way round, but it means a clone or a
 * `vsce package` that skips the step ships a subtly broken extension. Keeping
 * the working files correct and verifying them is the safer direction.
 *
 *   node scripts/patches.js check     what is on disk matches the patches
 *   node scripts/patches.js apply     re-apply after re-vendoring a bundle
 *   node scripts/patches.js write     regenerate the patches from a baseline
 *
 * `check` runs in pretest. It works by reverse-applying each patch: if that
 * succeeds, the file genuinely contains exactly what the patch describes.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PATCH_DIR = path.join(ROOT, 'patches');

const BUNDLES = ['index.umd.js', 'bioparser2.umd.js'];

/* Where a pristine copy of each bundle can be recovered from, for `write`. */
const BASELINE_TAG = 'vendor-1.2.0';

/*
 * Expected checksums of the patched bundles. The reverse-apply below only
 * verifies the regions a patch touches, so on its own it would wave through an
 * edit anywhere else in 8 MB of generated code. The hash closes that; the
 * reverse-apply is what turns "hash mismatch" into a diagnosis.
 */
const SUMS_FILE = path.join(PATCH_DIR, 'bundles.json');

const patchFor = (bundle) => path.join(PATCH_DIR, `${bundle}.patch`);
const rel = (p) => path.relative(ROOT, p);
const sha = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readSums = () =>
  (fs.existsSync(SUMS_FILE) ? JSON.parse(fs.readFileSync(SUMS_FILE, 'utf8')) : {});

function git(args, opts) {
  return execFileSync('git', args, Object.assign({ cwd: ROOT, encoding: 'utf8' }, opts));
}

/** @returns {boolean} did `git apply` accept these arguments? */
function tryGitApply(args) {
  try {
    git(['apply', ...args], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function check() {
  let bad = 0;
  const sums = readSums();
  for (const bundle of BUNDLES) {
    const patch = patchFor(bundle);
    const actual = sha(path.join(ROOT, 'media', bundle));
    const expected = sums[bundle];
    if (expected && expected !== actual) {
      console.error(
        `✖ ${bundle}: checksum does not match. The bundle has been changed outside the `
        + 'patches — re-vendored, hand-edited, or a patch was altered without running '
        + '`node scripts/patches.js write`.');
      bad++;
      continue;
    }
    if (!fs.existsSync(patch)) {
      console.error(`✖ ${bundle}: no patch file at ${rel(patch)}`);
      bad++;
      continue;
    }
    // Reverse-applying proves the file contains exactly what the patch says.
    if (tryGitApply(['--reverse', '--check', patch])) {
      const hunks = fs.readFileSync(patch, 'utf8').split('\n').filter((l) => l.startsWith('@@')).length;
      console.log(`✔ ${bundle}: ${hunks} hunk(s) present and matching`);
      continue;
    }
    bad++;
    // Distinguish "never applied" from "applied but drifted", because the fix
    // is different: one needs `apply`, the other needs a human.
    const forwardClean = tryGitApply(['--check', patch]);
    console.error(
      `✖ ${bundle}: ${forwardClean
        ? 'patches are NOT applied — the bundle looks pristine. Run: node scripts/patches.js apply'
        : 'the patched regions do not match the patch. The bundle was re-vendored or the '
          + 'patch is stale — reconcile it before shipping.'}`
    );
  }

  if (bad) {
    console.error(`\n${bad} bundle(s) out of sync. See patches/README.md.`);
    process.exit(1);
  }
  console.log('\nAll vendored-bundle patches accounted for.');
}

function apply() {
  for (const bundle of BUNDLES) {
    const patch = patchFor(bundle);
    if (tryGitApply(['--reverse', '--check', patch])) {
      console.log(`• ${bundle}: already patched, nothing to do`);
      continue;
    }
    if (!tryGitApply(['--check', patch])) {
      console.error(`✖ ${bundle}: patch does not apply cleanly. Reconcile it by hand.`);
      process.exit(1);
    }
    git(['apply', patch]);
    console.log(`✔ ${bundle}: patched`);
  }
}

/**
 * Regenerate the patches by diffing the working bundle against a pristine copy
 * taken from `BASELINE_TAG`. Use after deliberately changing a patch, so the
 * diff and the bundle never disagree.
 */
function write() {
  const sums = readSums();
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ove-pristine-'));
  for (const bundle of BUNDLES) {
    const pristine = path.join(tmp, bundle);
    fs.writeFileSync(pristine, git(['show', `${BASELINE_TAG}:media/${bundle}`], { maxBuffer: 1 << 28 }));
    let diff = '';
    try {
      // diff exits 1 when files differ, which is the expected case here.
      diff = execFileSync('diff', [
        '-u', '--label', `a/media/${bundle}`, '--label', `b/media/${bundle}`,
        pristine, path.join(ROOT, 'media', bundle)
      ], { encoding: 'utf8', maxBuffer: 1 << 28 });
    } catch (e) {
      if (e.status !== 1) throw e;
      diff = e.stdout;
    }
    fs.writeFileSync(patchFor(bundle), diff);
    sums[bundle] = sha(path.join(ROOT, 'media', bundle));
    console.log(`✔ ${rel(patchFor(bundle))}: ${diff.split('\n').filter((l) => l.startsWith('@@')).length} hunk(s)`);
  }
  fs.writeFileSync(SUMS_FILE, `${JSON.stringify(sums, null, 2)}\n`);
  console.log(`✔ ${rel(SUMS_FILE)}: checksums recorded`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

const mode = process.argv[2] || 'check';
const modes = { check, apply, write };
if (!modes[mode]) {
  console.error(`Usage: node scripts/patches.js [${Object.keys(modes).join('|')}]`);
  process.exit(2);
}
modes[mode]();
