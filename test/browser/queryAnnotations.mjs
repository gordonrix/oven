/*
 * A query track's own annotations, and the chromatogram controls.
 *
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/AlignDemo.html --script test/browser/queryAnnotations.mjs
 *   node <browser-automation>/browser.mjs \
 *     "http://127.0.0.1:8742/media/AlignDemo.html?nochrom" --script test/browser/queryAnnotations.mjs
 *
 * A read from a GenBank file carries features of its own, and they were dropped
 * on the way to the viewer -- there was no way to see them at all. Now they are
 * handed over, put through the same flip and reorder as the read's sequence, and
 * one Query Annotations tickbox says whether the query tracks draw whatever the
 * reference is drawing. A tickbox per kind per side would be six more rows of
 * menu to answer one question.
 *
 * The same file runs against ?nochrom, which drops every trace: the chromatogram
 * tickbox and the scale controls have nothing to act on then, and must say so
 * rather than sitting there doing nothing.
 */

const REFERENCE = 'demo-reference';

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30000 });
  await page.waitForSelector('.ovealign-drop', { timeout: 10000 });
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__mafftFound')));
  await page.waitForTimeout(300);
  await page.locator('.ovealign-drop button', { hasText: 'Browse' }).click();
  await page.waitForTimeout(400);
  await page.locator('.ovealign-actions button', { hasText: 'Align' }).click();
  await page.waitForTimeout(3500);

  /** Drawn feature shapes per track -- not tooltip text, which is there either way. */
  const drawn = () => page.evaluate(() =>
    [...document.querySelectorAll('.alignmentViewTrackContainer')].map((row) => {
      const label = row.querySelector('.alignmentTrackNameDiv');
      return {
        name: (label ? label.textContent : '?').trim(),
        features: row.querySelectorAll('.veRowViewFeature, [class*=veFeature]').length
      };
    }));

  const toggle = async (label) => {
    await page.locator('.tg-alignment-visibility-toggle').first().click();
    await page.waitForTimeout(500);
    const item = page.locator('.alignmentAnnotationVisibilityToolInner a', { hasText: label }).first();
    if (!(await item.count())) return false;
    await item.click();
    await page.waitForTimeout(800);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    return true;
  };

  const ofTrack = (rows, name) => rows.find((r) => r.name.startsWith(name));

  /* --- a query's own features are drawn ------------------------------------ */

  out.withQuery = await drawn();
  const refBefore = ofTrack(out.withQuery, REFERENCE);
  const queryBefore = out.withQuery.find((r) => !r.name.startsWith(REFERENCE) && r.features > 0);

  if (!refBefore || !refBefore.features) {
    fail.push('the reference drew no features, so nothing here is being tested');
  }
  if (!queryBefore) {
    fail.push('no query track drew a feature of its own -- they are being dropped');
  }

  /* --- and one tickbox turns them off, leaving the reference alone ---------- */

  out.toggled = await toggle('Query Annotations');
  if (!out.toggled) {
    fail.push('no Query Annotations item in the visibility menu');
  } else {
    out.withoutQuery = await drawn();
    const refAfter = ofTrack(out.withoutQuery, REFERENCE);
    if (refBefore && refAfter && refAfter.features !== refBefore.features) {
      fail.push(`the reference went from ${refBefore.features} features to `
        + `${refAfter.features} -- it should be untouched`);
    }
    if (queryBefore) {
      const queryAfter = ofTrack(out.withoutQuery, queryBefore.name);
      if (!queryAfter || queryAfter.features !== 0) {
        fail.push(`the query still draws ${queryAfter && queryAfter.features} features`);
      }
    }
  }

  /* --- the chromatogram controls match whether there is a trace ------------ */

  out.hasTrace = await page.evaluate(() =>
    Boolean(document.querySelector('.chromatogram-trace canvas')));

  await page.locator('.tg-alignment-visibility-toggle').first().click();
  await page.waitForTimeout(600);
  out.chromatogramItem = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.alignmentAnnotationVisibilityToolInner a')];
    const item = items.find((e) => /Chromatogram/.test(e.textContent));
    return item ? { found: true, disabled: /bp3-disabled/.test(item.className) } : { found: false };
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  out.panelControls = await page.evaluate(() => {
    const bar = document.querySelector('.ovealign-topctl');
    if (!bar) return null;
    const controls = [...bar.querySelectorAll('button,input')];
    return {
      greyed: bar.classList.contains('is-off'),
      disabled: controls.filter((c) => c.disabled).length,
      total: controls.length
    };
  });

  if (!out.chromatogramItem.found) fail.push('no Chromatogram item in the visibility menu');
  if (!out.panelControls || !out.panelControls.total) {
    fail.push('the panel has no chromatogram controls at all');
  } else if (out.hasTrace) {
    // There is a trace, so everything to do with it must work.
    if (out.chromatogramItem.disabled) fail.push('Chromatogram is disabled despite a trace');
    if (out.panelControls.greyed || out.panelControls.disabled) {
      fail.push(`${out.panelControls.disabled} panel controls disabled despite a trace`);
    }
  } else {
    // No trace: acting on one is impossible, and a control that does nothing
    // without saying why is worse than one visibly out of use.
    if (!out.chromatogramItem.disabled) {
      fail.push('Chromatogram is still clickable with no .ab1 in the alignment');
    }
    if (!out.panelControls.greyed) fail.push('the panel controls are not greyed');
    if (out.panelControls.disabled !== out.panelControls.total) {
      fail.push(`only ${out.panelControls.disabled} of ${out.panelControls.total} `
        + 'panel controls are disabled with no trace');
    }
  }

  out.FAILURES = fail;
  out.PASS = fail.length === 0;
  return out;
}
