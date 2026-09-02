'use strict';

/*
 * Folding the editor's panel groups into one.
 *
 * This runs when Align or the primer cart opens beside the editor: that panel
 * takes half the window, and halving an editor that is already split leaves the
 * sequence and the circular map at a quarter each.
 */

const test = require('node:test');
const assert = require('node:assert');

const { merge } = require('../../media/panelLayout');

const SPLIT = [
  [{ id: 'sequence', name: 'Sequence Map', active: true },
    { id: 'properties', name: 'Properties', active: false }],
  [{ id: 'circular', name: 'Circular Map', active: true }]
];

test('a split becomes one group, in order, losing nothing', () => {
  const merged = merge(SPLIT);
  assert.strictEqual(merged.length, 1, 'should be a single column');
  assert.deepStrictEqual(merged[0].map((p) => p.id),
    ['sequence', 'properties', 'circular']);
});

test('the panel you were looking at stays active, and only it', () => {
  const merged = merge(SPLIT);
  const active = merged[0].filter((p) => p.active);
  assert.deepStrictEqual(active.map((p) => p.id), ['sequence'],
    'the leftmost active panel wins; two active tabs is not a state OVE can draw');
});

test('an already-single group is left alone', () => {
  // Returning null rather than an equivalent array, so the caller can skip the
  // update entirely instead of re-rendering the editor for nothing.
  assert.strictEqual(merge([[{ id: 'sequence', active: true }]]), null);
  assert.strictEqual(merge([]), null);
  assert.strictEqual(merge(undefined), null);
});

test('the input is not mutated', () => {
  const before = JSON.stringify(SPLIT);
  merge(SPLIT);
  assert.strictEqual(JSON.stringify(SPLIT), before,
    'panelsShown comes straight from the editor state and must not be edited in place');
});

test('our own panels are carried across too', () => {
  // Primer Search and New Primer add themselves as groups, so a collapse can
  // meet three of them.
  const merged = merge([
    [{ id: 'sequence', active: true }],
    [{ id: 'circular', active: true }],
    [{ id: 'primerSearch', name: 'Primer Search', active: true, canClose: true }]
  ]);
  assert.deepStrictEqual(merged[0].map((p) => p.id),
    ['sequence', 'circular', 'primerSearch']);
  // canClose has to survive, or the tab loses its close cross.
  assert.strictEqual(merged[0][2].canClose, true);
});

test('a group with nothing active still yields one active tab', () => {
  const merged = merge([[{ id: 'a', active: false }], [{ id: 'b', active: false }]]);
  assert.deepStrictEqual(merged[0].filter((p) => p.active).map((p) => p.id), ['a']);
});
