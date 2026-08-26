/*
 * The copy variants, on hotkeys.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/EditorDemo.html --script test/browser/copyHotkeys.mjs
 *
 * Open Vector Editor offers reverse complement, AA sequence and reverse
 * complement AA sequence in its right-click menu, built as one-off handlers
 * over a closure on the editor component -- nothing a hotkey could reach. They
 * are commands here, which is also what puts them in View Editor Hotkeys.
 *
 * The bindings avoid VS Code, which resolves its own keybindings before a
 * webview sees the key. The obvious mod+shift+c, mod+alt+c and mod+alt+shift+c
 * are all taken upstream -- external terminal, copy path, copy relative path.
 *
 * The text is captured through the demo's __captureCopies bridge: the editor
 * copies with navigator.clipboard.writeText, and a headless browser will
 * neither perform that without a user gesture nor let the driver read the
 * clipboard back.
 */
const SELECTION = { start: 0, end: 11 };   // GAATTCGGATCC in the fixture
const EXPECTED = {
  plain: 'GAATTCGGATCC',
  revcomp: 'GGATCCGAATTC',
  translation: 'EFGS',                      // GAA TTC GGA TCC
  revcompTranslation: 'GSEF'                // GGA TCC GAA TTC
};

const seqBox = (page) => page.locator('.veRowItemSequenceContainer').first().boundingBox();

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.setViewportSize({ width: 1300, height: 850 });
  await page.waitForSelector('.veVectorInteractionWrapper', { timeout: 60000 });
  await page.waitForTimeout(1800);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__captureCopies')));
  await page.waitForTimeout(300);

  const box = await seqBox(page);
  const lastCopy = () => page.evaluate(() => {
    const arr = JSON.parse(document.getElementById('copyLog').textContent || '[]');
    return arr.length ? arr[arr.length - 1] : null;
  });
  // Re-established each time: a copy leaves focus where it likes.
  const select = async () => {
    await page.mouse.click(box.x + 60, box.y + box.height / 2);
    await page.evaluate((sel) => document.dispatchEvent(new CustomEvent('__updateEditor', {
      detail: { selectionLayer: sel, caretPosition: -1 } })), SELECTION);
    await page.waitForTimeout(600);
  };

  /* --- each shortcut copies its own thing --------------------------------- */

  out.copied = {};
  for (const [key, combo] of [
    ['plain', 'Meta+KeyC'],
    ['revcomp', 'Meta+Alt+KeyR'],
    ['translation', 'Meta+Alt+Shift+KeyT'],
    ['revcompTranslation', 'Meta+Alt+Shift+KeyR']
  ]) {
    await select();
    await page.keyboard.press(combo);
    await page.waitForTimeout(900);
    out.copied[key] = await lastCopy();
    if (out.copied[key] !== EXPECTED[key]) {
      fail.push(`${combo} copied ${JSON.stringify(out.copied[key])}, want ${JSON.stringify(EXPECTED[key])}`);
    }
  }

  /* --- and is shown where it is used -------------------------------------- */

  await select();
  await page.mouse.click(box.x + 60, box.y + box.height / 2, { button: 'right' });
  await page.waitForTimeout(800);
  await page.locator('.bp3-menu-item').filter({ hasText: /^Copy/ }).first().hover();
  await page.waitForTimeout(900);
  out.menu = await page.evaluate(() =>
    [...document.querySelectorAll('.bp3-menu-item')]
      .map((n) => n.innerText.replace(/\n/g, '  ').trim())
      .filter((t) => /Copy/i.test(t)));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // Cmd+C was never labelled either, though it has always worked.
  for (const want of [/^Copy\s+⌘C/, /Copy Reverse Complement\s+⌘⌥R/,
    /Copy AA Sequence\s+⌘⌥⇧T/, /Copy Reverse Complement AA Sequence\s+⌘⌥⇧R/]) {
    if (!out.menu.some((t) => want.test(t))) {
      fail.push(`no menu entry matching ${want}: ${JSON.stringify(out.menu)}`);
    }
  }

  /* --- and listed in View Editor Hotkeys ---------------------------------- */

  await page.locator('.tg-menu-bar button, .tg-menu-bar .bp3-button')
    .filter({ hasText: 'Help' }).first().click();
  await page.waitForTimeout(600);
  await page.locator('.bp3-menu-item').filter({ hasText: 'View Editor Hotkeys' }).first().click();
  await page.waitForTimeout(1000);
  out.hotkeyDialog = await page.evaluate(() =>
    [...document.querySelectorAll('.bp3-dialog *')]
      .filter((n) => n.children.length === 0 && /Copy/i.test(n.textContent))
      .map((n) => (n.closest('.bp3-hotkey') || n.parentElement).innerText.replace(/\n/g, ' ').trim())
      .filter((v, i, a) => a.indexOf(v) === i));

  for (const want of ['Copy Reverse Complement', 'Copy AA Sequence',
    'Copy Reverse Complement AA Sequence']) {
    if (!out.hotkeyDialog.some((t) => t.startsWith(want))) {
      fail.push(`"${want}" missing from the hotkey dialog`);
    }
  }

  out.FAILURES = fail;
  out.PASS = fail.length === 0;
  return out;
}
