/*
 * Copying out of the alignment view.
 *
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/AlignDemo.html --script test/browser/alignCopy.mjs
 *
 * Two faults, one visible symptom: a toast saying "Selection Copied" over a
 * clipboard that never changed.
 *
 * The selection reaches redux through a debounce while easyStore has it at
 * once, so a copy soon after dragging read the old range -- usually none at all
 * -- and copied an empty string. execCommand reports success for that, so the
 * toast was cheerful and the clipboard kept whatever it had.
 *
 * The text is captured through the demo's __captureAlignCopy bridge: the view
 * copies out of a throwaway textarea with execCommand, which a headless browser
 * will not perform and the driver cannot read back.
 */

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30000 });
  await page.waitForSelector('.ovealign-drop', { timeout: 10000 });
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__mafftFound')));
  await page.waitForTimeout(300);
  await page.locator('.ovealign-drop button', { hasText: 'Browse' }).click();
  await page.waitForTimeout(400);
  await page.locator('.ovealign-actions button', { hasText: 'Align' }).click();
  await page.waitForTimeout(3500);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__captureAlignCopy')));
  await page.waitForTimeout(300);

  const copies = () => page.evaluate(() =>
    JSON.parse(document.getElementById('copyLog').textContent || '[]'));
  const toast = () => page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.toast, [class*=toast]')];
    const last = nodes[nodes.length - 1];
    return last ? last.textContent.trim() : null;
  });
  // Toasts stack and linger, so the newest is only the newest if the old ones
  // are gone -- otherwise the second check reads the first check's message.
  const clearToasts = () => page.evaluate(() => {
    for (const n of document.querySelectorAll('.toast, [class*=toast]')) n.remove();
  });

  const seqBox = await page.evaluate(() => {
    const el = document.querySelector('.alignmentViewTrackContainer [class*=SequenceContainer]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2 };
  });
  if (!seqBox) {
    return { FAILURES: ['no sequence to drag on'], PASS: false };
  }

  /* --- nothing selected yet: not a copy ------------------------------------ */

  /*
   * Before any drag there is no selection at all. The clipboard keeping what it
   * had is right; saying "Selection Copied" over the top of it is how an empty
   * copy went unnoticed in the first place.
   *
   * A click does not clear a selection in this view, so this has to be done
   * first -- there is no way back to "nothing selected" afterwards.
   */
  await clearToasts();
  await page.keyboard.press('Meta+c');
  await page.waitForTimeout(800);
  out.emptyCopies = (await copies()).length;
  out.emptyToast = await toast();
  if (out.emptyCopies) {
    fail.push(`copied ${JSON.stringify((await copies())[0])} with nothing selected`);
  }
  if (out.emptyToast && /^Selection Copied/i.test(out.emptyToast)) {
    fail.push('an empty selection reported "Selection Copied"');
  }

  /* --- a selection, copied straight away ---------------------------------- */

  await page.mouse.move(seqBox.x + 50, seqBox.y);
  await page.mouse.down();
  for (let i = 1; i <= 25; i++) await page.mouse.move(seqBox.x + 50 + i * 12, seqBox.y, { steps: 2 });
  await page.mouse.up();
  // Deliberately brief: the point is to copy before the debounce has caught up.
  await page.waitForTimeout(250);

  out.selection = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[class*=SelectionLayer]')]
      .find((e) => /Selecting/.test(e.getAttribute('title') || ''));
    return el ? el.getAttribute('title') : null;
  });
  const selected = out.selection && Number(/Selecting (\d+) bp/.exec(out.selection)[1]);
  if (!selected) {
    return { FAILURES: [`no selection was made: ${out.selection}`], PASS: false };
  }

  await clearToasts();
  const before = (await copies()).length;
  await page.keyboard.press('Meta+c');
  await page.waitForTimeout(800);
  const after = await copies();
  out.copied = after.length > before ? String(after[after.length - 1]) : null;
  out.toast = await toast();

  if (!out.copied) {
    fail.push('cmd+C put nothing on the clipboard');
  } else {
    if (out.copied.length !== selected) {
      fail.push(`selected ${selected} bp but copied ${out.copied.length} `
        + `(${JSON.stringify(out.copied.slice(0, 20))})`);
    }
    if (!/^[ACGTUNRYKMSWBDHV-]+$/i.test(out.copied)) {
      fail.push(`what was copied does not look like bases: ${JSON.stringify(out.copied.slice(0, 30))}`);
    }
  }
  if (out.toast && !/Copied/i.test(out.toast)) {
    fail.push(`a good copy reported ${JSON.stringify(out.toast)}`);
  }

  out.FAILURES = fail;
  out.PASS = fail.length === 0;
  return out;
}
