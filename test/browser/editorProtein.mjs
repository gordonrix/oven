/*
 * A protein FASTA opened in the editor.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/EditorDemo.html?protein --script test/browser/editorProtein.mjs
 *
 * The page parses the protein exactly as src/editorProvider.js does -- the
 * parser's protein guess on -- and mirrors editorHtml.js's protein branch.
 *
 * The bug this guards was silent: parsed as DNA, every residue that is not also
 * a nucleotide letter was deleted, and the protein opened a third shorter with
 * nothing said. So the first check is the plainest one -- every residue is
 * still there -- and the rest are that OVE is in its protein mode and none of
 * the DNA tools came along.
 */

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForSelector('.veRowView', { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__publish')));

  const state = await page.evaluate(() =>
    JSON.parse(document.getElementById('editorState').textContent));
  out.isProtein = state.isProtein;
  out.residues = { input: (state.proteinInput || '').length, held: (state.proteinSequence || '').length };
  if (!state.isProtein) fail.push('OVE is not in protein mode');
  if (state.proteinSequence !== state.proteinInput) {
    fail.push(`residues lost: ${out.residues.input} in, ${out.residues.held} held`);
  }

  // Save writes the residues, not the degenerate DNA OVE keeps behind them.
  const saved = String(state.savedFasta || '').replace(/^>.*\n/, '').replace(/\s/g, '');
  out.saveRoundTrips = saved === state.proteinInput;
  if (!out.saveRoundTrips) fail.push(`saving would write ${saved.slice(0, 30)}…`);

  out.status = await page.evaluate(() =>
    [...document.querySelectorAll('.veStatusBarItem')].map((n) => n.textContent.trim()).filter(Boolean));
  if (!out.status.some((t) => new RegExp(`Length: ${state.proteinInput.length} AAs`).test(t))) {
    fail.push(`status bar should give the length in AAs: ${JSON.stringify(out.status)}`);
  }

  // Align and Save only.
  out.buttons = await page.evaluate(() =>
    [...document.querySelectorAll('.ove-toolbtns button')].map((b) => b.textContent.trim()));
  if (!out.buttons.includes('Align')) fail.push('Align is missing for a protein');
  for (const dnaTool of ['Sequence Search', 'Primer Search', 'Add to Cart']) {
    if (out.buttons.includes(dnaTool)) fail.push(`${dnaTool} is offered for a protein`);
  }

  // Align still opens, by its hotkey as well as its button.
  await page.locator('.veRowView').first().click({ position: { x: 60, y: 20 } });
  await page.keyboard.press('Meta+Alt+l');
  await page.waitForTimeout(400);
  out.alignOpened = await page.title();
  if (!/^align:/.test(out.alignOpened)) fail.push(`the Align hotkey did nothing (${out.alignOpened})`);

  // The primer-search hotkey is gone with its script.
  await page.keyboard.press('Meta+Alt+f');
  await page.waitForTimeout(300);
  out.primerPanel = await page.evaluate(() =>
    document.querySelectorAll('.ove-search-panel, .ovesearch-root, [class*="primerSearch"]').length);
  if (out.primerPanel) fail.push('the primer-search hotkey opened a panel on a protein');

  // And so is its right-click entry.
  await page.locator('.veRowView').first().click({ button: 'right', position: { x: 60, y: 20 } });
  await page.waitForTimeout(400);
  out.menu = await page.evaluate(() =>
    [...document.querySelectorAll('.bp3-menu-item, .bp3-menu li')].map((n) => n.textContent.trim()).filter(Boolean));
  if (out.menu.some((t) => /Search primers|New Primer|Add to cart/i.test(t))) {
    fail.push(`DNA tools in the right-click menu: ${JSON.stringify(out.menu)}`);
  }
  await page.keyboard.press('Escape');

  out.failures = fail;
  out.ok = fail.length === 0;
  return out;
}
