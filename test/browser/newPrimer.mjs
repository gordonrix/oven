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

  out.FAILURES = fail;
  out.PASS = fail.length === 0;
  return out;
}
