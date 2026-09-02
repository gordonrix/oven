'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

/*
 * These tests exist because of three real bugs, all about message delivery
 * rather than data -- the store was always correct while the panel showed a
 * stale subset or nothing at all:
 *   1. html was assigned before onDidReceiveMessage, so the panel's opening
 *      cart/ready could be dropped.
 *   2. postMessage to a hidden webview is discarded outright, losing every
 *      change made while the panel was in the background.
 *   3. the visibility guard was then applied to cart/ready itself, so on a
 *      restored window the panel's own request for state was deferred and,
 *      with no visibility change to follow, never answered.
 */
let created = null;

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {
    return {
      EventEmitter: class {
        constructor() {
          this._l = [];
          this.event = (cb) => { this._l.push(cb); return { dispose() {} }; };
        }
        fire(v) { this._l.forEach((c) => c(v)); }
      },
      Uri: { file: (p) => ({ fsPath: p, toString: () => `file://${p}` }) },
      ViewColumn: { One: 1, Beside: -2, Active: -1 },
      workspace: {
        getConfiguration: () => ({ get: (k, d) => d }),
        workspaceFolders: null,
        onDidChangeConfiguration: () => ({ dispose() {} })
      },
      window: {
        showInformationMessage() {}, showWarningMessage() {}, showErrorMessage() {},
        createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
        createWebviewPanel: (type, title, showOptions) => makePanel(true, showOptions)
      },
      commands: { executeCommand() {} },
      env: { clipboard: { writeText: async () => {} } }
    };
  }
  return realLoad.call(this, request, ...rest);
};

/** Mock WebviewPanel whose visibility we drive by hand. */
function makePanel(visible, showOptions) {
  const posted = [];
  const viewStateListeners = [];
  const panel = {
    visible,
    posted,
    viewColumn: 1,
    iconPath: null,
    webview: {
      options: {},
      cspSource: 'vscode-webview:',
      asWebviewUri: (u) => ({ toString: () => `vscode-webview://${u.fsPath}` }),
      postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
      onDidReceiveMessage: (cb) => { panel._msgHandler = cb; return { dispose() {} }; }
    },
    onDidChangeViewState: (cb) => { viewStateListeners.push(cb); return { dispose() {} }; },
    onDidDispose: () => ({ dispose() {} }),
    reveal() {},
    setVisible(v) { panel.visible = v; viewStateListeners.forEach((cb) => cb()); }
  };
  // html is a plain property so the ordering test can observe when it is set.
  let html = '';
  Object.defineProperty(panel.webview, 'html', {
    get: () => html,
    set(v) { html = v; panel._handlerAtHtml = panel._msgHandler; }
  });
  panel._showOptions = showOptions;
  created = panel;
  return panel;
}

const { CartPanel } = require('../../src/cartPanel');
// The stub above, not the real module -- these tests never run inside VS Code.
const vscode = require('vscode');
const { CartStore } = require('../../src/cartStore');

function makeContext(seed) {
  const store = Object.assign({}, seed);
  return {
    extensionPath: '/ext',
    subscriptions: [],
    globalState: {
      get: (k, d) => (k in store ? store[k] : d),
      update: async (k, v) => {
        if (v === undefined) delete store[k];
        else store[k] = JSON.parse(JSON.stringify(v));
      },
      setKeysForSync() {}
    },
    _raw: store
  };
}

const primer = (name, seq, file) => ({
  name, sequence: seq, sourcePath: `/p/${file}.gb`, sourceName: file, start: 0, end: seq.length - 1, strand: 1
});

const A = primer('A_fwd', 'ATGCATGCATGCAAAA', 'fileA');
const B = primer('B_fwd', 'GGGGCCCCGGGGTTTT', 'fileB');
const C = primer('C_fwd', 'TTTTAAAACCCCGGGG', 'fileC');

