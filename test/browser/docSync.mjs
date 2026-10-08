/*
 * Unsaved changes, between the editor and VS Code.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/EditorDemo.html --script test/browser/docSync.mjs
 *
 * media/docSync.js is the webview half of what makes VS Code show a dirty mark
 * on an OVEN tab and ask before closing it. Without it, VS Code never knew a
 * file had changed: closing an edited plasmid lost the edits without a word.
 *
 * Four things: opening a file is not an edit; an edit is reported, with the
 * sequence a save would write; a save made by VS Code clears OVE's own
 * unsaved mark; and reverting loads what is on disk without that load being
 * reported back as an edit.
 */

const posted = (page) =>
  page.evaluate(() => JSON.parse(document.getElementById('posted').textContent || '[]'));
const changes = async (page) => (await posted(page)).filter((m) => m.type === 'doc/changed');
/*
 * OVE's toolbar Save button: the control wired to its own saved state
 * (lastSavedId), and so the one that greys after OVE saves for itself. A save
 * made by VS Code should leave it exactly the same.
 */
const toolbarSaveDisabled = (page) => page.evaluate(() => {
  const b = document.querySelector('[data-test="saveTool"], .veToolbarItemOuter [data-tip*="Save"], [data-tip="Save"]');
  if (!b) return null;
  const btn = b.closest('button, .bp3-button, .veToolbarItemOuter') || b;
  return btn.classList.contains('bp3-disabled') || btn.disabled || btn.getAttribute('aria-disabled') === 'true';
});
const unsaved = (st) => st.stateTrackingId !== 'initialLoadId' && st.stateTrackingId !== st.lastSavedId;

const state = async (page) => {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__publish')));
  return page.evaluate(() => JSON.parse(document.getElementById('editorState').textContent));
};

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForSelector('.veRowView', { timeout: 30000 });
  await page.waitForTimeout(1500);

  /* --- opening is not an edit -------------------------------------------- */

  out.changesOnOpen = (await changes(page)).length;
  if (out.changesOnOpen) fail.push(`opening the file reported ${out.changesOnOpen} change(s)`);

  /* --- an edit is reported, with what a save would write ----------------- */

  const before = await state(page);

  // Selecting is not an edit.
  const row = page.locator('.veRowView').first();
  const box = await row.boundingBox();
  await page.mouse.move(box.x + 100, box.y + 30);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(box.x + 100 + i * 10, box.y + 30); await page.waitForTimeout(30); }
  await page.mouse.up();
  await page.waitForTimeout(300);
  out.changesFromSelecting = (await changes(page)).length;
  if (out.changesFromSelecting) fail.push(`selecting reported ${out.changesFromSelecting} change(s)`);

  // Deleting the selection is. An updateEditor payload would not do: OVE
  // treats one as a load, not an edit -- which is exactly why a revert is not
  // reported back, below.
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(600);
  const afterEdit = await state(page);
  const after = await changes(page);
  out.changesAfterEdit = after.length;
  out.basesRemoved = before.sequence.length - afterEdit.sequence.length;
  if (!out.basesRemoved) fail.push('the edit did not happen, so this tests nothing');
  if (!after.length) fail.push('an edit was not reported to the host');
  else {
    const data = after[after.length - 1].data || {};
    if (data.sequence !== afterEdit.sequence) fail.push('the reported sequence is not the edited one');
    if (!data.stateTrackingId) fail.push('the reported sequence carries no stateTrackingId');
  }

  /* --- a save by VS Code clears OVE's own unsaved mark --------------------- */

  const dirty = await state(page);
  out.unsavedBeforeSave = unsaved(dirty);
  if (!out.unsavedBeforeSave) fail.push('OVE did not think the edit was unsaved');
  out.saveEnabledBeforeSave = (await toolbarSaveDisabled(page)) === false;
  if (!out.saveEnabledBeforeSave) fail.push("OVE's Save should be enabled with an edit unsaved");
  await page.evaluate((id) => window.postMessage({ type: 'doc/saved', id }, '*'), dirty.stateTrackingId);
  await page.waitForTimeout(300);
  const saved = await state(page);
  out.cleanAfterSave = !unsaved(saved);
  if (!out.cleanAfterSave) fail.push('OVE still thinks there are unsaved changes after VS Code saved');
  out.saveDisabledAfterSave = (await toolbarSaveDisabled(page)) === true;
  if (!out.saveDisabledAfterSave) fail.push("OVE's Save is still enabled after VS Code saved");

  /* --- reverting loads the file, and is not reported as an edit ---------- */

  const countBeforeRevert = (await changes(page)).length;
  await page.evaluate((seq) => window.postMessage({
    type: 'doc/revert', data: { name: 'demo-plasmid', circular: true, sequence: seq }
  }, '*'), before.sequence);
  await page.waitForTimeout(400);
  const reverted = await state(page);
  out.revertedSequence = reverted.sequence === before.sequence;
  if (!out.revertedSequence) fail.push('reverting did not put the file back');
  out.cleanAfterRevert = !unsaved(reverted);
  if (!out.cleanAfterRevert) fail.push('after reverting OVE thinks there are unsaved changes');
  out.changesFromRevert = (await changes(page)).length - countBeforeRevert;
  if (out.changesFromRevert) fail.push('the revert was reported back to the host as an edit');

  out.failures = fail;
  out.ok = fail.length === 0;
  return out;
}
