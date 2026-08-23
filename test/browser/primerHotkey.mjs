/*
 * Cmd/Ctrl+Shift+K opens New Primer.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/EditorDemo.html --script test/browser/primerHotkey.mjs
 *
 * Open Vector Editor gives newFeature mod+k and newPart mod+l but left
 * newPrimer unbound; this is our patched hotkey. The key matters as much as
 * the binding: VS Code resolves its own keybindings for events a webview has
 * already seen, so a workbench-level shortcut would win. mod+shift+k is
 * editor-scoped upstream (deleteLines, when textInputFocus), so it never
 * reaches a webview and is ours to take.
 */
const dialogTitle = (page) => page.evaluate(() => {
  const d = document.querySelector('.bp3-dialog-header, .bp3-dialog h4, .bp3-heading');
  return d ? d.textContent.trim() : null;
});

const select = async (page, start, end) => {
  await page.evaluate(([a, b]) => document.dispatchEvent(
    new CustomEvent('__select', { detail: { start: a, end: b } })), [start, end]);
  await page.waitForTimeout(400);
};

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForSelector('.veVectorInteractionWrapper', { timeout: 60000 });
  await page.waitForTimeout(800);

  out.dialogsBefore = await page.locator('.bp3-dialog').count();
  if (out.dialogsBefore) fail.push('a dialog was already open before pressing anything');

  // New Primer acts on a range, so give it one. Focus has to be in the editor
  // for a hotkey to reach it at all.
  await page.locator('.veVectorInteractionWrapper').first().click({ position: { x: 50, y: 10 } });
  await select(page, 100, 130);

  await page.keyboard.press('Meta+Shift+K');
  await page.waitForTimeout(900);

  out.dialogsAfter = await page.locator('.bp3-dialog').count();
  out.title = await dialogTitle(page);
  if (out.dialogsAfter !== 1) fail.push(`expected one dialog, got ${out.dialogsAfter}`);
  if (out.title !== 'New Primer') fail.push(`expected the New Primer dialog, got ${out.title}`);

  out.FAILURES = fail;
  out.PASS = fail.length === 0;
  return out;
}
