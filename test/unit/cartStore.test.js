'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

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
      }
    };
  }
  return realLoad.call(this, request, ...rest);
};

const { CartStore, SESSIONS_KEY, LEGACY_ITEMS_KEY, SCHEMA_VERSION } = require('../../src/cartStore');

function makeContext(seed) {
  const store = Object.assign({}, seed);
  return {
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

test('accumulates across source files', async () => {
  const cart = new CartStore(makeContext());
  await cart.add([A], 500);
  await cart.add([B], 500);
  await cart.add([C], 500);
  assert.deepStrictEqual(cart.items().map((i) => i.sourceName), ['fileA', 'fileB', 'fileC']);
});

test('dedupes on sequence and records the extra provenance', async () => {
  const cart = new CartStore(makeContext());
  await cart.add([A], 500);
  const res = await cart.add([Object.assign({}, A, { sourcePath: '/p/other.gb', sourceName: 'other' })], 500);

  assert.deepStrictEqual({ added: res.added, duplicates: res.duplicates }, { added: 0, duplicates: 1 });
  assert.strictEqual(cart.items().length, 1, 'the same oligo is one order line');
  assert.deepStrictEqual(cart.items()[0].alsoFoundIn.map((s) => s.sourceName), ['other']);
});

test('refuses to exceed maxItems rather than silently evicting', async () => {
  const cart = new CartStore(makeContext());
  const res = await cart.add([A, B, C], 2);
  assert.strictEqual(res.added, 2);
  assert.strictEqual(res.refused, 1);
  assert.strictEqual(cart.items().length, 2);
});

test('a new session parks the old one instead of deleting it', async () => {
  const cart = new CartStore(makeContext());
  await cart.add([A, B], 500);
  const first = cart.activeSessionId();

  const second = await cart.newSession('batch two');
  assert.notStrictEqual(second.id, first);
  assert.strictEqual(cart.items().length, 0, 'the new session starts empty');

  await cart.add([C], 500);
  assert.deepStrictEqual(cart.items().map((i) => i.name), ['C_fwd']);

  const parked = cart.sessions().find((s) => s.id === first);
  assert.deepStrictEqual(parked.items.map((i) => i.name), ['A_fwd', 'B_fwd']);
});

test('switching sessions swaps which primers are live', async () => {
  const cart = new CartStore(makeContext());
  await cart.add([A], 500);
  const first = cart.activeSessionId();
  await cart.newSession('two');
  await cart.add([B], 500);

  await cart.switchSession(first);
  assert.deepStrictEqual(cart.items().map((i) => i.name), ['A_fwd']);
  assert.deepStrictEqual(cart.keys().length, 1, 'in-cart dimming follows the active session');
});

test('the same sequence can live in two different sessions', async () => {
  // Dedupe is per session -- reordering an old oligo in a new batch is valid.
  const cart = new CartStore(makeContext());
  await cart.add([A], 500);
  await cart.newSession('two');
  const res = await cart.add([A], 500);
  assert.strictEqual(res.added, 1);
  assert.strictEqual(res.duplicates, 0);
});

test('deleting the last session leaves an empty one behind', async () => {
  const cart = new CartStore(makeContext());
  await cart.add([A], 500);
  await cart.deleteSession(cart.activeSessionId());
  assert.strictEqual(cart.sessions().length, 1);
  assert.strictEqual(cart.items().length, 0);
  assert.ok(cart.activeSessionId(), 'there is always an active session');
});

test('deleting the active session activates another', async () => {
  const cart = new CartStore(makeContext());
  await cart.add([A], 500);
  const first = cart.activeSessionId();
  await cart.newSession('two');
  await cart.add([B], 500);

  await cart.deleteSession(cart.activeSessionId());
  assert.strictEqual(cart.activeSessionId(), first);
  assert.deepStrictEqual(cart.items().map((i) => i.name), ['A_fwd']);
});

test('migrates a pre-sessions flat cart without losing anything', async () => {
  // Anyone upgrading from 1.3.x has oveCart.items and no sessions key.
  const legacy = [{
    id: 'legacy-1', schemaVersion: SCHEMA_VERSION, name: 'test1', sequence: 'ACGTACGTACGTACGTACGTA',
    length: 21, tm: 47.8, tmSource: 'computed', sourcePath: '/p/plasmidA.gb', sourceName: 'plasmidA',
    start: 59, end: 79, strand: 1, circularWrap: false, origin: 'created', note: '', addedAt: '2026-08-10T12:38:26.163Z'
  }];
  const ctx = makeContext({ [LEGACY_ITEMS_KEY]: legacy });
  const cart = new CartStore(ctx);

  assert.deepStrictEqual(cart.items().map((i) => i.name), ['test1'], 'legacy items surface as the active session');

  // Once anything is written, the sessions key takes over and the legacy key goes.
  await cart.add([B], 500);
  assert.ok(Array.isArray(ctx._raw[SESSIONS_KEY]));
  assert.strictEqual(ctx._raw[LEGACY_ITEMS_KEY], undefined, 'the legacy key must not linger and resurrect later');
  assert.deepStrictEqual(cart.items().map((i) => i.name), ['test1', 'B_fwd']);
});
