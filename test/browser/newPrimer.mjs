/*
 * New Primer as a side panel.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/EditorDemo.html --script test/browser/newPrimer.mjs
 *
 * The form is Open Vector Editor's own, rendered without its modal wrapper (the
 * AddOrEditPrimerPanel hunk in patches/index.umd.js.patch). What is worth
 * pinning is therefore not the fields but the things that composition can
 * silently lose:
 *
 *   - tgFormValues. The component reads start/end/bases/forward as plain props
 *     rather than from form state; without that HOC the fields still fill in but
 *     "Binding Site Length" renders NaN. It did, until this caught it.
 *   - the form name. Reusing "AddOrEditPrimerDialog" is what makes the editor's
 *     selection reach the fields at all -- the sync dispatches a redux-form
 *     CHANGE at annotationToAdd.formName, and that lookup is hard-coded to the
 *     three dialog names.
 *
 * Note the selection has to be made by a real drag. Dispatching selectionLayer
 * through updateEditor bypasses selectionLayerUpdate, which is where the sync
 * lives, so a test that sets state directly passes nothing useful.
 */
const fields = (page) => page.evaluate(() => {
  const r = document.querySelector('.ovenp-root');
  if (!r) return null;
  const len = /Binding Site Length: ([^\n]*)/.exec(r.innerText);
  return {
    textInputs: [...r.querySelectorAll('input[type=text]')].map((i) => i.value),
    bindingLength: len ? len[1] : null,
    buttons: [...r.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean)
  };
});

const dragOver = async (page, fromX, toX) => {
  const row = page.locator('.veRowItem, .veLinearView, .veVectorInteractionWrapper').first();
  const box = await row.boundingBox();
  if (!box) return false;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + fromX, y);
  await page.mouse.down();
  await page.mouse.move(box.x + toX, y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  return true;
};

