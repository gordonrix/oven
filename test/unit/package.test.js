'use strict';

/*
 * The manifest, where it claims something the code relies on.
 *
 * VS Code acts on these before any of our code runs, so a wrong one fails in a
 * way no other test can see: the extension is simply not offered for the file,
 * and nothing anywhere reports why.
 */

const test = require('node:test');
const assert = require('node:assert');

const pkg = require('../../package.json');

const editor = (viewType) => pkg.contributes.customEditors.find((e) => e.viewType === viewType);
const selectors = () => editor('oven.editor').selector;

test('the editor claims .ab1, and claims it as binary', () => {
  /*
   * A trace file is opened to be looked at. Without this it is not an OVEN file
   * at all -- VS Code offers it to a text editor, which renders an instrument
   * binary as mojibake, and the only way to see a trace is to align it to
   * something, which needs a reference you may not have.
   *
   * `binary` is the half that is easy to miss: without it VS Code hands the
   * provider a text document, and the bytes are mangled before the parser sees
   * them.
   */
  const ab1 = selectors().find((s) => s.filenamePattern === '*.ab1');
  assert.ok(ab1, `no *.ab1 selector: ${JSON.stringify(selectors().map((s) => s.filenamePattern))}`);
  assert.strictEqual(ab1.binary, true);
});

test('.dna stays binary and the text formats stay text', () => {
  const by = {};
  for (const s of selectors()) by[s.filenamePattern] = s;
  assert.strictEqual(by['*.dna'].binary, true);
  for (const pattern of ['*.gb', '*.gbk', '*.fasta', '*.fa']) {
    assert.ok(by[pattern], `${pattern} is no longer claimed`);
    assert.ok(!by[pattern].binary, `${pattern} should be read as text`);
  }
});

test('a saved alignment opens in OVEN rather than as text', () => {
  /*
   * Its own view type, not another selector on the sequence editor: the two
   * render different things from different files, and a .sto handed to the
   * sequence editor would be parsed as a sequence and come out as nonsense.
   */
  const alignment = editor('oven.alignment');
  assert.ok(alignment, 'no alignment editor is registered');
  const patterns = alignment.selector.map((s) => s.filenamePattern);
  assert.deepStrictEqual(patterns, ['*.sto', '*.stk']);
  // Stockholm is text, and must not be claimed as binary -- the provider reads
  // it through workspace.fs either way, but `binary` changes what VS Code
  // offers the file to elsewhere.
  assert.ok(alignment.selector.every((s) => !s.binary));
});

test('a protein FASTA opens in OVEN, as text', () => {
  const faa = selectors().find((s) => s.filenamePattern === '*.faa');
  assert.ok(faa, '*.faa is not claimed');
  assert.ok(!faa.binary);
});

test('every list of readable extensions agrees', () => {
  /*
   * Four lists of the same thing: what the aligner parses, the two in the panel
   * client (what a drop accepts, and what a dragged path may be), and the
   * Explorer's Add to Alignment. One left behind means a file that can be added
   * one way and is refused another.
   */
  const fs = require('fs');
  const path = require('path');
  const { SEQUENCE_EXTENSIONS } = require('../../src/alignTracks');
  const client = fs.readFileSync(path.join(__dirname, '../../media/alignView.js'), 'utf8');
  const listIn = (name) => {
    const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(client);
    assert.ok(m, `${name} not found in alignView.js`);
    return m[1].split(',').map((x) => x.trim().replace(/'/g, '')).sort();
  };
  const menu = pkg.contributes.menus['explorer/context']
    .find((m) => m.command === 'oven.addToAlignment').when;
  const fromMenu = /\(([^)]*)\)\$/.exec(menu)[1].split('|').sort();

  const expected = [...SEQUENCE_EXTENSIONS].sort();
  assert.deepStrictEqual(listIn('ACCEPT'), expected);
  assert.deepStrictEqual(listIn('READ_EXTENSIONS'), expected);
  assert.deepStrictEqual(fromMenu, expected);
  assert.ok(expected.includes('faa'));
});
