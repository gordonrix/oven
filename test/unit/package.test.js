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

const selectors = () => pkg.contributes.customEditors[0].selector;

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
