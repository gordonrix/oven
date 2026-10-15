'use strict';

/*
 * Host-side panel behaviour. `vscode` is stubbed the same way cartStore.test.js
 * does it, so the panel can be constructed outside the extension host.
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

/*
 * Settings the panel reads and, from the settings form, writes. Empty means
 * every setting is at its default, which is what most tests want.
 */
const settings = {};
const written = [];
/* What the stubbed confirmation dialog answers. */
let dialogAnswer;
const dialogs = [];

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {
    return {
      window: {
        showWarningMessage: async (message, options, ...items) => {
          dialogs.push({ message, options, items });
          return dialogAnswer;
        }
      },
      commands: {}, Uri: {},
      workspace: {
        onDidChangeConfiguration: () => ({ dispose() {} }),
        getConfiguration: () => ({
          get: (k, fallback) => (k in settings ? settings[k] : fallback),
          inspect: (k) => ({ globalValue: settings[k] }),
          update: async (k, v, target) => { settings[k] = v; written.push([k, v, target]); }
        })
      },
      ViewColumn: { Beside: 2, Active: -1 },
      ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 }
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
  /*
   * Against a DNA reference. With no reference, ACGTXXACGT is classified the
   * way a file holding it would be -- as a protein, since a fifth of it is not
   * nucleotide letters -- and that case has its own tests below.
   */
  const panel = freshPanel();
  panel.setReference({ name: 'plasmid', sequence: 'ACGT'.repeat(50), molecule: 'dna' });
  await assert.rejects(() => panel.addSequence('', 'ACGTXXACGT'), /not DNA/);
  await assert.rejects(() => panel.addSequence('', '   '), /Enter a DNA or protein sequence/);
  assert.strictEqual(panel.reads.length, 0, 'nothing should have been added');
});

test('IUPAC ambiguity codes are accepted', async () => {
  // The aligner handles them elsewhere, so refusing them here would be its own
  // inconsistency.
  const panel = freshPanel();
  await panel.addSequence('ambiguous', 'ACGTRYSWKMBDHVN');
  assert.strictEqual(panel.reads.length, 1);
});

/* ------------------------------------------------------------- proteins -- */

// Synthetic, all twenty residues, with E F I L P Q W -- the letters that are not
// also nucleotide codes -- in every repeat.
const PROTEIN = 'MKEFILPQWYHRDNSTVGACEQLPWFIKYMSTRPEELFKQIGNWDHLAVPRSEYTQCMFIKL';
const proteinRef = () => ({ name: 'enzyme', sequence: PROTEIN.repeat(3), molecule: 'protein' });
const dnaRef = () => ({ name: 'plasmid', sequence: 'ACGTTGCA'.repeat(40), molecule: 'dna' });

test('a protein pasted against a protein reference keeps every residue', async () => {
  const panel = freshPanel();
  panel.setReference(proteinRef());
  await panel.addSequence('variant', PROTEIN);
  assert.strictEqual(panel.reads.length, 1);
  assert.strictEqual(panel.reads[0].sequence, PROTEIN);
  assert.strictEqual(panel.reads[0].molecule, 'protein');
  assert.strictEqual(panel.refusal(panel.reads[0]), null);
});

test('with no reference, a pasted protein is taken as a protein', async () => {
  const panel = freshPanel();
  await panel.addSequence('', PROTEIN);
  assert.strictEqual(panel.reads[0].molecule, 'protein');
  assert.strictEqual(panel.reads[0].sequence, PROTEIN);
});

test('DNA pasted against a protein reference is refused, not read as residues', async () => {
  // Every nucleotide letter is also a residue code, so the alphabet alone
  // would let this through as a protein made of A, C, G and T.
  const panel = freshPanel();
  panel.setReference(proteinRef());
  await assert.rejects(() => panel.addSequence('', 'ACGTACGTTTGACCA'), /looks like DNA/);
  assert.strictEqual(panel.reads.length, 0);
});

test('a protein is held to the protein alphabet', async () => {
  const panel = freshPanel();
  panel.setReference(proteinRef());
  await assert.rejects(() => panel.addSequence('', 'MKEF#ILPQ'), /not a protein sequence: "#"/);
});

test('a trailing stop is dropped and an internal one refused', async () => {
  const panel = freshPanel();
  panel.setReference(proteinRef());
  await panel.addSequence('stopped', `${PROTEIN}*`);
  assert.strictEqual(panel.reads[0].sequence, PROTEIN);
  await assert.rejects(() => panel.addSequence('', 'MKEF*ILPQ'), /stop \(\*\) inside/);
  assert.strictEqual(panel.reads.length, 1);
});

