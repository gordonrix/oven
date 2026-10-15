/*
 * New Part is gone; its mod+l is New Translation, and mod+shift+l New
 * Reverse Translation.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/EditorDemo.html --script test/browser/translationHotkeys.mjs
 *
 * Guards the newPart and getNewTranslationHandler hunks of the bundle patch.
 */

const state = async (page) => {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__publish')));
  return page.evaluate(() => JSON.parse(document.getElementById('editorState').textContent));
};

const select = (page, start, end) => page.evaluate(({ start, end }) => document.dispatchEvent(
  new CustomEvent('__updateEditor', { detail: { selectionLayer: { start, end } } })), { start, end });

const menuItems = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.bp3-menu-item')].map((e) => e.textContent.trim()).filter(Boolean));

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForSelector('.veRowView', { timeout: 30000 });
  await page.waitForTimeout(800);

  /* --- no New Part in the Create menu, or on a right-click ---------------- */

  await page.locator('.tg-menu-bar-item', { hasText: 'Edit' }).first().click();
  await page.locator('.bp3-menu-item').filter({ hasText: /^Create/ }).first().hover();
  await page.waitForTimeout(400);
  out.createMenu = await menuItems(page);
  if (out.createMenu.some((t) => /New Part/.test(t))) fail.push('Create still offers New Part');
  const translation = out.createMenu.find((t) => /^New Translation/.test(t));
  const reverse = out.createMenu.find((t) => /^New Reverse Translation/.test(t));
  out.shortcutsShown = { translation, reverse };
  if (!translation || !/L/.test(translation.replace('New Translation', ''))) {
    fail.push(`New Translation should show its shortcut: ${translation}`);
  }
  if (!reverse || !/L/.test(reverse.replace('New Reverse Translation', ''))) {
    fail.push(`New Reverse Translation should show its shortcut: ${reverse}`);
  }
  await page.keyboard.press('Escape');
  await page.mouse.click(4, 4);

  await select(page, 30, 89);
  await page.waitForTimeout(300);
  await page.locator('.veRowView').first().click({ button: 'right', position: { x: 300, y: 40 } });
  await page.waitForTimeout(400);
  const create = page.locator('.bp3-menu-item').filter({ hasText: /^Create/ }).first();
  if (await create.count()) {
    await create.hover();
    await page.waitForTimeout(400);
  }
  out.rightClickMenu = await menuItems(page);
  if (out.rightClickMenu.some((t) => /New Part/.test(t))) fail.push('the right-click menu still offers New Part');
  await page.keyboard.press('Escape');
  await page.mouse.click(4, 4);

  /* --- mod+l and mod+shift+l make translations of the selection ----------- */

  const before = (await state(page)).translations.length;
  await select(page, 30, 89);
  await page.waitForTimeout(300);
  await page.locator('.veRowView').first().focus();
  await page.keyboard.press('Meta+l');
  await page.waitForTimeout(500);
  const afterForward = (await state(page)).translations;
  out.forward = afterForward.slice(before);
  if (out.forward.length !== 1 || out.forward[0].forward !== true || out.forward[0].start !== 30 || out.forward[0].end !== 89) {
    fail.push(`Cmd+L should add one forward translation over 30..89: ${JSON.stringify(out.forward)}`);
  }

  await select(page, 120, 179);
  await page.waitForTimeout(300);
  await page.locator('.veRowView').first().focus();
  await page.keyboard.press('Meta+Shift+l');
  await page.waitForTimeout(500);
  out.reverse = (await state(page)).translations.slice(afterForward.length);
  if (out.reverse.length !== 1 || out.reverse[0].forward !== false || out.reverse[0].start !== 120) {
    fail.push(`Cmd+Shift+L should add one reverse translation over 120..179: ${JSON.stringify(out.reverse)}`);
  }

  out.PASS = fail.length === 0;
  out.fail = fail;
  return out;
}
