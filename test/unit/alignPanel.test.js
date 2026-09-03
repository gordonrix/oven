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
      workspace: {
        onDidChangeConfiguration: () => ({ dispose() {} }),
        // ingest reads oven.alignTrimQuality; the default is what matters here.
        getConfiguration: () => ({ get: (_k, fallback) => fallback })
      },
      ViewColumn: { Beside: 2, Active: -1 }
    };
  }
  return realLoad.call(this, request, ...rest);
};

const { AlignPanel, AlignPanels, referenceKey, panelTitle } = require('../../src/alignPanel');

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

/* ------------------------------------------------------ one panel per reference -- */

const REF_A = { name: 'pBT0-150', sequence: 'ACGT', path: '/plasmids/a.gb' };
const REF_B = { name: 'pGR-004', sequence: 'ACGT', path: '/plasmids/b.gb' };

test('a reference is identified by its path, not its name', () => {
  assert.notEqual(referenceKey(REF_A), referenceKey(REF_B));
  // Two files can legitimately hold a plasmid of the same name.
  assert.notEqual(
    referenceKey({ name: 'same', path: '/one.gb' }),
    referenceKey({ name: 'same', path: '/two.gb' })
  );
  assert.equal(referenceKey(null), '');
});

test('the window title carries the reference name', () => {
  assert.equal(panelTitle(REF_A), 'Alignment · pBT0-150');
  assert.equal(panelTitle(null), 'Alignment', 'nothing loaded yet');
});

test('each reference gets its own panel, and the same one on reopening', () => {
  const panels = new AlignPanels({ subscriptions: [], extensionPath: '/x' });
  const opened = [];
  // show() would build a real webview, so stop at the point the panel is chosen.
  AlignPanel.prototype.show = function (ref) { opened.push(this); this.reference = ref; };

  panels.show(REF_A);
  panels.show(REF_B);
  panels.show(REF_A);

  assert.equal(panels.byKey.size, 2, 'two references, two windows');
  assert.equal(opened[0], opened[2], 'reopening a reference reuses its window');
  assert.notEqual(opened[0], opened[1]);
});

test('re-aligning the same reference keeps the results already on screen', () => {
  const panel = new AlignPanel({ subscriptions: [], extensionPath: '/x' });
  panel.setReference(REF_A);
  panel.alignment = { msa: ['ACGT'] };
  panel.reads = [{ id: 1, name: 'r1.ab1', mismatches: 3 }];

  panel.setReference({ ...REF_A });          // Align pressed again on the same plasmid
  assert.ok(panel.alignment, 'the alignment survives');
  assert.equal(panel.reads[0].mismatches, 3);

  panel.setReference(REF_B);                 // a different plasmid does invalidate it
  assert.equal(panel.alignment, null);
  assert.equal(panel.reads[0].mismatches, undefined);
});

/* --- a sequence typed into the panel ------------------------------------- */

/*
 * Wrapped as FASTA and put through the same ingest a dropped file takes, so
 * there is only one notion of a read. What is worth pinning is the tidying:
 * pasted sequence arrives out of numbered blocks and wrapped across lines, and
 * anything left that is not a base has to be refused rather than dropped --
 * silently discarding characters would change what is being aligned.
 */

const freshPanel = () => {
  const panel = new AlignPanel({ subscriptions: [], extensionPath: '/x' });
  panel.afterAdd = () => {};
  return panel;
};

test('whitespace and digits are stripped from a pasted sequence', async () => {
  const panel = freshPanel();
  await panel.addSequence('', '  61 acgt acgt\n  71 GGCCttaa  ');
  assert.strictEqual(panel.reads.length, 1);
  assert.strictEqual(panel.reads[0].sequence.toUpperCase(), 'ACGTACGTGGCCTTAA');
});

test('an unnamed sequence is numbered, and numbers are not reused', async () => {
  const panel = freshPanel();
  await panel.addSequence('', 'ACGTACGTAA');
  await panel.addSequence('', 'GGCCGGCCTT');
  assert.deepStrictEqual(panel.reads.map((r) => r.name), ['sequence1', 'sequence2']);
});

test('a name is used as given', async () => {
  const panel = freshPanel();
  await panel.addSequence('  my oligo  ', 'ACGTACGTAA');
  assert.strictEqual(panel.reads[0].name, 'my oligo');
});

test('anything that is not a base is refused, not quietly dropped', async () => {
  const panel = freshPanel();
  await assert.rejects(() => panel.addSequence('', 'ACGTXXACGT'), /not DNA/);
  await assert.rejects(() => panel.addSequence('', '   '), /Enter a DNA sequence/);
  assert.strictEqual(panel.reads.length, 0, 'nothing should have been added');
});

test('IUPAC ambiguity codes are accepted', async () => {
  // The aligner handles them elsewhere, so refusing them here would be its own
  // inconsistency.
  const panel = freshPanel();
  await panel.addSequence('ambiguous', 'ACGTRYSWKMBDHVN');
  assert.strictEqual(panel.reads.length, 1);
});