const TAIL = 'GGGGCATATG'; // not in the fixture, so every base of it must flag

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.setViewportSize({ width: 1500, height: 900 });
  await page.waitForSelector('.veVectorInteractionWrapper', { timeout: 60000 });
  await page.waitForTimeout(1200);

  out.panelBefore = await page.locator('.ovenp-root').count();
  if (out.panelBefore) fail.push('the panel was open before anything asked for it');

  /* --- it opens as a tab beside the sequence, not over it ------------------ */

  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__openNewPrimer')));
  await page.waitForTimeout(1500);

  out.panelAfter = await page.locator('.ovenp-root').count();
  if (out.panelAfter !== 1) fail.push(`expected one panel, got ${out.panelAfter}`);

  out.tabs = await page.evaluate(() =>
    [...document.querySelectorAll('[class*=veTab]')].map((e) => e.innerText.trim()).filter(Boolean));
  if (!out.tabs.includes('New Primer')) fail.push(`no New Primer tab: ${out.tabs}`);
  // The whole point of not being a modal.
  if (!out.tabs.includes('Sequence Map')) fail.push('the Sequence Map tab disappeared');
  out.sequenceVisible = await page.locator('.veRowItem, .veLinearView').first().isVisible();
  if (!out.sequenceVisible) fail.push('the sequence is hidden while the panel is open');

  // No modal: a dialog would mean this is still the stock behaviour.
  out.dialogs = await page.locator('.bp3-dialog').count();
  if (out.dialogs) fail.push(`New Primer opened a dialog as well as a panel (${out.dialogs})`);

  out.onOpen = await fields(page);
  if (!out.onOpen) fail.push('the panel rendered nothing');
  else if (!out.onOpen.buttons.includes('Save')) {
    fail.push(`no Save button: ${out.onOpen.buttons}`);
  }

  /* --- the fields move on the button, not on the drag --------------------- */

  /*
   * Dragging used to feed the form's start/end on every pointer event, which
   * cost ~84 ms an event against ~16 ms with nothing open, and would wipe a
   * tail you had typed. Now the drag only selects, and Set From Selection is
   * what moves the binding site -- taking its orientation from the Strand
   * radio.
   *
   * The trap worth pinning: props.selectionLayer is not the user's selection
   * once a form is open. mapStateToProps replaces it with the pending
   * annotation's own range, so a button reading it sets its own values back and
   * looks like it does nothing. ovenTrueSelectionLayer is the real one.
   */
  const selectionText = () => page.evaluate(() => {
    const t = [...document.querySelectorAll('.veStatusBarItem')].map((x) => x.textContent).join(' ');
    const m = /Selecting \d+ bps from (\d+) to (\d+)/.exec(t);
    return m ? `${m[1]}..${m[2]}` : 'none';
  });
  const bindFields = async () => (await fields(page)).textInputs.slice(1).join('..');

  out.fieldsAtOpen = await bindFields();
  await dragOver(page, 350, 620);
  out.selectionAfterDrag = await selectionText();
  out.fieldsAfterDrag = await bindFields();

  if (out.selectionAfterDrag === 'none') fail.push('the drag did not select anything');
  if (out.fieldsAfterDrag !== out.fieldsAtOpen) {
    fail.push(`the drag moved the fields on its own: ${out.fieldsAtOpen} -> ${out.fieldsAfterDrag}`);
  }

  out.setButtons = await page.evaluate(() =>
    [...document.querySelectorAll('.ovenp-root button')]
      .map((b) => b.textContent.trim()).filter((t) => /Set From Selection/i.test(t)).length);
  if (out.setButtons !== 1) fail.push(`expected one Set From Selection button, got ${out.setButtons}`);

  await page.locator('.ovenp-root button', { hasText: 'Set From Selection' }).click();
  await page.waitForTimeout(800);
  out.fieldsAfterButton = await bindFields();
  if (out.fieldsAfterButton !== out.selectionAfterDrag) {
    fail.push(`the button should adopt ${out.selectionAfterDrag}, got ${out.fieldsAfterButton}`);
  }

  // Field order: Strand sits below the coordinates, since it decides which way
  // the button reads the bases.
  out.visualOrder = await page.evaluate(() => {
    const body = document.querySelector('.ovenp-root .bp3-dialog-body');
    return [...body.children]
      .map((n) => ({ y: n.getBoundingClientRect().top, t: (n.innerText || '').split('\n')[0] }))
      .filter((x) => x.t)
      .sort((a2, b2) => a2.y - b2.y)
      .map((x) => x.t)
      .slice(0, 4);
  });
  if (JSON.stringify(out.visualOrder) !== JSON.stringify(['Name', 'Bind Start', 'Bind End', 'Strand'])) {
    fail.push(`field order wrong: ${JSON.stringify(out.visualOrder)}`);
  }

  /* --- the bases box, and 5' tails ---------------------------------------- */

  /*
   * OVE builds all of this already -- a field seeded from the selection,
   * reverse-complemented on the bottom strand, that takes free text and marks
   * any base not matching the template with .tg-no-match-seq, which ove.css
   * paints red. It is gated behind allowPrimerBasesToBeEdited, which neither
   * the dialog nor this panel used to pass.
   *
   * The gate in front of the gate is useLinkedOligo: a Teselagen oligo-library
   * idea with no meaning here, forced on in BASE_VALUES and hidden in CSS. If
   * that hiding ever stops matching, the checkbox reappears offering to link
   * the primer to a library this fork does not have.
   */
  const editable = page.locator('.ovenp-root .tg-custom-sequence-editable');
  out.hasBasesBox = await editable.count();
  if (!out.hasBasesBox) fail.push('no bases box -- allowPrimerBasesToBeEdited is not getting through');

  out.linkedOligoVisible = await page.evaluate(() => {
    const row = document.querySelector('.ovenp-root .tg-no-fill-field:has(input[name="useLinkedOligo"])');
    return row ? getComputedStyle(row).display !== 'none' : false;
  });
  if (out.linkedOligoVisible) fail.push('the Linked Oligo row is showing again');

  if (out.hasBasesBox) {
    /*
     * Nothing here follows the selection on its own any more, bases included.
     * Set From Selection is the one way in, which is what keeps a typed tail
     * safe from a stray click.
     */
    // A short, single-line selection: the tail is typed at the very start
    // below, and a wrapped field would make caret placement the thing under
    // test rather than the feature.
    await dragOver(page, 40, 180);
    await page.locator('.ovenp-root button', { hasText: 'Set From Selection' }).click();
    await page.waitForTimeout(800);

    out.basesFromSelection = (await editable.textContent()).trim();
    const [, selStart2, selEnd2] = (await fields(page)).textInputs;
    const want = Number(selEnd2) - Number(selStart2) + 1;
    if (out.basesFromSelection.length !== want) {
      fail.push(`bases box holds ${out.basesFromSelection.length} bp for a ${want} bp selection`);
    }
    if (await page.locator('.ovenp-root .tg-no-match-seq').count()) {
      fail.push('bases taken straight from the template should not be flagged as mismatches');
    }

    // A 5' tail: bases that are deliberately not in the template.
    // Caret to the very start of the field. Home only reaches the start of a
    // visual line, which in a wrapped sequence is not the same thing.
    await page.evaluate(() => {
      const el = document.querySelector('.ovenp-root .tg-custom-sequence-editable');
      el.focus();
      const range = document.createRange();
      range.setStart(el, 0);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.type(TAIL);
    await page.waitForTimeout(900);

    out.basesWithTail = (await editable.textContent()).trim();
    /*
     * Length rather than prefix: typing into a contenteditable through the
     * driver occasionally lands a character a position out as the field
     * re-renders under the caret. That is the harness, not the field -- what
     * has to hold is that the bases grew by the tail and that the extra bases
     * are flagged.
     */
    if (out.basesWithTail.length !== out.basesFromSelection.length + TAIL.length) {
      fail.push(`expected ${out.basesFromSelection.length + TAIL.length} bp after typing a ${TAIL.length} bp tail, got ${out.basesWithTail.length}`);
    }
    if (!out.basesWithTail.endsWith(out.basesFromSelection)) {
      fail.push(`the annealing region should still end the primer: ${out.basesWithTail}`);
    }
    /*
     * Not an exact string match against the tail: the flag is per base against
     * the template at that offset, so a tail base can coincidentally match and
     * go unflagged. What matters is that adding bases the template does not
     * have produces flags, and that a clean selection produced none above.
     */
    out.flagged = await page.evaluate(() =>
      [...document.querySelectorAll('.ovenp-root .tg-no-match-seq')].map((n) => n.textContent).join(''));
    if (!out.flagged.length) fail.push('a tail produced no mismatch flags at all');
    if (out.flagged.length > TAIL.length) {
      fail.push(`more bases flagged (${out.flagged.length}) than the tail is long`);
    }
    out.flaggedColour = await page.evaluate(() => {
      const n = document.querySelector('.ovenp-root .tg-no-match-seq');
      return n ? getComputedStyle(n).color : null;
    });
    if (out.flaggedColour !== 'rgb(255, 0, 0)') {
      fail.push(`mismatches should be red, got ${out.flaggedColour}`);
    }
  }

  /* --- Save writes a primer ----------------------------------------------- */

  const primers = async () => {
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('__publish')));
    await page.waitForTimeout(200);
    return page.evaluate(() =>
      JSON.parse(document.getElementById('editorState').textContent || '{}').primers || []);
  };

  out.primersBefore = (await primers()).length;
  // Read the binding site now: earlier sections move it, so an older value is
  // not what this primer will be created at.
  out.fieldsAtSave = (await fields(page)).textInputs.slice(1).join('..');
  await page.locator('.ovenp-root input[type=text]').first().fill('QA_PANEL_PRIMER');
  await page.waitForTimeout(300);
  await page.locator('.ovenp-root button', { hasText: 'Save' }).click();
  await page.waitForTimeout(1200);

  const after = await primers();
  out.primersAfter = after.length;
  out.created = after[after.length - 1] || null;
  if (out.primersAfter !== out.primersBefore + 1) {
    fail.push(`Save should add one primer: ${out.primersBefore} -> ${out.primersAfter}`);
  } else if (!out.created || out.created.name !== 'QA_PANEL_PRIMER') {
    fail.push(`the created primer kept the wrong name: ${JSON.stringify(out.created)}`);
  } else if (out.created.start !== Number(out.fieldsAtSave.split('..')[0]) - 1) {
    // 1-based in the form, 0-based in the data.
    fail.push(`created at ${out.created.start}, expected ${out.fieldsAtSave}`);
  } else if (out.hasBasesBox && out.created.bases !== out.basesWithTail) {
    // The whole point of a tail is that it survives to the ordered oligo, even
    // though the annotation itself only covers the annealing footprint.
    fail.push(`saved bases ${out.created.bases} do not match the box ${out.basesWithTail}`);
  }

  /* --- OVE's own Create > New Primer opens the panel, not a dialog --------- */

  /*
   * The route that matters. Adding a menu entry of our own beside this one left
   * the obvious path -- right-click > Create > New Primer -- still opening a
   * modal over the sequence, which is the whole thing this replaced. The
   * bundle's newPrimer command is patched instead, so every entry point lands
   * in the same place, and OVE draws the shortcut next to it the way it does
   * for Cut and Undo.
   */
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__closeNewPrimer')));
  await page.waitForTimeout(600);
  out.panelClosed = await page.locator('.ovenp-root').count();
  if (out.panelClosed) fail.push('the panel did not close');

  const box2 = await page.locator('.veRowItem, .veLinearView, .veVectorInteractionWrapper')
    .first().boundingBox();
  await page.mouse.click(box2.x + 120, box2.y + box2.height / 2, { button: 'right' });
  await page.waitForTimeout(700);
  await page.locator('.bp3-menu-item').filter({ hasText: 'Create' }).first().hover();
  await page.waitForTimeout(700);

  const entry = page.locator('.bp3-menu-item').filter({ hasText: 'New Primer' }).first();
  if (!await entry.count()) {
    fail.push('no New Primer entry in the Create menu');
  } else {
    out.menuEntry = (await entry.innerText()).replace(/\n/g, ' ').trim();
    // OVE renders a command's hotkey beside its label; New Feature shows K for
    // mod+k, so New Primer showing nothing would mean the binding never
    // reached the command definition.
    if (!/\S\s+\S/.test(out.menuEntry)) {
      fail.push(`no shortcut shown next to New Primer: "${out.menuEntry}"`);
    }
    await entry.click();
    await page.waitForTimeout(1500);
  }

  out.panelFromMenu = await page.locator('.ovenp-root').count();
  out.dialogFromMenu = await page.locator('.bp3-dialog').count();
  if (out.panelFromMenu !== 1) fail.push('Create > New Primer did not open the panel');
  if (out.dialogFromMenu) fail.push('Create > New Primer still opens the modal');

  /* --- flipping Strand re-reads the bases ---------------------------------- */

  /*
   * The strand decides which way Set From Selection reads the selection, so
   * changing it has to re-read: otherwise the box keeps the sequence of the
   * strand the primer no longer claims to be on.
   */
  const rcOf = (seq) => seq.split('').reverse()
    .map((c) => ({ A: 'T', T: 'A', G: 'C', C: 'G' }[c] || c)).join('');
  const boxNow = () => page.evaluate(() => {
    const el = document.querySelector('.ovenp-root .tg-custom-sequence-editable');
    return el ? el.textContent.trim() : null;
  });
  const setStrand = (fwd) => page.evaluate((f) =>
    document.querySelector(`.ovenp-root input[type=radio][value="${f}"]`).click(), String(fwd));

  // Its own selection: earlier sections leave whatever they left, and a single
  // base is its own reverse complement often enough to prove nothing.
  await dragOver(page, 40, 260);
  await page.locator('.ovenp-root button', { hasText: 'Set From Selection' }).click();
  await page.waitForTimeout(700);
  out.strandForward = await boxNow();
  if (!out.strandForward || out.strandForward.length < 5) {
    fail.push(`expected a real selection to flip, got "${out.strandForward}"`);
  }

  await setStrand(false);
  await page.waitForTimeout(900);
  out.strandReverse = await boxNow();
  if (out.strandReverse !== rcOf(out.strandForward)) {
    fail.push(`flipping to Negative should give the reverse complement: ${out.strandReverse}`);
  }

  await setStrand(true);
  await page.waitForTimeout(900);
  out.strandBack = await boxNow();
  if (out.strandBack !== out.strandForward) {
    fail.push(`flipping back should restore the bases: ${out.strandBack}`);
  }

  /* --- the selection stays visible while a primer is being made ------------ */

  /*
   * mapStateToProps replaces selectionLayer with the pending annotation's range
   * whenever an annotation form is open, so dragging out a new region showed no
   * highlight at all -- only the primer being built. Harmless for the modal,
   * which nothing can be dragged under; useless for a panel, where dragging is
   * the point.
   */
  const highlight = () => page.evaluate(() => {
    const n = document.querySelector('.veSelectionLayer.veRowViewSelectionLayer');
    return n ? Math.round(n.getBoundingClientRect().width) : 0;
  });
  const seqBox2 = await page.locator('.veRowItemSequenceContainer').first().boundingBox();
  const dragY = seqBox2.y + seqBox2.height / 2;
  await page.mouse.move(seqBox2.x + 30, dragY);
  await page.mouse.down();
  await page.mouse.move(seqBox2.x + 200, dragY, { steps: 10 });
  await page.waitForTimeout(400);
  out.highlightEarly = await highlight();
  await page.mouse.move(seqBox2.x + 450, dragY, { steps: 10 });
  await page.waitForTimeout(400);
  out.highlightLate = await highlight();
  await page.mouse.up();
  await page.waitForTimeout(400);

  if (!(out.highlightEarly > 20)) fail.push(`no highlight while dragging: ${out.highlightEarly}px`);
  if (!(out.highlightLate > out.highlightEarly)) {
    fail.push(`the highlight did not follow the drag: ${out.highlightEarly} then ${out.highlightLate}`);
  }

  /* --- characters that are not bases never enter the box ------------------- */

  /*
   * The box is a contenteditable the user edits directly, and what they type
   * only reaches the form after filterSequenceString drops anything invalid.
   * Nothing put the box itself back in step, so a rejected character stayed on
   * screen while the value did not have it -- and backspacing afterwards
   * deleted what was visible while the value lost different characters, so real
   * bases went missing. Filtering at entry means the drift cannot start.
   *
   * Y is deliberately in the junk string: it is a real IUPAC code for C-or-T,
   * so it must survive while X, Z and Q do not.
   */
  const boxText = () => page.evaluate(() => {
    const el = document.querySelector('.ovenp-root .tg-custom-sequence-editable');
    return el ? el.textContent : null;
  });
  // The bases label reads "Bases   (Length: N)"; a bare /Length: (\d+)/ would
  // match "Binding Site Length" first, which is a different number entirely.
  const boxValueLength = () => page.evaluate(() =>
    Number((document.querySelector('.ovenp-root').innerText.match(/\(Length: (\d+)\)/) || [])[1]));

  await page.locator('.ovenp-root button', { hasText: 'Set From Selection' }).click();
  await page.waitForTimeout(700);
  out.junkBefore = await boxText();

  const box = await page.locator('.ovenp-root .tg-custom-sequence-editable').boundingBox();
  await page.mouse.click(box.x + 3, box.y + 8);
  await page.waitForTimeout(250);
  await page.keyboard.type('XYZQ', { delay: 80 });
  await page.waitForTimeout(700);

  out.junkAfterTyping = await boxText();
  if (/[XZQ]/.test(out.junkAfterTyping)) {
    fail.push(`X, Z and Q should never land in the box: ${out.junkAfterTyping}`);
  }
  if (!out.junkAfterTyping.startsWith('Y')) {
    fail.push(`Y is a real ambiguity code and should survive: ${out.junkAfterTyping}`);
  }
  // The box and the value must agree, or deleting will take the wrong things.
  if (out.junkAfterTyping.length !== await boxValueLength()) {
    fail.push(`box shows ${out.junkAfterTyping.length} bases, value holds ${await boxValueLength()}`);
  }

  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(600);
  out.junkAfterDelete = await boxText();
  if (out.junkAfterDelete !== out.junkBefore) {
    fail.push(`deleting the junk lost real bases: ${out.junkBefore} -> ${out.junkAfterDelete}`);
  }

  /* --- a primer over the origin is not all mismatches ---------------------- */

  /*
   * getStructuredBases compared each base against fullSequence[i + start]
   * without wrapping, so on a circular sequence every base past the origin
   * indexed off the end of the string, read undefined, and was marked as not
   * matching -- red from the origin onwards, and exactly one stray red base for
   * a primer crossing by one. veNormOffset was already applied to aRange just
   * above; the comparison was missed.
   */
  const setSelection = (s2, e2) => page.evaluate(([a2, b2]) =>
    document.dispatchEvent(new CustomEvent('__updateEditor', {
      detail: { selectionLayer: { start: a2, end: b2 }, caretPosition: -1 } })), [s2, e2]);
  const markedRun = () => page.evaluate(() =>
    [...document.querySelectorAll('.ovenp-root .tg-custom-sequence-editable span')]
      .map((n) => n.textContent + (n.className.includes('no-match') ? '*' : '')).join(''));

  out.origin = {};
  for (const [label, fwd] of [['forward', 'true'], ['reverse', 'false']]) {
    // 470..12 on the 480 bp fixture, so it runs over the origin.
    await setSelection(470, 12);
    await page.waitForTimeout(400);
    await page.evaluate((f) =>
      document.querySelector(`.ovenp-root input[type=radio][value="${f}"]`).click(), fwd);
    await page.waitForTimeout(300);
    await page.locator('.ovenp-root button', { hasText: 'Set From Selection' }).click();
    await page.waitForTimeout(700);
    const run = await markedRun();
    out.origin[label] = run;
    if (run.includes('*')) {
      fail.push(`${label} primer over the origin flags matching bases: ${run}`);
    }
  }
  await page.evaluate(() =>
    document.querySelector('.ovenp-root input[type=radio][value="true"]').click());
  await page.waitForTimeout(300);

  /* --- the tab closes from its own cross ----------------------------------- */

  /*
   * Reported: drag the panel into the sequence map's group and it becomes
   * impossible to dismiss. The form's Cancel button is inside the panel body,
   * which is only rendered while its tab is active -- so switching to Sequence
   * Map strands it. OVE draws a small-cross on any tab whose panel carries
   * canClose, and ours simply never set it.
   */
  out.crossCount = await page.locator('[class*=veTabActive] .bp3-icon-small-cross').count();
  if (!out.crossCount) fail.push('no close cross on the New Primer tab');
  else {
    // Clicked through the DOM: with focus left in the bases box, Playwright's
    // own click waits on an actionability check that never settles here.
    await page.evaluate(() =>
      document.querySelector('[class*=veTabActive] .bp3-icon-small-cross').click());
    await page.waitForTimeout(1000);
    out.panelAfterCross = await page.locator('.ovenp-root').count();
    out.tabsAfterCross = await page.evaluate(() =>
      [...document.querySelectorAll('[class*=veTab]')].map((e) => e.innerText.trim()).filter(Boolean));
    if (out.panelAfterCross) fail.push('the cross did not close the panel');
    if (out.tabsAfterCross.includes('New Primer')) fail.push('the tab outlived its panel');
  }

  out.FAILURES = fail;
  out.PASS = fail.length === 0;
  return out;
}