test('a read of the other molecule is refused, in both directions', () => {
  const panel = freshPanel();
  panel.reads = [
    { id: 1, name: 'clone.ab1', molecule: 'dna', sequence: 'ACGT' },
    { id: 2, name: 'variant.faa', molecule: 'protein', sequence: PROTEIN }
  ];
  panel.setReference(proteinRef());
  assert.match(panel.refusal(panel.reads[0]), /DNA — this reference is a protein/);
  assert.strictEqual(panel.refusal(panel.reads[1]), null);

  // Worked out each time, so swapping the reference swaps which is refused,
  // with nothing re-read.
  panel.setReference(dnaRef());
  assert.strictEqual(panel.refusal(panel.reads[0]), null);
  assert.match(panel.refusal(panel.reads[1]), /protein — this reference is DNA/);
});

test('an unreadable file keeps its own error, whatever the reference', () => {
  const panel = freshPanel();
  panel.setReference(proteinRef());
  assert.strictEqual(panel.refusal({ name: 'x.ab1', error: 'bad file' }), 'bad file');
});

test('a reference without a molecule is read off the parser flag', () => {
  const panel = freshPanel();
  panel.setReference({ name: 'p', sequence: PROTEIN, sequenceData: { isProtein: true } });
  assert.strictEqual(panel.reference.molecule, 'protein');
  panel.setReference({ name: 'd', sequence: 'ACGT', sequenceData: {} });
  assert.strictEqual(panel.reference.molecule, 'dna');
});

test('the protein view payload hands OVE plain letters, never isProtein', () => {
  /*
   * With isProtein on a track OVE back-translates it to three times its length
   * and rejects the alignment. So the reference's own parser fields must be
   * stripped, and every track must say it is counted in residues.
   */
  const panel = freshPanel();
  const residues = PROTEIN.repeat(3);
  panel.setReference(Object.assign(proteinRef(), {
    sequenceData: {
      name: 'enzyme', sequence: residues, isProtein: true, proteinSequence: residues,
      proteinSize: residues.length, size: residues.length * 3, type: 'PROTEIN',
      features: [{ id: 'f', name: 'domain', start: 0, end: 30 }]
    }
  }));
  const read = { name: 'variant', sequence: PROTEIN };
  const result = {
    msa: { reference: residues, rows: [{ name: 'variant', sequence: PROTEIN + '-'.repeat(residues.length - PROTEIN.length) }] },
    tracks: [{ sequence: PROTEIN }]
  };
  const payload = panel.toViewPayload(result, [read]);

  assert.strictEqual(payload.molecule, 'protein');
  const ref = payload.tracks[0].sequenceData;
  for (const field of ['isProtein', 'proteinSequence', 'proteinSize', 'size', 'type', 'features']) {
    assert.ok(!(field in ref), `reference still carries ${field}`);
  }
  assert.strictEqual(ref.sequence, residues);
  assert.strictEqual(ref.circular, false);
  for (const track of payload.tracks) {
    assert.strictEqual(track.sequenceData.ovenUnit, 'aa');
    assert.ok(!track.sequenceData.translations, 'no codon translations on a protein');
    assert.ok(!track.chromatogramData);
  }
});

test('run() leaves refused reads out of the alignment', async () => {
  const panel = freshPanel();
  panel.setReference(proteinRef());
  panel.reads = [
    { id: 1, name: 'clone.ab1', molecule: 'dna', sequence: 'ACGTACGT' }
  ];
  let message = '';
  panel.fail = (m) => { message = m; };
  await panel.run();
  assert.match(message, /protein sequence — the ones here are the wrong kind/);
});

/* ------------------------------------------------------------- settings -- */

const resetSettings = () => {
  for (const k of Object.keys(settings)) delete settings[k];
  written.length = 0;
};

test('the settings form saves into the ordinary settings', async () => {
  resetSettings();
  const panel = freshPanel();
  let status = '';
  panel.note = (m) => { status = m; };
  await panel.updateSettings({ strategy: 'accurate', gapOpen: '2.5', gapExtend: '', trimQuality: '15' });
  assert.strictEqual(settings.mafftArgs, '--localpair --maxiterate 1000 --op 2.5');
  assert.strictEqual(settings.alignTrimQuality, 15);
  assert.ok(written.every(([, , target]) => target === 1), 'written to the user settings');
  assert.match(status, /saved/i);
  // And read straight back into the form.
  const shown = panel.settingsState();
  assert.strictEqual(shown.strategy, 'accurate');
  assert.strictEqual(shown.gapOpen, 2.5);
  assert.strictEqual(shown.trimQuality, 15);
});

test('a refused setting writes nothing', async () => {
  resetSettings();
  const panel = freshPanel();
  let error = '';
  panel.fail = (m) => { error = m; };
  await panel.updateSettings({ strategy: 'auto', gapOpen: '-1' });
  assert.match(error, /0 or more/);
  assert.deepStrictEqual(written, []);
});

