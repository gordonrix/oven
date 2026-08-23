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

  /* --- it follows the selection ------------------------------------------- */

  if (!await dragOver(page, 40, 240)) fail.push('could not find the sequence to drag over');
  out.afterDrag = await fields(page);

  const [, start1, end1] = (out.afterDrag && out.afterDrag.textInputs) || [];
  if (!(Number(start1) > 1 && Number(end1) > Number(start1))) {
    fail.push(`dragging did not set a range: ${JSON.stringify(out.afterDrag)}`);
  }
  // The NaN regression: this is computed from props, not form state.
  const len1 = Number(out.afterDrag && out.afterDrag.bindingLength);
  if (!Number.isFinite(len1)) {
    fail.push(`binding site length is not a number: ${out.afterDrag.bindingLength}`);
  } else if (len1 !== Number(end1) - Number(start1) + 1) {
    fail.push(`binding site length ${len1} does not match ${start1}..${end1}`);
  }

  // A second drag has to move it again, or it latched rather than tracked.
  await dragOver(page, 300, 460);
  out.afterSecondDrag = await fields(page);
  const [, start2] = (out.afterSecondDrag && out.afterSecondDrag.textInputs) || [];
  if (start2 === start1) fail.push('the panel stopped following the selection after the first drag');

  /* --- Save writes a primer ----------------------------------------------- */

  const primers = async () => {
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('__publish')));
    await page.waitForTimeout(200);
    return page.evaluate(() =>
      JSON.parse(document.getElementById('editorState').textContent || '{}').primers || []);
  };

  out.primersBefore = (await primers()).length;
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
  } else if (out.created.start !== Number(start2) - 1) {
    // 1-based in the form, 0-based in the data.
    fail.push(`created at ${out.created.start}, expected ${Number(start2) - 1}`);
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

  /* --- the drag itself stays cheap ----------------------------------------- */

  /*
   * The fields are filled when the drag ends, not on every mousemove: stock
   * dispatched two redux-form CHANGEs per pointer event, each re-rendering the
   * whole form, which made selecting against an open panel feel heavy.
   *
   * Two things have to hold. The selection must actually be applied while
   * dragging -- the editor now shows it, which stock never did with a form open
   * -- and its start must be the point the drag began. Writing the selection
   * back mid-drag destroys OVE's own anchor, so an earlier attempt at this had
   * every event after the first arrive with start collapsed to 0, and Bind
   * Start stuck at 1 no matter where you dragged from.
   */
  const selectionText = () => page.evaluate(() => {
    const t = [...document.querySelectorAll('.veStatusBarItem')].map((x) => x.textContent).join(' ');
    const m = /Selecting (\d+) bps from (\d+) to (\d+)/.exec(t);
    return m ? `${m[2]}..${m[3]}` : 'none';
  });

  await dragOver(page, 40, 300);
  out.selectionDuringDrag = await selectionText();
  out.fieldsAfterDrag = (await fields(page)).textInputs;

  if (out.selectionDuringDrag === 'none') {
    fail.push('dragging with the panel open left no selection in the editor');
  } else {
    const [selStart] = out.selectionDuringDrag.split('..');
    const [, fieldStart] = out.fieldsAfterDrag;
    if (selStart !== fieldStart) {
      fail.push(`Bind Start ${fieldStart} does not match the selection ${out.selectionDuringDrag}`);
    }
    // The anchor regression showed up as exactly this.
    if (fieldStart === '1') fail.push('Bind Start collapsed to 1 -- the drag anchor was lost');
  }

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
    await page.locator('[class*=veTabActive] .bp3-icon-small-cross').first().click();
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