test('the message handler is registered before html is assigned', () => {
  const ctx = makeContext();
  const panel = new CartPanel(ctx, new CartStore(ctx));
  panel.show();
  assert.ok(created._handlerAtHtml, 'onDidReceiveMessage must be wired up before html runs the panel script');
});

test('pushes the whole cart, not just the most recent source file', async () => {
  const ctx = makeContext();
  const cart = new CartStore(ctx);
  const panel = new CartPanel(ctx, cart);
  panel.show();

  await cart.add([A], 500);
  await cart.add([B], 500);
  await cart.add([C], 500);

  const last = created.posted[created.posted.length - 1];
  assert.strictEqual(last.type, 'cart/state');
  assert.deepStrictEqual(last.items.map((i) => i.name), ['A_fwd', 'B_fwd', 'C_fwd']);
  assert.deepStrictEqual([...new Set(last.items.map((i) => i.sourceName))], ['fileA', 'fileB', 'fileC']);
});

test('updates made while hidden are delivered when the panel reappears', async () => {
  const ctx = makeContext();
  const cart = new CartStore(ctx);
  const panel = new CartPanel(ctx, cart);
  panel.show();

  await cart.add([A], 500);
  const seenWhileVisible = created.posted.length;
  assert.ok(seenWhileVisible > 0);

  created.setVisible(false);
  await cart.add([B], 500);
  await cart.add([C], 500);
  assert.strictEqual(created.posted.length, seenWhileVisible,
    'messages must not be posted to a hidden webview -- they would be discarded');
  assert.ok(panel.pending);

  created.setVisible(true);
  const last = created.posted[created.posted.length - 1];
  assert.deepStrictEqual(last.items.map((i) => i.name), ['A_fwd', 'B_fwd', 'C_fwd']);
  assert.strictEqual(panel.pending, false);
});

test('answers cart/ready even when the panel reports itself not visible', async () => {
  const ctx = makeContext();
  const cart = new CartStore(ctx);
  await cart.add([A, B, C], 500);

  const panel = new CartPanel(ctx, cart);
  panel.show();
  created.visible = false;      // restored-but-not-yet-laid-out
  created.posted.length = 0;

  await created._msgHandler({ type: 'cart/ready' });

  assert.strictEqual(created.posted.length, 1, 'cart/ready must be answered immediately');
  assert.deepStrictEqual(created.posted[0].items.map((i) => i.name), ['A_fwd', 'B_fwd', 'C_fwd']);
});

test('state carries the session list and the active session', async () => {
  const ctx = makeContext();
  const cart = new CartStore(ctx);
  const panel = new CartPanel(ctx, cart);
  panel.show();

  await cart.add([A], 500);
  await cart.newSession('batch two');
  await cart.add([B], 500);

  const last = created.posted[created.posted.length - 1];
  assert.deepStrictEqual(last.items.map((i) => i.name), ['B_fwd'], 'only the active session is listed');
  assert.strictEqual(last.sessions.length, 2);
  assert.strictEqual(last.sessions.find((s) => s.id === last.activeId).name, 'batch two');
  const other = last.sessions.find((s) => s.id !== last.activeId);
  assert.strictEqual(other.count, 1, 'the parked session keeps its primers');
});

test('the panel opens beside the editor, in its own group', () => {
  /*
   * Beside halves the editor's group, and a sequence that opens split would
   * then show each of its panes at a quarter of the window. That is handled by
   * collapsing the editor's own split when this opens -- see panels/collapse in
   * editorProvider -- rather than by refusing to split at all, which is what
   * this did for one release.
   */
  const ctx = makeContext();
  const panel = new CartPanel(ctx, new CartStore(ctx));
  panel.show();
  assert.strictEqual(created._showOptions.viewColumn, vscode.ViewColumn.Beside);
});

test('an explicit column still wins', () => {
  const ctx = makeContext();
  const panel = new CartPanel(ctx, new CartStore(ctx));
  panel.show(vscode.ViewColumn.One);
  assert.strictEqual(created._showOptions.viewColumn, vscode.ViewColumn.One);
});
