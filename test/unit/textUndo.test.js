'use strict';

/*
 * media/textUndo.js: Cmd+Z in the webview's text boxes.
 *
 * VS Code gives Cmd+Z in a custom editor to the document's undo stack, never
 * to the text box with focus, so the webview has to do it itself. These check
 * which keys it takes and where; test/browser/textUndo.mjs checks that the
 * undo then actually happens, behind a stand-in for VS Code's frame.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { buildEditorHtml } = require('../../src/editorHtml');

const MEDIA = path.join(__dirname, '../../media');

/** Load the script against a stand-in window; returns its API and listeners. */
function load() {
  const listeners = [];
  const window = { addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }) };
  vm.runInNewContext(fs.readFileSync(path.join(MEDIA, 'textUndo.js'), 'utf8'), { window, document: {} });
  return { api: window.OveTextUndo, listeners };
}

const key = (k, mods = {}) => Object.assign({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }, mods);

test('Cmd/Ctrl+Z undoes, with Shift or Ctrl+Y redoes, and nothing else is taken', () => {
  const { commandFor } = load().api;
  assert.strictEqual(commandFor(key('z', { metaKey: true })), 'undo');
  assert.strictEqual(commandFor(key('z', { ctrlKey: true })), 'undo');
  assert.strictEqual(commandFor(key('Z', { metaKey: true, shiftKey: true })), 'redo');
  assert.strictEqual(commandFor(key('Z', { ctrlKey: true, shiftKey: true })), 'redo');
  assert.strictEqual(commandFor(key('y', { ctrlKey: true })), 'redo');
  // Cmd+Y is not redo on a Mac; plain Z is typing; Alt changes the meaning.
  assert.strictEqual(commandFor(key('y', { metaKey: true })), null);
  assert.strictEqual(commandFor(key('z')), null);
  assert.strictEqual(commandFor(key('z', { metaKey: true, altKey: true })), null);
  assert.strictEqual(commandFor(key('f', { metaKey: true })), null);
});

test('only text boxes are taken over; the sequence keeps OVE\'s own undo', () => {
  const { isTextField } = load().api;
  assert.ok(isTextField({ tagName: 'INPUT', type: 'text' }));
  assert.ok(isTextField({ tagName: 'INPUT', type: 'number' }));     // Find's mismatches box
  assert.ok(isTextField({ tagName: 'INPUT' }));                      // no type is text
  assert.ok(isTextField({ tagName: 'TEXTAREA' }));                   // the alignment paste table
  assert.ok(isTextField({ tagName: 'DIV', isContentEditable: true }));
  assert.ok(!isTextField({ tagName: 'INPUT', type: 'checkbox' }));
  assert.ok(!isTextField({ tagName: 'INPUT', type: 'text', readOnly: true }));
  assert.ok(!isTextField({ tagName: 'TEXTAREA', disabled: true }));
  // OVE's sequence view is a focusable div: its Cmd+Z undoes sequence edits.
  assert.ok(!isTextField({ tagName: 'DIV', isContentEditable: false }));
  assert.ok(!isTextField(null));
});

test('it listens in the capture phase, ahead of VS Code\'s frame', () => {
  // VS Code's frame listens for keydown on the same window, bubbling. Only a
  // capture listener runs before it and can keep the key from it.
  const { listeners } = load();
  assert.deepStrictEqual(listeners.map((l) => [l.type, l.capture]), [['keydown', true]]);
});

test('every page with text boxes loads it: the editor, protein or not, and the alignment', () => {
  const base = { textUndoUri: 'textUndo.js', sequenceJson: '{}', viewType: 'both' };
  for (const protein of [false, true]) {
    const html = buildEditorHtml(Object.assign({}, base, { protein }));
    assert.match(html, /<script src="textUndo\.js"><\/script>/, `textUndo.js not loaded (protein: ${protein})`);
  }
  const panel = fs.readFileSync(path.join(__dirname, '../../src/alignPanel.js'), 'utf8');
  assert.match(panel, /src="\$\{uri\('textUndo\.js'\)\}"/);
  const provider = fs.readFileSync(path.join(__dirname, '../../src/editorProvider.js'), 'utf8');
  assert.match(provider, /textUndoUri: this\.mediaUri\(webview, 'textUndo\.js'\)/);
});