test('changing the trim setting re-trims reads already in the panel', () => {
  /*
   * Trimming happens when a read is added. Without re-trimming, a new
   * threshold would reach only the reads added after it, and one alignment
   * would hold reads trimmed two ways with nothing to say so.
   */
  resetSettings();
  const panel = freshPanel();
  const seq = 'ACGT'.repeat(30);
  const qual = seq.split('').map((_, i) => (i < 10 || i >= 110 ? 5 : 40));
  const raw = {
    name: 'trace', sequence: seq, sequenceData: { sequence: seq },
    chromatogramData: { baseCalls: seq.split(''), qualNums: qual, baseTraces: seq.split('').map(() => ({})) }
  };
  panel.reads = [{ id: 1, name: 'trace', raw, sequence: seq.slice(10, 110), trimQuality: 20 }];

  settings.alignTrimQuality = 0;           // trim nothing
  panel.retrim();
  assert.strictEqual(panel.reads[0].sequence, seq);
  assert.strictEqual(panel.reads[0].trimQuality, 0);

  settings.alignTrimQuality = 20;          // and back
  panel.retrim();
  assert.ok(panel.reads[0].sequence.length < seq.length);
});

test('a saved alignment records the arguments it was made with', () => {
  // Not whatever the setting says by the time Save is pressed.
  resetSettings();
  settings.mafftArgs = '--retree 1';
  const panel = freshPanel();
  panel.reference = { name: 'ref', sequence: 'ACGT', circular: true, molecule: 'dna' };
  panel.result = {
    mafftArgs: '--localpair --maxiterate 1000',
    msa: { reference: 'ACGT', rows: [{ name: 'r', sequence: 'ACGT' }] },
    tracks: [{ name: 'r', strand: 1, rotation: 0, crossesOrigin: false, anchored: true }]
  };
  panel.aligned = [{ name: 'r', sequence: 'ACGT' }];
  panel.context = { extension: { packageJSON: { version: 'test' } } };
  const text = panel.toFileText({ fsPath: '/tmp/x.sto' });
  // The whole list MAFFT was given: the strategy, and what OVEN adds to it.
  assert.match(text, /^#=GF MAFFT +--localpair --maxiterate 1000 --adjustdirection --preservecase --quiet$/m);
  assert.ok(!/retree/.test(text));
});

test('a protein alignment records the protein flags it was run with', () => {
  resetSettings();
  const panel = freshPanel();
  panel.reference = { name: 'enzyme', sequence: 'MKEF', circular: false, molecule: 'protein' };
  panel.result = {
    mafftArgs: '--auto --nuc',
    msa: { reference: 'MKEF', rows: [{ name: 'r', sequence: 'MKEF' }] },
    tracks: [{ name: 'r', strand: 1, rotation: 0, crossesOrigin: false, anchored: true }]
  };
  panel.aligned = [{ name: 'r', sequence: 'MKEF' }];
  panel.context = { extension: { packageJSON: { version: 'test' } } };
  const line = panel.toFileText({ fsPath: '/tmp/p.sto' }).split('\n').find((l) => l.startsWith('#=GF MAFFT'));
  assert.strictEqual(line.replace(/^#=GF MAFFT +/, ''), '--auto --amino --anysymbol --preservecase --quiet');
});

/* -------------------------------------------------------- pasted tables -- */

test('a pasted table adds every good row and hands back the bad ones', async () => {
  const panel = freshPanel();
  panel.setReference({ name: 'plasmid', sequence: 'ACGT'.repeat(50), molecule: 'dna' });
  const { added, failed } = await panel.addSequences([
    { name: 'T7', sequence: 'TAATACGACTCACTATAGGG' },
    { name: '', sequence: '' },                        // blank row: skipped, not an error
    { name: 'typo', sequence: 'ACGT#ACGT' },
    { name: '', sequence: 'ATTTAGGTGACACTATAGAA' }
  ]);
  assert.strictEqual(added, 2);
  assert.deepStrictEqual(panel.reads.map((r) => r.name), ['T7', 'sequence1']);
  assert.strictEqual(failed.length, 1);
  assert.strictEqual(failed[0].index, 2);
  assert.strictEqual(failed[0].name, 'typo');
  assert.match(failed[0].error, /not DNA: "#"/);
});

test('unnamed rows in one paste are numbered without colliding', async () => {
  const panel = freshPanel();
  await panel.addSequences([
    { name: '', sequence: 'ACGTACGTAC' }, { name: '', sequence: 'GGCCGGCCAA' }, { name: '', sequence: 'TTAATTAACC' }
  ]);
  assert.deepStrictEqual(panel.reads.map((r) => r.name).sort(), ['sequence1', 'sequence2', 'sequence3']);
});

test('one typed sequence still goes in exactly as before', async () => {
  const panel = freshPanel();
  await panel.addSequence('oligo', 'ACGTACGT');
  assert.deepStrictEqual(panel.reads.map((r) => r.name), ['oligo']);
});

/* -------------------------------------------- the reference, saved again -- */

const plasmid = (sequence, features = []) => ({
  name: 'pDemo', path: '/maps/pDemo.gb', sequence, circular: true, molecule: 'dna',
  sequenceData: { name: 'pDemo', sequence, circular: true, features }
});

/** A panel holding an alignment against `ref`, without needing MAFFT. */
function alignedPanel(ref) {
  const panel = freshPanel();
  panel.setReference(ref);
  panel.reads = [{ id: 1, name: 'r', sequence: ref.sequence.slice(0, 20), mismatches: 0 }];
  panel.aligned = panel.reads;
  panel.result = {
    msa: { reference: ref.sequence, rows: [{ name: 'r', sequence: ref.sequence.slice(0, 20) + '-'.repeat(ref.sequence.length - 20) }] },
    tracks: [{ name: 'r', strand: 1, rotation: 0, sequence: ref.sequence.slice(0, 20),
      referenceRow: ref.sequence, readRow: ref.sequence.slice(0, 20) + '-'.repeat(ref.sequence.length - 20) }]
  };
  panel.alignment = { tracks: [], marker: 'original' };
  return panel;
}

test('the same file with a changed sequence replaces the reference and the stale alignment', () => {
  // The bug: same path meant same reference, so a saved edit was ignored
  // until the panel was closed.
  const seq = 'ACGT'.repeat(25);
  const panel = alignedPanel(plasmid(seq));
  let status = '';
  panel.note = (m) => { status = m; };
  const changed = `GATTACA${seq}`;
  panel.setReference(plasmid(changed));
  assert.strictEqual(panel.reference.sequence, changed);
  assert.strictEqual(panel.alignment, null, 'columns against the old sequence mean nothing now');
  assert.strictEqual(panel.result, null);
  assert.strictEqual(panel.reads[0].mismatches, undefined, 'and neither do the old verdicts');
  assert.match(status, /changed since it was aligned/);
});

test('the same file with only its annotations changed is redrawn, not thrown away', () => {
  const seq = 'ACGT'.repeat(25);
  const panel = alignedPanel(plasmid(seq));
  const feature = { id: 'f1', name: 'new feature', start: 2, end: 30, type: 'misc_feature' };
  panel.setReference(plasmid(seq, [feature]));
  assert.ok(panel.result, 'the alignment itself still stands');
  assert.notStrictEqual(panel.alignment.marker, 'original', 'but the view was rebuilt with the new annotations');
  assert.deepStrictEqual(panel.alignment.tracks[0].sequenceData.features, [feature]);
});

test('the same file, unchanged, leaves the view alone', () => {
  // Pressing Align on the plasmid again must not reset the alignment view.
  const seq = 'ACGT'.repeat(25);
  const panel = alignedPanel(plasmid(seq));
  const before = panel.alignment;
  panel.setReference(plasmid(seq));
  assert.strictEqual(panel.alignment, before);
});

/* ---------------------------------------------------------- remove all -- */

test('Remove all clears every sequence and the alignment, once confirmed', async () => {
  const panel = freshPanel();
  panel.setReference({ name: 'plasmid', sequence: 'ACGT'.repeat(50), molecule: 'dna' });
  panel.reads = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }];
  panel.result = { msa: {}, tracks: [] };
  panel.alignment = { tracks: [] };
  dialogs.length = 0;
  dialogAnswer = 'Remove all';
  await panel.removeAll();
  assert.strictEqual(panel.reads.length, 0);
  assert.strictEqual(panel.alignment, null);
  assert.strictEqual(panel.result, null);
  assert.match(dialogs[0].message, /Remove all 3 sequences/);
  assert.strictEqual(dialogs[0].options.modal, true);
  assert.match(dialogs[0].options.detail, /alignment on screen/);
});

test('declining Remove all leaves everything as it was', async () => {
  const panel = freshPanel();
  panel.reads = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
  panel.alignment = { tracks: [] };
  dialogAnswer = undefined;                   // closed the dialog
  await panel.removeAll();
  assert.strictEqual(panel.reads.length, 2);
  assert.ok(panel.alignment);
});

test('Remove all with nothing to remove asks nothing', async () => {
  const panel = freshPanel();
  dialogs.length = 0;
  await panel.removeAll();
  assert.strictEqual(dialogs.length, 0);
});
