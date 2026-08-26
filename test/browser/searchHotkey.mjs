/*
 * Primer Search on a hotkey.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/SearchDemo.html --script test/browser/searchHotkey.mjs
 *
 * The panel had only ever opened from the right-click menu. It is a command
 * here, which is what gives it a binding and an entry in View Editor Hotkeys --
 * the same route New Primer takes.
 *
 * The right-click entry is still built by hand in primerSearch.js, because its
 * wording changes with the selection, so its shortcut hint is drawn by us and
 * has to be checked separately from the dialog.
 *
 * mod+shift+f is deliberately not the default: VS Code binds it to Search: Find
 * in Files at the workbench level, which resolves before a webview sees the key.
 */
const HOTKEY = 'Meta+Alt+f';
const LABEL = '⌘⌥F';

const seqBox = (page) => page.locator('.veRowItemSequenceContainer').first().boundingBox();
const panelOpen = (page) => page.locator('.ovesearch-root, .ovesearch-filter').count();

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.setViewportSize({ width: 1400, height: 850 });
  await page.waitForSelector('.veVectorInteractionWrapper', { timeout: 60000 });
  await page.waitForTimeout(1800);

  const box = await seqBox(page);
  const clickSequence = async () => {
    await page.mouse.click(box.x + 60, box.y + box.height / 2);
    await page.waitForTimeout(400);
  };
  const clearSelection = async () => {
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('__clearSelection')));
    await page.waitForTimeout(400);
  };
  const select = async (start, end) => {
    await page.evaluate(([s, e]) => document.dispatchEvent(
      new CustomEvent('__select', { detail: { start: s, end: e } })), [start, end]);
    await page.waitForTimeout(500);
  };
  const menuTexts = () => page.evaluate(() =>
    [...document.querySelectorAll('.bp3-menu-item')]
      .map((n) => n.innerText.replace(/\n/g, '  ').trim())
      .filter((t) => /Search primers/i.test(t)));

  /* --- the shortcut opens the panel --------------------------------------- */

  out.panelBefore = await panelOpen(page);
  await clickSequence();
  await page.keyboard.press(HOTKEY);
  await page.waitForTimeout(1500);
  out.panelAfterHotkey = await panelOpen(page);
  if (!out.panelAfterHotkey) fail.push(`${LABEL} did not open the panel`);

  /* --- and searches the selection when there is one ----------------------- */

  /*
   * The point of the entry's two wordings. The command in the bundle does not
   * decide this -- it defers to primerSearch.js, so that the key and the menu
   * read the same live selection rather than each forming its own opinion.
   */
  // A scoped search is one carrying a selection: the message has no separate
  // flag, the presence of `selection` is what narrows it.
  const lastRun = () => page.evaluate(() => {
    const runs = JSON.parse(document.getElementById('posted').textContent || '[]')
      .filter((m) => m.type === 'search/run');
    return runs.length ? Boolean(runs[runs.length - 1].selection) : null;
  });

  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__clearPosted')));
  await clearSelection();
  await clickSequence();
  await page.keyboard.press(HOTKEY);
  await page.waitForTimeout(1200);
  out.scopedWithoutSelection = await lastRun();

  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__clearPosted')));
  await select(0, 80);
  await page.keyboard.press(HOTKEY);
  await page.waitForTimeout(1200);
  out.scopedWithSelection = await lastRun();

  if (out.scopedWithoutSelection !== false) {
    fail.push(`with nothing selected the shortcut should search the plasmid, got scoped=${out.scopedWithoutSelection}`);
  }
  if (out.scopedWithSelection !== true) {
    fail.push(`with a selection the shortcut should search it, got scoped=${out.scopedWithSelection}`);
  }

  /* --- and is shown beside the menu entry --------------------------------- */

  /*
   * Two readings, because the entry's wording is not fixed. With nothing
   * selected it offers the plasmid; with a selection it offers the selection.
   * Both must carry the hint, and the hint must be the same one.
   */
  await clearSelection();
  await page.mouse.click(box.x + 60, box.y + box.height / 2, { button: 'right' });
  await page.waitForTimeout(900);
  out.menuUnselected = await menuTexts();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // The click has to land inside the selection: right-clicking outside one
  // collapses it, and the entry would then correctly read "in plasmid".
  await select(0, 80);
  await page.mouse.click(box.x + 60, box.y + box.height / 2, { button: 'right' });
  await page.waitForTimeout(900);
  out.menuSelected = await menuTexts();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  if (!out.menuUnselected.some((t) => t.includes('plasmid') && t.includes(LABEL))) {
    fail.push(`no "in plasmid" entry carrying ${LABEL}: ${JSON.stringify(out.menuUnselected)}`);
  }
  if (!out.menuSelected.some((t) => t.includes('selection') && t.includes(LABEL))) {
    fail.push(`no "in selection" entry carrying ${LABEL}: ${JSON.stringify(out.menuSelected)}`);
  }

  /* --- and listed in View Editor Hotkeys ---------------------------------- */

  await page.locator('.tg-menu-bar button, .tg-menu-bar .bp3-button')
    .filter({ hasText: 'Help' }).first().click();
  await page.waitForTimeout(600);
  await page.locator('.bp3-menu-item').filter({ hasText: 'View Editor Hotkeys' }).first().click();
  await page.waitForTimeout(1200);
  out.hotkeyDialog = await page.evaluate(() =>
    [...document.querySelectorAll('.bp3-dialog *')]
      .filter((n) => n.children.length === 0 && /Search Primers/i.test(n.textContent))
      .map((n) => (n.closest('.bp3-hotkey') || n.parentElement).innerText.replace(/\n/g, ' ').trim())
      .filter((v, i, a) => a.indexOf(v) === i));
  if (!out.hotkeyDialog.length) fail.push('Search Primers is not in View Editor Hotkeys');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  out.FAILURES = fail;
  out.PASS = fail.length === 0;
  return out;
}
