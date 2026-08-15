/*
 * Drives media/EditorDemo.html to check that saving goes through OVE's own
 * File > Save rather than a button of ours.
 *
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/EditorDemo.html --script test/browser/save.mjs
 *
 * Three things, and the first two are what upstream got wrong: OVE hides its
 * Save item unless an onSave prop is passed, and greys it out until
 * sequenceData.stateTrackingId moves on -- which an updateEditor payload does
 * not do by itself, so a programmatic edit has to advance it deliberately.
 */

const saveItem = (page) => page.evaluate(() => {
  const el = [...document.querySelectorAll('.bp3-menu-item')]
    .find((e) => e.textContent.trim().startsWith('Save') && !e.textContent.includes('As'));
  return el && {
    text: el.textContent.trim(),
    disabled: el.classList.contains('bp3-disabled')
  };
});

const openFileMenu = async (page) => {
  await page.locator('.tg-menu-bar button', { hasText: 'File' }).first().click();
  await page.waitForTimeout(350);
};

const saveCount = (page) =>
  page.evaluate(() => Number(document.getElementById('saved').textContent || 0));

export default async function run(page) {
  const fail = [];
  const out = {};

  await page.waitForFunction(() => document.querySelector('.tg-menu-bar'), { timeout: 60000 });
  await page.waitForTimeout(1500);

  /* --- present, and greyed out while nothing has changed ------------------- */

  await openFileMenu(page);
  out.clean = await saveItem(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);

  if (!out.clean) {
    fail.push('no Save item in the File menu — is onSave being passed?');
    return { ...out, failures: fail, ok: false };
  }
  if (!/Command key\s*S|Ctrl.*S/i.test(out.clean.text)) {
    fail.push(`Save shows no hotkey: "${out.clean.text}"`);
  }
  if (!out.clean.disabled) fail.push('Save is enabled before anything has been edited');

  /* --- enabled once an edit lands ----------------------------------------- */

  await page.locator('.translationLayer > g').nth(2).click({ button: 'right', force: true });
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent('__openAA', { detail: { index: 2 } })));
  await page.waitForTimeout(500);
  await page.locator('.oveaa-cell').filter({ hasText: 'TTA' }).first().click();
  await page.waitForTimeout(600);

  await openFileMenu(page);
  out.dirty = await saveItem(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);

  if (out.dirty && out.dirty.disabled) {
    fail.push('Save is still greyed out after an edit — stateTrackingId did not move on');
  }

  /* --- and the hotkey reaches the handler ---------------------------------- */

  const before = await saveCount(page);
  await page.keyboard.press('Meta+s');
  await page.waitForTimeout(500);
  out.saves = await saveCount(page);
  if (out.saves <= before) fail.push('the mod+s hotkey did not trigger a save');

  return { ...out, failures: fail, ok: fail.length === 0 };
}
