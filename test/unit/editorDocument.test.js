'use strict';

/*
 * Unsaved changes in an OVEN editor, as VS Code sees them.
 *
 * Until this, VS Code was never told an OVEN document had changed: no dirty
 * mark on the tab, no "Do you want to save?" when closing it or quitting, and
 * Save All passed it by. These drive the real provider -- resolveCustomEditor
 * included -- against a stubbed vscode and a real file on disk, and pin the
 * whole loop: an edit marks it once, VS Code's save writes it and tells the
 * editor, OVE's own save goes the same way without saving twice, revert reads
 * the disk, and a backup taken for hot exit reopens with its changes.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const fires = [];
const saves = [];
const aligned = [];   // what each Align handed the alignment panel
let provider = null;

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {
    const Uri = {
      file: (p) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
      parse: (u) => ({ fsPath: decodeURIComponent(String(u).replace(/^file:\/\//, '')), scheme: 'file', toString: () => u })
    };
    return {
      Uri,
      EventEmitter: class {
        constructor() { this.event = () => ({ dispose() {} }); }
        fire(e) { fires.push(e); }
      },
      ViewColumn: { One: 1, Beside: -2 },
      window: { showErrorMessage() {}, showInformationMessage() {} },
      commands: { registerCommand() {}, executeCommand() {} },
      workspace: {
        getConfiguration: () => ({ get: (_k, fallback) => fallback }),
        // VS Code's save of a custom document calls back into the provider.
        save: async (uri) => { saves.push(uri.fsPath); await provider.saveCustomDocument(provider.__doc); return uri; },
        fs: {
          readFile: async (uri) => new Uint8Array(fs.readFileSync(uri.fsPath)),
          writeFile: async (uri, bytes) => fs.writeFileSync(uri.fsPath, Buffer.from(bytes)),
          delete: async (uri) => fs.unlinkSync(uri.fsPath)
        }
      }
    };
  }
  return realLoad.call(this, request, ...rest);
};

const { DNAViewerProvider } = require('../../src/editorProvider');
const { genbankToJson } = require('../../media/bioparser2.umd.js');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'synthetic-plasmid.gb');

/** A provider with a document open on a fresh copy of the fixture. */
async function openEditor({ backupId } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oven-doc-'));
  const file = path.join(dir, 'plasmid.gb');
  fs.copyFileSync(FIXTURE, file);
  fires.length = 0;
  saves.length = 0;
  aligned.length = 0;

  provider = new DNAViewerProvider(
    { extensionPath: path.join(__dirname, '..', '..'), globalState: { get: (_k, d) => d, update: async () => {} } },
    { items: () => [], keys: () => [], onDidChange: () => ({ dispose() {} }) },
    { show() {} }, { show: (ref) => aligned.push(ref) }, { show() {} });

  const uri = { fsPath: file, scheme: 'file', toString: () => `file://${file}` };
  const document = await provider.openCustomDocument(uri, { backupId });
  provider.__doc = document;

  const posted = [];
  let handler = null;
  const panel = {
    visible: true,
    webview: {
      options: {}, html: '',
      asWebviewUri: (u) => u.fsPath,
      onDidReceiveMessage: (fn) => { handler = fn; return { dispose() {} }; },
      postMessage: (m) => { posted.push(m); return Promise.resolve(true); }
    },
    onDidChangeViewState: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} })
  };
  await provider.resolveCustomEditor(document, panel);
  return { dir, file, document, posted, send: (m) => handler(m) };
}

const sequenceOnDisk = (file) =>
  genbankToJson(fs.readFileSync(file, 'utf8'))[0].parsedSequence.sequence.toUpperCase();

/** What the editor posts after an edit: its sequence, with a new tracking id. */
const edited = (file, id) => {
  const data = genbankToJson(fs.readFileSync(file, 'utf8'))[0].parsedSequence;
  data.sequence = `GATTACA${data.sequence}`;
  data.stateTrackingId = id;
  return data;
};

test('the provider is editable, which is what gives VS Code a dirty mark at all', () => {
  const p = new DNAViewerProvider({}, {}, {}, {}, {});
  assert.strictEqual(typeof p.onDidChangeCustomDocument, 'function');
  for (const m of ['saveCustomDocument', 'saveCustomDocumentAs', 'revertCustomDocument', 'backupCustomDocument']) {
    assert.strictEqual(typeof p[m], 'function', `${m} is missing`);
  }
});

