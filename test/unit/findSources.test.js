'use strict';

/*
 * Finding the files of reads dragged in from Finder, which arrive with no
 * path: by name and bytes when saving, by name and sequence when reopening.
 * Real folders under the system temp dir and the synthetic .ab1 fixtures;
 * `vscode` is stubbed only for the parts the panel reads files through.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {
    return {
      window: {}, commands: {}, env: {},
      Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
      workspace: {
        fs: { readFile: async (u) => fs.readFileSync(u.fsPath) },
        workspaceFolders: [],
        onDidChangeConfiguration: () => ({ dispose() {} }),
        getConfiguration: () => ({ get: (k, fallback) => fallback, inspect: () => ({}) })
      },
      ViewColumn: { Beside: 2, Active: -1 },
      ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 }
    };
  }
  return realLoad.call(this, request, ...rest);
};

const { findByName, fileNamesFor } = require('../../src/findSources');
const { buildStockholm, fitsRow } = require('../../src/alignFile');
const { parseFile } = require('../../src/alignTracks');
const { AlignPanel } = require('../../src/alignPanel');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const TRACE = fs.readFileSync(path.join(FIXTURES, 'synthetic-trace.ab1'));
const OTHER = fs.readFileSync(path.join(FIXTURES, 'synthetic-trace-tiny.ab1'));

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oven-find-'));
  for (const [rel, bytes] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, bytes);
  }
  return root;
}

const quietPanel = () => {
  const panel = new AlignPanel({ subscriptions: [], extensionPath: '/x' });
  panel.notes = [];
  panel.note = (m) => panel.notes.push(m);
  panel.fail = (m) => panel.notes.push(`FAIL ${m}`);
  panel.push = () => {};
  return panel;
};

/* ------------------------------------------------------------- the search -- */

test('nearest first, any case, hidden folders and depth limits respected', async () => {
  const root = tree({
    'read1.AB1': 'near',
    'a/b/read1.ab1': 'far',
    '.cache/read1.ab1': 'hidden',
    'a/b/c/d/e/read1.ab1': 'too deep',
    'a/unrelated.ab1': 'x'
  });
  try {
    const found = await findByName([root], ['read1.ab1']);
    assert.deepStrictEqual(found.get('read1.ab1').map((p) => path.relative(root, p)),
      ['read1.AB1', path.join('a', 'b', 'read1.ab1')]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a read name says which files to look for, the trace first', () => {
  assert.deepStrictEqual(fileNamesFor('001_A1_cloneA').slice(0, 2), ['001_A1_cloneA.ab1', '001_A1_cloneA.gb']);
  // One record of several is named "<file> · <record>".
  assert.strictEqual(fileNamesFor('pool · seq2')[0], 'pool.ab1');
  assert.deepStrictEqual(fileNamesFor(''), []);
});

/* -------------------------------------------------------------- reopening -- */

test('an alignment saved without a read\'s file finds it, trace and all', async () => {
  const [track] = await parseFile(TRACE, 'read1.ab1');
  const seq = track.sequence.toUpperCase();
  // The way an experiment is laid out: alignments/ beside sequencing/, and a
  // file of the same name, but not the same read, nearer to hand.
  const root = tree({
    'sequencing/run_ab1-files/read1.ab1': TRACE,
    'alignments/old/read1.ab1': OTHER
  });
  try {
    const sto = path.join(root, 'alignments', 'x.sto');
    fs.writeFileSync(sto, buildStockholm({
      reference: { name: 'ref', row: seq, circular: false },
      // What a Finder drop was saved as before: its bases, and no path.
      reads: [{ name: 'read1', row: seq, strand: 1, rotation: 0, seq }],
      meta: { alphabet: 'dna' }
    }));

    const panel = quietPanel();
    await panel.restore({ fsPath: sto });
    const read = panel.reads[0];
    assert.ok(read.chromatogramData, 'the trace came back');
    assert.strictEqual(read.path, path.join(root, 'sequencing', 'run_ab1-files', 'read1.ab1'));
    assert.match(panel.notes.at(-1), /Found the file of 1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a file whose sequence does not fit the row is not taken for it', async () => {
  const [track] = await parseFile(TRACE, 'read1.ab1');
  const read = { row: track.sequence.toUpperCase(), strand: 1, rotation: 0, readIndex: null };
  assert.strictEqual(fitsRow(track, read, 'dna'), true);
  const [other] = await parseFile(OTHER, 'read1.ab1');
  assert.strictEqual(fitsRow(other, read, 'dna'), false);
  assert.strictEqual(fitsRow(Object.assign({}, track, { molecule: 'protein' }), read, 'dna'), false);
});

/* ----------------------------------------------------------------- saving -- */

test('saving finds a dragged-in read\'s file by its bytes, not its name', async () => {
  const root = tree({
    'alignments/stale/read1.ab1': OTHER,                 // same name, other bytes
    'sequencing/run_ab1-files/read1.ab1': TRACE
  });
  try {
    const panel = quietPanel();
    await panel.addBytes([{ name: 'read1.ab1', base64: TRACE.toString('base64') }]);
    panel.aligned = panel.reads;
    assert.strictEqual(panel.reads[0].path, null, 'a Finder drop has no path');

    assert.strictEqual(await panel.locateDropped(path.join(root, 'alignments')), 1);
    assert.strictEqual(panel.reads[0].path, path.join(root, 'sequencing', 'run_ab1-files', 'read1.ab1'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a dragged-in read with no file on disk stays as it was', async () => {
  const root = tree({ 'alignments/read1.ab1': OTHER });
  try {
    const panel = quietPanel();
    await panel.addBytes([{ name: 'read1.ab1', base64: TRACE.toString('base64') }]);
    panel.aligned = panel.reads;
    assert.strictEqual(await panel.locateDropped(path.join(root, 'alignments')), 0);
    assert.strictEqual(panel.reads[0].path, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
