'use strict';

/*
 * Host-side panel behaviour. `vscode` is stubbed the same way cartStore.test.js
 * does it, so the panel can be constructed outside the extension host.
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {
    return {
      window: {}, commands: {}, Uri: {},
      workspace: { onDidChangeConfiguration: () => ({ dispose() {} }) },
      ViewColumn: { Beside: 2 }
    };
  }
  return realLoad.call(this, request, ...rest);
};

const { AlignPanel } = require('../../src/alignPanel');

const panelWith = (names) => {
  const panel = new AlignPanel({ subscriptions: [], extensionPath: '/x' });
  panel.reads = names.map((name, i) => ({ id: i + 1, name }));
  return panel;
};

test('reads are ordered by name', () => {
  const panel = panelWith(['zeta.ab1', 'alpha.ab1', 'Mike.gb']);
  panel.sortReads();
  assert.deepStrictEqual(panel.reads.map((r) => r.name), ['alpha.ab1', 'Mike.gb', 'zeta.ab1']);
});

test('numbers in a name sort as numbers', () => {
  // The reason this matters: a plate of reads named _1.._12 otherwise comes
  // back 1, 10, 11, 12, 2, ... which is unreadable next to the alignment.
  const panel = panelWith([
    'XZ9D9W_10_pGR-004.ab1', 'XZ9D9W_2_pGR-004.ab1',
    'XZ9D9W_1_pGR-004.ab1', 'XZ9D9W_12_pGR-004.ab1'
  ]);
  panel.sortReads();
  assert.deepStrictEqual(panel.reads.map((r) => r.name), [
    'XZ9D9W_1_pGR-004.ab1', 'XZ9D9W_2_pGR-004.ab1',
    'XZ9D9W_10_pGR-004.ab1', 'XZ9D9W_12_pGR-004.ab1'
  ]);
});

test('case does not split the ordering', () => {
  const panel = panelWith(['beta.ab1', 'Alpha.ab1', 'ALPHA2.ab1']);
  panel.sortReads();
  assert.deepStrictEqual(panel.reads.map((r) => r.name), ['Alpha.ab1', 'ALPHA2.ab1', 'beta.ab1']);
});

test('sorting is stable enough to leave an already-ordered list alone', () => {
  const names = ['a.ab1', 'b.ab1', 'c.ab1'];
  const panel = panelWith(names);
  panel.sortReads();
  assert.deepStrictEqual(panel.reads.map((r) => r.name), names);
});