test('an edit marks the document once, and saving writes it and tells the editor', async () => {
  const { file, document, posted, send } = await openEditor();
  assert.strictEqual(document.dirty, false);

  await send({ type: 'doc/changed', data: edited(file, 'edit-1') });
  await send({ type: 'doc/changed', data: edited(file, 'edit-2') });
  assert.strictEqual(fires.length, 1, 'VS Code is told once, not on every keystroke');
  assert.strictEqual(document.dirty, true);

  await provider.saveCustomDocument(document);
  assert.match(sequenceOnDisk(file), /^GATTACA/);
  assert.strictEqual(document.dirty, false);
  assert.deepStrictEqual(posted.filter((m) => m.type === 'doc/saved').pop(), { type: 'doc/saved', id: 'edit-2' });

  // And the next edit after a save marks it again.
  await send({ type: 'doc/changed', data: edited(file, 'edit-3') });
  assert.strictEqual(fires.length, 2);
});

test("OVE's own Save goes through VS Code, and Cmd+S does not save twice", async () => {
  const { file, send } = await openEditor();
  const data = edited(file, 'edit-1');
  await send({ type: 'doc/changed', data });
  await send({ type: 'save', data });
  assert.strictEqual(saves.length, 1, 'saved through VS Code, so the dirty mark clears');
  assert.match(sequenceOnDisk(file), /^GATTACA/);

  // Cmd+S reaches both VS Code and OVE: VS Code saves first, and OVE's save of
  // the very same state then finds nothing new.
  await send({ type: 'save', data });
  assert.strictEqual(saves.length, 1);
});

test('revert reads the file again and hands it to the editor', async () => {
  const { file, document, posted, send } = await openEditor();
  const original = sequenceOnDisk(file);
  await send({ type: 'doc/changed', data: edited(file, 'edit-1') });
  await provider.revertCustomDocument(document);
  const msg = posted.filter((m) => m.type === 'doc/revert').pop();
  assert.ok(msg, 'the editor was not told to revert');
  assert.strictEqual(String(msg.data.sequence).toUpperCase(), original);
  assert.strictEqual(document.dirty, false);
});

test('a backup holds the unsaved edit, and reopening from it starts with changes to save', async () => {
  const { dir, file, document, send } = await openEditor();
  await send({ type: 'doc/changed', data: edited(file, 'edit-1') });
  const destination = { fsPath: path.join(dir, 'backup.gb'), toString: () => `file://${path.join(dir, 'backup.gb')}` };
  const backup = await provider.backupCustomDocument(document, { destination });
  assert.match(sequenceOnDisk(destination.fsPath), /^GATTACA/);
  assert.doesNotMatch(sequenceOnDisk(file), /^GATTACA/, 'the file itself is untouched');

  // VS Code reopens with the backup's id after a restart.
  const reopened = await openEditor({ backupId: backup.id });
  assert.strictEqual(reopened.document.dirty, true);
  assert.match(String(reopened.document.latest.sequence).toUpperCase(), /^GATTACA/);

  await backup.delete();
  assert.ok(!fs.existsSync(destination.fsPath));
});

test('Save As writes the format the new name asks for', async () => {
  const { dir, file, document, send } = await openEditor();
  await send({ type: 'doc/changed', data: edited(file, 'edit-1') });
  const target = { fsPath: path.join(dir, 'copy.fasta') };
  await provider.saveCustomDocumentAs(document, target);
  const text = fs.readFileSync(target.fsPath, 'utf8');
  assert.match(text, /^>/, 'written as FASTA, not GenBank');
  assert.match(text.split('\n').slice(1).join('').toUpperCase(), /^GATTACA/);
});

/* --------------------------------------------- Align after an edit -- */

test('after a save, Align uses the saved sequence, not the one opened', async () => {
  /*
   * The bug: Align took its reference from the parse made when the file was
   * opened, so an edit saved since reached the alignment only once the file
   * was closed and opened again.
   */
  const { file, document, send } = await openEditor();
  const original = sequenceOnDisk(file);
  await send({ type: 'doc/changed', data: edited(file, 'edit-1') });
  await provider.saveCustomDocument(document);

  await send({ type: 'align/open' });
  const ref = aligned.pop();
  assert.strictEqual(String(ref.sequence).toUpperCase(), sequenceOnDisk(file));
  assert.notStrictEqual(String(ref.sequence).toUpperCase(), original);
  assert.strictEqual(ref.unsavedEdits, false);
});

test('with unsaved edits, Align uses the file as saved, and says so', async () => {
  // Deliberately: an edit not yet saved must not quietly become the reference.
  const { file, send } = await openEditor();
  const original = sequenceOnDisk(file);
  await send({ type: 'doc/changed', data: edited(file, 'edit-1') });
  await send({ type: 'align/open' });
  const ref = aligned.pop();
  assert.strictEqual(String(ref.sequence).toUpperCase(), original);
  assert.strictEqual(ref.unsavedEdits, true);
});
