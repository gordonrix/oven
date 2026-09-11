'use strict';

/*
 * Opening a file from a Sequence Search hit shows the sequence alone.
 *
 * The split view hands half the width to a circular map that cannot show you
 * where a 33 bp hit is, and you got there by asking about a particular stretch
 * of bases. The override has to apply to that one open and no other, which is
 * the part worth pinning: a stale entry would silently change how the file
 * opens the next time, long after the search is forgotten.
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

/** Whatever oven.viewType is set to for the current test. */
let configured = 'split';

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {
    return {
      workspace: { getConfiguration: () => ({ get: () => configured }) },
      window: { showErrorMessage() {} },
      commands: { registerCommand() {}, executeCommand() {} },
      Uri: { file: (p) => ({ fsPath: p }) },
      ViewColumn: { One: 1, Beside: -2 },
      EventEmitter: class {
        constructor() { this.event = () => ({ dispose() {} }); }
        fire() {}
      }
    };
  }
  return realLoad.call(this, request, ...rest);
};

const { DNAViewerProvider } = require('../../src/editorProvider');

/*
 * The stub stays installed for the lifetime of this file. src/config.js
 * requires vscode lazily -- at call time, not load time -- so restoring the
 * real loader here would leave every getter reaching for a module that does
 * not exist outside the extension host.
 */
test.after(() => { Module._load = realLoad; });

const FILE = '/maps/pUC19.gb';

test('a file opened from a hit shows the sequence alone', () => {
  configured = 'split';
  DNAViewerProvider.pendingViewType.set(FILE, 'sequence');
  assert.strictEqual(DNAViewerProvider.takeViewType(FILE), 'sequence');
});

test('the override is spent on the open it was set for', () => {
  configured = 'split';
  DNAViewerProvider.pendingViewType.set(FILE, 'sequence');
  DNAViewerProvider.takeViewType(FILE);

  // Opening the same file any other way is back to the setting. Without this
  // the entry would linger and quietly override an unrelated open later on.
  assert.strictEqual(DNAViewerProvider.takeViewType(FILE), 'split');
  assert.strictEqual(DNAViewerProvider.pendingViewType.size, 0);
});

test('it only applies to the file the hit was in', () => {
  configured = 'circular';
  DNAViewerProvider.pendingViewType.set(FILE, 'sequence');
  assert.strictEqual(DNAViewerProvider.takeViewType('/maps/other.gb'), 'circular');
  DNAViewerProvider.pendingViewType.delete(FILE);
});

test('with no hit pending, the setting decides', () => {
  for (const viewType of ['split', 'sequence', 'circular']) {
    configured = viewType;
    assert.strictEqual(DNAViewerProvider.takeViewType(FILE), viewType);
  }
});
