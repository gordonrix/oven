'use strict';

/*
 * The editor page is assembled by string concatenation, so the things worth
 * pinning are the ones a template edit can silently drop: that a restored
 * setting actually reaches the boot payload, and that an absent one leaves no
 * trace behind rather than emitting `undefined` into the page.
 */

const test = require('node:test');
const assert = require('node:assert');

const { buildEditorHtml, panelsShown } = require('../../src/editorHtml');

const OPTS = {
  styleUri: 'ove.css', scriptUri: 'index.umd.js', cartCssUri: 'c.css', searchCssUri: 's.css',
  strandCssUri: 'st.css', sharedUri: 'shared.js', pickerUri: 'picker.js', searchUri: 'search.js',
  strandUri: 'strand.js', toolBtnsUri: 'toolButtons.js',
  cutSitesUri: 'cutSites.js',
  sequenceJson: '{"name":"x","sequence":"ACGT"}', viewType: 'sequence',
  readOnly: false, disableBpEditing: false, autoAddCreatedPrimers: false,
  showSelectionStats: true
};

const FILTER = {
  isEnzymeFilterAnd: true,
  filteredRestrictionEnzymes: [{ value: 'ecori', label: 'EcoRI' }]
};

test('a saved cut-site filter is applied in the boot payload', () => {
  const html = buildEditorHtml(Object.assign({}, OPTS, { cutSiteFilter: FILTER }));
  // It has to be inside the updateEditor call, not merely present somewhere in
  // the page -- that is the difference between applying it and passing it to
  // the client to apply after the first render has already used the default.
  const boot = html.slice(html.indexOf('editor.updateEditor({'));
  assert.match(boot, /restrictionEnzymes: \{/);
  assert.match(boot, /"value":"ecori"/);
  assert.match(boot, /"isEnzymeFilterAnd":true/);
});

test('no saved filter leaves the boot payload untouched', () => {
  const html = buildEditorHtml(Object.assign({}, OPTS, { cutSiteFilter: null }));
  assert.ok(!html.includes('restrictionEnzymes'), 'nothing about enzymes should be emitted');
  // The trap this guards: a template hole that stringifies to "undefined" and
  // becomes a syntax error in the page rather than an absent setting.
  assert.ok(!/updateEditor\(\{[^}]*undefined/.test(html));
  assert.match(html, /OveCutSites\.init\(vscode, editor, null\)/);
});

test('the filter is handed to the client so it is not saved straight back', () => {
  const html = buildEditorHtml(Object.assign({}, OPTS, { cutSiteFilter: FILTER }));
  // init() seeds its "last saved" from this. Without it the client would see a
  // value it had never posted, decide it had changed, and write it again on
  // every open.
  assert.match(html, /OveCutSites\.init\(vscode, editor, \{"isEnzymeFilterAnd":true/);
});

test('the cut-sites client is loaded before the boot script runs', () => {
  const html = buildEditorHtml(Object.assign({}, OPTS, { cutSiteFilter: null }));
  assert.ok(html.indexOf('cutSites.js') < html.indexOf('OveCutSites.init'),
    'the boot script calls into a module that must already be on the page');
});

/* ------------------------------------------------------------------ save -- */

test("saving goes through OVE's own File > Save", () => {
  const html = buildEditorHtml(Object.assign({}, OPTS, { cutSiteFilter: null }));
  // OVE hides its Save item unless onSave is passed, and binds mod+s to it.
  assert.match(html, /onSave: function \(opts, tidiedData, props, onSuccessfulSave\)/);
  // Marking the editor clean is what makes the item grey itself out again.
  assert.match(html, /onSuccessfulSave\(\)/);
  // And the toolbar no longer carries a Save of its own, which could not know
  // whether anything had changed.
  assert.ok(!html.includes('save-button'), 'the bolted-on Save button is gone');
  assert.ok(!/>Save</.test(html.slice(html.indexOf('ove-toolbtns'), html.indexOf('</div>'))),
    'no Save in the button row');
});

test('the button row is the three panels, in order', () => {
  const html = buildEditorHtml(Object.assign({}, OPTS, { cutSiteFilter: null }));
  const row = html.slice(html.indexOf('class="ove-toolbtns"'));
  const labels = [...row.matchAll(/>([A-Z][A-Za-z ]+)</g)].map((m) => m[1]).slice(0, 3);
  assert.deepStrictEqual(labels, ['Align', 'Primer Search', 'Primer Cart']);
});

/*
 * The panel layout, which is what oven.viewType selects between. Groups are laid
 * out left to right, so the order of the outer array is the order on screen --
 * an easy thing to swap by accident, and nothing else would fail if it were.
 */

/** The ids in each group, in order, from the JS literal panelsShown returns. */
function groups(viewType) {
  return new Function(`return ${panelsShown(viewType)}`)()
    .map((group) => group.map((panel) => panel.id));
}

/** The id of the tab that opens active, per group. */
function activeIds(viewType) {
  return new Function(`return ${panelsShown(viewType)}`)()
    .map((group) => (group.find((panel) => panel.active) || {}).id || null);
}

test('split puts the sequence on the left and the circular map on the right', () => {
  assert.deepStrictEqual(groups('split'), [['sequence', 'properties'], ['circular']]);
  // Both halves show something without a click.
  assert.deepStrictEqual(activeIds('split'), ['sequence', 'circular']);
});

test('the single-pane view types put everything in one group', () => {
  for (const viewType of ['sequence', 'circular']) {
    assert.strictEqual(groups(viewType).length, 1, `${viewType} should not split`);
    assert.deepStrictEqual(groups(viewType)[0], ['sequence', 'circular', 'properties']);
  }
  // Each names its own tab as the one to open on.
  assert.deepStrictEqual(activeIds('sequence'), ['sequence']);
  assert.deepStrictEqual(activeIds('circular'), ['circular']);
});

test('an unknown view type falls back to a single pane rather than nothing', () => {
  assert.strictEqual(groups('nonsense').length, 1);
});
