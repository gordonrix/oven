'use strict';

/*
 * The panel's settings form, as a round trip through the one string MAFFT is
 * given. The thing worth pinning is that nothing is lost: a strategy typed
 * into settings.json by hand must survive being shown in the form and saved.
 */

const test = require('node:test');
const assert = require('node:assert');

const { PRESETS, parseMafftArgs, composeMafftArgs, validate } = require('../../src/alignSettings');

test('the default reads as Auto with default penalties', () => {
  assert.deepStrictEqual(parseMafftArgs('--auto'),
    { strategy: 'auto', custom: '', gapOpen: null, gapExtend: null });
  assert.deepStrictEqual(parseMafftArgs(''),
    { strategy: 'auto', custom: '', gapOpen: null, gapExtend: null });
});

test('each preset round-trips', () => {
  for (const p of PRESETS) {
    const parsed = parseMafftArgs(p.args);
    assert.strictEqual(parsed.strategy, p.id);
    assert.strictEqual(composeMafftArgs(parsed), p.args);
  }
});

test('gap penalties are read out of the string and put back', () => {
  const parsed = parseMafftArgs('--localpair --maxiterate 1000 --op 2.5 --ep 0.1');
  assert.deepStrictEqual(parsed, { strategy: 'accurate', custom: '', gapOpen: 2.5, gapExtend: 0.1 });
  assert.strictEqual(composeMafftArgs(parsed), '--localpair --maxiterate 1000 --op 2.5 --ep 0.1');
  assert.strictEqual(parseMafftArgs('--auto --op=3').gapOpen, 3);
});

test('a strategy written by hand is kept, not replaced', () => {
  const parsed = parseMafftArgs('--globalpair --maxiterate 100 --op 2');
  assert.strictEqual(parsed.strategy, 'custom');
  assert.strictEqual(parsed.custom, '--globalpair --maxiterate 100');
  assert.strictEqual(composeMafftArgs(parsed), '--globalpair --maxiterate 100 --op 2');
});

test('an empty box means MAFFT\'s default, not zero', () => {
  assert.strictEqual(composeMafftArgs({ strategy: 'auto', gapOpen: '', gapExtend: null }), '--auto');
  assert.strictEqual(composeMafftArgs({ strategy: 'auto', gapOpen: 0 }), '--auto --op 0');
});

test('bad input is refused before MAFFT sees it', () => {
  assert.strictEqual(validate({ strategy: 'auto', gapOpen: 1.53, trimQuality: 20 }), null);
  assert.match(validate({ strategy: 'auto', gapOpen: -1 }), /0 or more/);
  assert.match(validate({ strategy: 'auto', gapExtend: 'lots' }), /must be a number/);
  assert.match(validate({ strategy: 'auto', trimQuality: 20.5 }), /whole Phred/);
  assert.match(validate({ strategy: 'auto', trimQuality: 99 }), /0 to 60/);
  assert.match(validate({ strategy: 'custom', custom: '' }), /needs MAFFT arguments/);
  assert.match(validate({ strategy: 'custom', custom: 'reads.fasta' }), /MAFFT options/);
  assert.match(validate({ strategy: 'custom', custom: '--auto -' }), /adds "-" itself/);
  assert.match(validate({ strategy: 'custom', custom: '--adjustdirection' }), /adds --adjustdirection/);
  assert.match(validate({ strategy: 'nonsense' }), /Choose a strategy/);
});
