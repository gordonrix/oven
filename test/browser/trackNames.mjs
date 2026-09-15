/*
 * The alignment view's track-name column: resizing it, and long names.
 *
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/AlignDemo.html --script test/browser/trackNames.mjs
 *
 * Two things that were broken together. The drag handle at the column's right
 * edge did nothing -- HorizontalPanelDragHandle kept its first onDrag in a ref,
 * so every mousemove applied the starting width of 140 plus the last few pixels
 * rather than accumulating, and the column twitched and sprang back. And the
 * column was `white-space: nowrap` with `overflow: hidden`, so a name longer
 * than it was wide was cut off with no way to read the rest -- which is every
 * real Sanger filename, since they carry plate, well and direction.
 */

/** The drag handle lives inside the name column and is invisible. */
const HANDLE = `[...document.querySelector('.alignmentTrackName').querySelectorAll('div')]
  .find((d) => getComputedStyle(d).cursor === 'ew-resize')`;

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
  await page.waitForTimeout(3000);

  const columnWidth = () => page.evaluate(() =>
    Math.round(document.querySelector('.alignmentTrackName').getBoundingClientRect().width));

  /* --- a long name is readable rather than cut off ------------------------ */

  out.longName = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('.alignmentTrackNameDiv')];
    const longest = labels.map((el) => ({
      text: el.textContent.trim(),
      box: el.getBoundingClientRect(),
      column: el.closest('.alignmentTrackName').getBoundingClientRect()
    })).sort((a, b) => b.text.length - a.text.length)[0];
    if (!longest) return null;
    return {
      text: longest.text,
      lines: Math.round(longest.box.height / 18),
      overflows: Math.round(longest.box.right - longest.column.right),
      whiteSpace: getComputedStyle(longest.column === null ? document.body
        : document.querySelector('.alignmentTrackName')).whiteSpace
    };
  });

  if (!out.longName) {
    fail.push('no track names rendered');
  } else {
    if (out.longName.text.length < 30) {
      fail.push(`the demo has no name long enough to test wrapping: "${out.longName.text}"`);
    }
    if (out.longName.whiteSpace === 'nowrap') {
      fail.push('the name column still forbids wrapping, so a long name is cut off');
    }
    // Wrapping is the point: a name too long for the column takes more than one
    // line rather than running past its right edge and being clipped.
    if (out.longName.lines < 2) {
      fail.push(`a ${out.longName.text.length}-character name was drawn on `
        + `${out.longName.lines} line, so it is being cut off`);
    }
    if (out.longName.overflows > 2) {
      fail.push(`the name runs ${out.longName.overflows}px past the column edge`);
    }
  }

  /* --- the handle actually resizes the column ----------------------------- */

  out.before = await columnWidth();
  const handle = await page.evaluate(`(() => {
    const h = ${HANDLE};
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);

  if (!handle) {
    fail.push('no drag handle on the name column');
  } else {
    const DRAG = 120;
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    // In steps, because the handle measures each move against the last one.
    for (let i = 1; i <= 12; i++) await page.mouse.move(handle.x + i * (DRAG / 12), handle.y);
    await page.mouse.up();
    await page.waitForTimeout(400);
    out.after = await columnWidth();

    if (out.after === out.before) {
      fail.push(`dragging the handle ${DRAG}px left the column at ${out.before}px`);
    } else if (Math.abs(out.after - out.before - DRAG) > 8) {
      fail.push(`dragged ${DRAG}px but the column went ${out.before} -> ${out.after}, `
        + 'which is not what was asked for');
    }

    // And back, so the drag is not one-way.
    await page.mouse.move(handle.x + DRAG, handle.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(handle.x + DRAG - i * (DRAG / 12), handle.y);
    await page.mouse.up();
    await page.waitForTimeout(400);
    out.backAgain = await columnWidth();
    if (Math.abs(out.backAgain - out.before) > 8) {
      fail.push(`dragging back gave ${out.backAgain}, not the ${out.before} it started at`);
    }
  }

  out.FAILURES = fail;
  out.PASS = fail.length === 0;
  return out;
}
