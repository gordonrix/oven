/*
 * Cmd+Z in a text box, inside a frame that blocks the browser's own undo.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/EditorDemo.html --script test/browser/textUndo.mjs
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/AlignDemo.html --script test/browser/textUndo.mjs
 *
 * The bug: a sequence pasted into Find could not be undone. VS Code's webview
 * frame cancels Cmd+Z on its way past and gives it to the custom editor, so
 * the browser never undoes the text. A plain browser does not do that, so the
 * page gets a stand-in: a bubbling keydown listener on the window that cancels
 * Cmd+Z exactly as VS Code's does. Without media/textUndo.js nothing would
 * undo here, as nothing did in VS Code.
 *
 * On the editor it is Find; on the alignment, the paste table.
 */

/** VS Code's frame: cancel undo/redo keys, and count the ones that reach it. */
const standIn = (page) => page.evaluate(() => {
  window.__vscodeSawUndo = 0;
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && [90, 89].includes(e.keyCode)) {
      e.preventDefault();
      window.__vscodeSawUndo++;
    }
  });
});

const value = (page, selector) => page.evaluate((s) => document.querySelector(s).value, selector);

export default async function run(page) {
  const out = {};
  const fail = [];
  const align = /AlignDemo/.test(page.url());

  await page.setViewportSize({ width: 1400, height: 900 });
  let selector;
  if (align) {
    await page.waitForSelector('.ovealign-pastetable', { timeout: 30000 });
    selector = '.ovealign-pasterow input.ovealign-pastename';
  } else {
    await page.waitForSelector('.veRowView', { timeout: 30000 });
    await page.waitForTimeout(800);
    await page.locator('.veRowView').first().click({ position: { x: 200, y: 40 } });
    await page.keyboard.press('Meta+f');
    selector = '.tg-find-tool-input input';
    await page.waitForSelector(selector, { timeout: 5000 });
  }
  // page.evaluate runs in an isolated world, so the script is looked for by
  // its tag rather than by the global it sets.
  out.textUndoLoaded = await page.evaluate(() =>
    Boolean(document.querySelector('script[src$="textUndo.js"]')));
  if (!out.textUndoLoaded) fail.push('textUndo.js is not loaded');
  await standIn(page);

  // The demo's sequence has GAATTC (EcoRI) and, straight after it, GGATCC.
  const hits = () => page.evaluate(() => {
    const bar = document.querySelector('.veFindBar');
    const m = bar && /(\d+)\s*\/\s*(\d+)/.exec(bar.textContent);
    return m ? Number(m[2]) : 0;
  });
  const TYPED = 'GAATTC';
  const PASTED = 'GGATCC';

  // Focused directly: in Find, the mismatches controls sit over the input.
  await page.evaluate((s) => document.querySelector(s).focus(), selector);
  await page.keyboard.type(TYPED);
  await page.waitForTimeout(400);
  const typedHits = await hits();
  // A paste, as VS Code delivers one: it runs the browser's paste command, an
  // edit the browser's undo history records as a step of its own. insertText
  // stands in for it, and would be merged into the typing before it as more
  // typing; moving the caret ends the typing, as a paste does.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await page.evaluate((text) => document.execCommand('insertText', false, text), PASTED);
  await page.waitForTimeout(400);
  out.afterPaste = await value(page, selector);
  if (out.afterPaste !== TYPED + PASTED) fail.push(`the paste did not land: ${out.afterPaste}`);

  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(400);
  out.afterUndo = await value(page, selector);
  if (out.afterUndo !== TYPED) fail.push(`Cmd+Z should take the paste back out, leaving ${TYPED}: "${out.afterUndo}"`);
  if (!align) {
    // React's idea of the text follows the undo: Find searches what is shown.
    out.hits = { typed: typedHits, afterUndo: await hits() };
    if (!typedHits || out.hits.afterUndo !== typedHits) {
      fail.push(`after undo Find should count the hits for ${TYPED} again: ${JSON.stringify(out.hits)}`);
    }
  }

  await page.keyboard.press('Meta+Shift+z');
  await page.waitForTimeout(400);
  out.afterRedo = await value(page, selector);
  if (out.afterRedo !== TYPED + PASTED) fail.push(`Cmd+Shift+Z should put it back: "${out.afterRedo}"`);

  // The key stops with the text box: VS Code, given it too, would undo again
  // in a plain webview panel, or try the document's undo in an editor tab.
  out.vscodeSawUndo = await page.evaluate(() => window.__vscodeSawUndo);
  if (out.vscodeSawUndo !== 0) fail.push(`the key went on to the frame ${out.vscodeSawUndo} times`);

  // Away from text boxes the key is left alone, for OVE's own undo.
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Meta+z');
  out.vscodeSawUndoOutside = await page.evaluate(() => window.__vscodeSawUndo);
  if (out.vscodeSawUndoOutside !== 1) fail.push('Cmd+Z outside a text box should be left for the editor');

  out.PASS = fail.length === 0;
  out.fail = fail;
  return out;
}
