'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

/*
 * CartViewProvider needs the vscode module, so stub it before requiring.
 * These tests exist because of a real bug: the panel showed only a stale
 * subset of the cart while the store held everything. Two causes, both about
 * message delivery rather than data:
 *   1. webview.html was assigned before onDidReceiveMessage was registered,
 *      so the panel's opening cart/ready was dropped.
 *   2. postMessage to a hidden webview is discarded outright, so every cart
 *      change made while the panel was collapsed vanished.
 */
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
      workspace: {
        getConfiguration: () => ({ get: (k, d) => d }),
        workspaceFolders: null,
        onDidChangeConfiguration: () => ({ dispose() {} })
      },
      window: {
        showInformationMessage() {}, showWarningMessage() {}, showErrorMessage() {},
        createOutputChannel: () => ({ appendLine() {}, dispose() {} })
      },
      commands: { executeCommand() {} },
      env: { clipboard: { writeText: async () => {} } }
    };
  }
  return realLoad.call(this, request, ...rest);
};

const { CartViewProvider } = require('../../src/cartView');
const { CartStore } = require('../../src/cartStore');

function makeContext() {
  const store = {};
  return {
    extensionPath: '/ext',
    subscriptions: [],
    globalState: {
      get: (k, d) => (k in store ? store[k] : d),
      update: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
      setKeysForSync() {}
    }
  };
}

/** Mock of a WebviewView whose visibility we drive by hand. */
function makeView(visible) {
  const posted = [];
  const visListeners = [];
  const view = {
    visible,
    posted,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview:',
      asWebviewUri: (u) => ({ toString: () => `vscode-webview://${u.fsPath}` }),
      postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
      onDidReceiveMessage: (cb) => { view._msgHandler = cb; return { dispose() {} }; }
    },
    onDidChangeVisibility: (cb) => { visListeners.push(cb); return { dispose() {} }; },
    onDidDispose: () => ({ dispose() {} }),
    setVisible(v) { view.visible = v; visListeners.forEach((cb) => cb()); }
  };
  return view;
}

const primer = (name, seq, file) => ({
  name, sequence: seq, sourcePath: `/p/${file}.gb`, sourceName: file, start: 0, end: seq.length - 1, strand: 1
});

test('the message handler is registered before html is assigned', () => {
  const ctx = makeContext();
  const provider = new CartViewProvider(ctx, new CartStore(ctx));
  const view = makeView(true);

  let handlerAtHtmlAssignment = null;
  Object.defineProperty(view.webview, 'html', {
    set() { handlerAtHtmlAssignment = view._msgHandler; },
    get() { return ''; }
  });

  provider.resolveWebviewView(view);
  assert.ok(handlerAtHtmlAssignment, 'onDidReceiveMessage must be wired up before html runs the panel script');
});

test('pushes the whole cart, not just the most recent source file', async () => {
  const ctx = makeContext();
  const cart = new CartStore(ctx);
  const provider = new CartViewProvider(ctx, cart);
  const view = makeView(true);
  provider.resolveWebviewView(view);

  await cart.add([primer('A_fwd', 'ATGCATGCATGCAAAA', 'fileA')], 500);
  await cart.add([primer('B_fwd', 'GGGGCCCCGGGGTTTT', 'fileB')], 500);
  await cart.add([primer('C_fwd', 'TTTTAAAACCCCGGGG', 'fileC')], 500);

  const last = view.posted[view.posted.length - 1];
  assert.strictEqual(last.type, 'cart/state');
  assert.deepStrictEqual(last.items.map((i) => i.name), ['A_fwd', 'B_fwd', 'C_fwd']);
  assert.deepStrictEqual([...new Set(last.items.map((i) => i.sourceName))], ['fileA', 'fileB', 'fileC']);
});

test('updates made while hidden are delivered when the panel reappears', async () => {
  const ctx = makeContext();
  const cart = new CartStore(ctx);
  const provider = new CartViewProvider(ctx, cart);
  const view = makeView(true);
  provider.resolveWebviewView(view);

  await cart.add([primer('A_fwd', 'ATGCATGCATGCAAAA', 'fileA')], 500);
  const seenWhileVisible = view.posted.length;
  assert.ok(seenWhileVisible > 0);

  // Collapse the panel and keep working -- this is the reported scenario.
  view.setVisible(false);
  await cart.add([primer('B_fwd', 'GGGGCCCCGGGGTTTT', 'fileB')], 500);
  await cart.add([primer('C_fwd', 'TTTTAAAACCCCGGGG', 'fileC')], 500);
  assert.strictEqual(view.posted.length, seenWhileVisible,
    'messages must not be posted to a hidden view -- they would be discarded');
  assert.ok(provider.pending, 'the deferred update should be flagged');

  // Reopening it must resynchronise rather than show the stale snapshot.
  view.setVisible(true);
  const last = view.posted[view.posted.length - 1];
  assert.deepStrictEqual(last.items.map((i) => i.name), ['A_fwd', 'B_fwd', 'C_fwd']);
  assert.strictEqual(provider.pending, false);
});

test('answers cart/ready even when the view reports itself not visible', async () => {
  // The window-reload case. On a restored window resolveWebviewView can run
  // while `visible` is still false, and if no visibility *change* follows, a
  // deferred reply is never flushed -- the panel sits empty while the badge
  // correctly shows a full cart. cart/ready means the panel is alive and
  // waiting, so it must be answered regardless of the visibility flag.
  const ctx = makeContext();
  const cart = new CartStore(ctx);
  await cart.add([
    primer('A_fwd', 'ATGCATGCATGCAAAA', 'fileA'),
    primer('B_fwd', 'GGGGCCCCGGGGTTTT', 'fileB'),
    primer('C_fwd', 'TTTTAAAACCCCGGGG', 'fileC')
  ], 500);

  const provider = new CartViewProvider(ctx, cart);
  const view = makeView(false); // laid out but not yet reported visible
  provider.resolveWebviewView(view);

  assert.strictEqual(view.posted.length, 0, 'nothing sent before the panel asks');

  await view._msgHandler({ type: 'cart/ready' });

  assert.strictEqual(view.posted.length, 1, 'cart/ready must be answered immediately');
  assert.deepStrictEqual(view.posted[0].items.map((i) => i.name), ['A_fwd', 'B_fwd', 'C_fwd']);
});

test('no redundant push when a visible panel is merely re-shown', async () => {
  const ctx = makeContext();
  const cart = new CartStore(ctx);
  const provider = new CartViewProvider(ctx, cart);
  const view = makeView(true);
  provider.resolveWebviewView(view);

  await cart.add([primer('A_fwd', 'ATGCATGCATGCAAAA', 'fileA')], 500);
  const n = view.posted.length;
  view.setVisible(true);
  assert.strictEqual(view.posted.length, n);
});
