/*
 * Running a command from a menu must leave the editor usable.
 *
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/EditorDemo.html --script test/browser/menuFocus.mjs
 *
 * Every menu command dropped focus on document.body: the menu closed and handed
 * it back to nobody. The selection was still there and still drawn, so the
 * editor looked live and was inert -- Select Inverse followed by cmd+C copied
 * nothing, and neither did any of the copy variants. It is worst on the
 * commands whose whole point is to set up a selection you then act on, but
 * Select All had it too.
 *
 * The rule being tested is narrow on purpose: focus is handed back only when it
 * was dropped, never taken from something that wanted it. Find... opens a field
 * and has to keep it.
 */

const SELECTION = { start: 0, end: 11 };   // GAATTCGGATCC in the fixture

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.setViewportSize({ width: 1300, height: 850 });
  await page.waitForSelector('.veVectorInteractionWrapper', { timeout: 60000 });
  await page.waitForTimeout(1800);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__captureCopies')));
  await page.waitForTimeout(300);

  const box = await page.locator('.veRowItemSequenceContainer').first().boundingBox();
  const copies = () => page.evaluate(() =>
    JSON.parse(document.getElementById('copyLog').textContent || '[]'));
  const focus = () => page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName}.${(el.className || '').toString().slice(0, 45)}` : 'none';
  });

  const select = async () => {
    await page.mouse.click(box.x + 60, box.y + box.height / 2);
    await page.evaluate((sel) => document.dispatchEvent(new CustomEvent('__updateEditor', {
      detail: { selectionLayer: sel, caretPosition: -1 } })), SELECTION);
    await page.waitForTimeout(500);
  };

  const menu = async (label) => {
    /*
     * Dismiss whatever is open and wait for it to actually go. A menu that is
     * still closing leaves a backdrop over the menu bar, and the next Edit
     * click resolves to the button and then times out waiting for it to become
     * clickable -- which on a slow load is the difference between a pass and a
     * failure that looks like a real one.
     */
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => !document.querySelector('.bp3-overlay-open, .bp3-portal .bp3-menu'),
      undefined,
      { timeout: 5000 }
    ).catch(() => {});
    await page.waitForTimeout(200);

    await page.locator('.tg-menu-bar button', { hasText: 'Edit' }).first()
      .click({ timeout: 15000 });
    await page.waitForTimeout(400);
    const item = page.locator('[class*=menu-item]', { hasText: label }).first();
    if (!(await item.count())) return false;
    await item.click({ timeout: 15000 });
    await page.waitForTimeout(700);
    return true;
  };

  /** Copy with the keyboard and return what landed, or null if nothing did. */
  const copyByHotkey = async () => {
    const before = (await copies()).length;
    await page.keyboard.press('Meta+c');
    await page.waitForTimeout(700);
    const after = await copies();
    return after.length > before ? after[after.length - 1] : null;
  };

  /* --- the whole sequence, for comparison --------------------------------- */

  await select();
  if (!await menu('Select All')) fail.push('no Select All in the Edit menu');
  out.focusAfterSelectAll = await focus();
  const whole = await copyByHotkey();
  if (!whole) {
    fail.push('cmd+C copied nothing after Select All from the menu');
  }

  /* --- select inverse, then copy, is the reported case --------------------- */

  await select();
  const plain = await copyByHotkey();
  out.plain = plain;
  if (plain !== 'GAATTCGGATCC') fail.push(`the plain selection copied "${plain}"`);

  await select();
  if (!await menu('Select Inverse')) fail.push('no Select Inverse in the Edit menu');
  out.focusAfterInverse = await focus();
  if (!/veVectorInteractionWrapper/.test(out.focusAfterInverse)) {
    fail.push(`focus went to ${out.focusAfterInverse}, so no hotkey reaches the editor`);
  }

  const inverse = await copyByHotkey();
  out.inverseLength = inverse && inverse.length;
  if (!inverse) {
    fail.push('cmd+C copied nothing after Select Inverse -- the reported bug');
  } else if (whole) {
    // The inverse of bases 1-12 is everything after them, which is the whole
    // sequence minus that many from the front.
    const expected = whole.slice(SELECTION.end + 1);
    if (inverse !== expected) {
      fail.push(`the inverse copied ${inverse.length} bases, expected ${expected.length}`
        + ` starting "${expected.slice(0, 12)}" but got "${inverse.slice(0, 12)}"`);
    }
  }

  /* --- but a command that wants focus keeps it ----------------------------- */

  await select();
  if (await menu('Find')) {
    await page.waitForTimeout(500);
    out.focusAfterFind = await focus();
    // Handing focus back here would make the find field impossible to type in.
    if (/veVectorInteractionWrapper/.test(out.focusAfterFind)) {
      fail.push('focus was taken from the find field and given to the editor');
    }
    if (!/INPUT|TEXTAREA/.test(out.focusAfterFind)) {
      fail.push(`Find... left focus on ${out.focusAfterFind}, expected its input`);
    }
  }

  out.FAILURES = fail;
  out.PASS = fail.length === 0;
  return out;
}
