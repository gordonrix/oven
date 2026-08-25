/*
 * Drives media/SearchDemo.html to check the strand indicator bar against the
 * real OVE bundle.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/SearchDemo.html --script test/browser/strandBar.mjs
 *
 * The bar is a pseudo-element, so its geometry is only readable through
 * getComputedStyle(el, '::after') -- there is no node to query. Positions are
 * asserted against the letters as measured live, never against a constant: the
 * label band above the letters is a different height in every row, which is
 * the whole reason strandBar.js exists.
 */

const CARET = 2;   // .veRowViewCaret width, the X of the spec
const THICK = 6;   // 3X
const BAR_RGB = 'rgb(85, 85, 85)';

/*
 * Absent from the top strand of the fixture but present on the bottom, so Find
 * returns exactly one hit and it is guaranteed to be a .veSearchLayerBottomStrand
 * -- the case that used to draw the gold triangles.
 */
const BOTTOM_STRAND_QUERY = 'AGGAGGATGTCACA';

/** Geometry of a layer's ::after, in viewport coordinates. */
const barsFor = (page, selector) => page.evaluate((sel) => {
  const num = (v) => parseFloat(v) || 0;
  return [...document.querySelectorAll(sel)].map((el) => {
    const after = getComputedStyle(el, '::after');
    const before = getComputedStyle(el, '::before');
    const box = el.getBoundingClientRect();
    const row = el.closest('.veRowItem');
    const seq = row && row.querySelector('.veRowItemSequenceContainer');
    const seqBox = seq && seq.getBoundingClientRect();
    return {
      cls: String(el.className).trim().replace(/\s+/g, ' '),
      content: after.content,
      height: num(after.height),
      left: num(after.left),
      right: num(after.right),
      top: num(after.top),
      background: after.backgroundColor,
      layerOpacity: num(getComputedStyle(el).opacity),
      /*
       * A surviving triangle is a fat border on a pseudo-element that actually
       * renders. ::before still computes a 15px border from OVE's rule -- the
       * declaration is not removed, only the box -- so its width means nothing
       * once content is none, and these are reported apart rather than maxed.
       */
      afterBorder: num(after.borderRightWidth),
      beforeBorder: num(before.borderRightWidth),
      beforeContent: before.content,
      // Absolute top of the bar, and where the letters actually are.
      barTop: box.top + num(after.top),
      seqTop: seqBox ? seqBox.top : null,
      seqBottom: seqBox ? seqBox.bottom : null
    };
  });
}, selector);

const ours = '.veRowView .ove-strand-fwd.notCaret, .veRowView .ove-strand-rev.notCaret';
const oursCarets = '.veRowView .ove-strand-fwd.veCaret, .veRowView .ove-strand-rev.veCaret';
const found = '.veRowView .veSearchLayer.notCaret';

const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.waitForSelector('body[data-ready="true"]', { timeout: 30000 });
  await page.waitForSelector('.veRowView .veRowItem', { timeout: 20000 });
  // The row view mounts after the editor, so the first measurement may be a
  // beat behind data-ready. Wait for the effect, not for a fixed delay.
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.veRowView .veRowItem')];
    return rows.length > 1 && rows.every((r) => r.style.getPropertyValue('--ovestrand-top'));
  }, { timeout: 15000 });

  // --- the per-row variables are set, and they differ between rows ---------
  out.rowVars = await page.evaluate(() =>
    [...document.querySelectorAll('.veRowView .veRowItem')].slice(0, 8).map((r) => ({
      top: r.style.getPropertyValue('--ovestrand-top'),
      bottom: r.style.getPropertyValue('--ovestrand-bottom'),
      seqTop: r.querySelector('.veRowItemSequenceContainer')?.offsetTop ?? null
    })));

  if (out.rowVars.some((v) => !v.top || !v.bottom)) {
    fail.push('some rows have no --ovestrand-* variables');
  }
  // If one measurement had been reused for every row this would be a single value.
  out.distinctTops = [...new Set(out.rowVars.map((v) => v.top))];
  if (out.distinctTops.length < 2) {
    fail.push(`expected the letters to sit at different offsets per row, got ${out.distinctTops.join()}`);
  }

  await page.locator('#ove-search-button').click();
  await page.waitForSelector('.ovesearch-row:not(.ovesearch-header)', { timeout: 8000 });

  const rowByName = async (name) => {
    const idx = await page.evaluate((n) => [...document.querySelectorAll('.ovesearch-row:not(.ovesearch-header)')]
      .findIndex((r) => r.querySelector('.ovesearch-k-name').textContent === n), name);
    if (idx < 0) throw new Error(`no search result row named ${name}`);
    await page.locator('.ovesearch-row:not(.ovesearch-header)').nth(idx).click();
    await page.waitForTimeout(400);
  };

  /* -------------------------------------------------- a forward-strand hit -- */

  await rowByName('DEMO_CLEAN_F');
  out.forward = await barsFor(page, ours);

  if (!out.forward.length) fail.push('revealing a forward hit produced no .ove-strand-fwd layer');
  for (const b of out.forward) {
    if (!/ove-strand-fwd/.test(b.cls)) fail.push(`forward reveal tagged ${b.cls}`);
    if (b.content === 'none') fail.push('forward bar has no ::after');
    if (!near(b.height, THICK, 0.5)) fail.push(`forward bar is ${b.height}px thick, want ${THICK}`);
    if (b.layerOpacity !== 1) fail.push(`forward layer opacity ${b.layerOpacity}, the bar would be washed out`);
    // Measured, not hardcoded. NUDGE overlaps the letters' box by 1px, so the
    // bar's bottom edge lands just inside the top of the letters.
    if (!near(b.barTop + b.height, b.seqTop + 1)) {
      fail.push(`forward bar bottom ${b.barTop + b.height} does not meet letters top ${b.seqTop}`);
    }
    if (/isTrueStart/.test(b.cls) && !near(b.left, CARET, 0.5)) {
      fail.push(`forward bar left inset ${b.left}, want ${CARET}`);
    }
    if (/isTrueEnd/.test(b.cls) && !near(b.right, 2 * CARET, 0.5)) {
      fail.push(`forward bar right inset ${b.right}, want ${2 * CARET}`);
    }
    if (!/isTrueStart/.test(b.cls) && b.left !== 0) fail.push('mid-hit row has a phantom left gap');
    if (!/isTrueEnd/.test(b.cls) && b.right !== 0) fail.push('mid-hit row has a phantom right gap');
  }

  /*
   * The class lands on the carets too, so they must not sprout bars. Carets do
   * carry an ::after of their own -- OVE's little black drag handle -- so the
   * test is "not OUR bar", not "no pseudo-element".
   */
  out.caretBars = await barsFor(page, oursCarets);
  if (!out.caretBars.length) fail.push('no carets found, so the caret check proved nothing');
  if (out.caretBars.some((b) => b.background === BAR_RGB && b.height === THICK)) {
    fail.push('a caret drew a strand bar');
  }

  /* -------------------------------------------------- a reverse-strand hit -- */

  await rowByName('DEMO_CLEAN_R');
  out.reverse = await barsFor(page, ours);

  if (!out.reverse.length) fail.push('revealing a reverse hit produced no .ove-strand-rev layer');
  for (const b of out.reverse) {
    if (!/ove-strand-rev/.test(b.cls)) fail.push(`reverse reveal tagged ${b.cls}`);
    if (!near(b.height, THICK, 0.5)) fail.push(`reverse bar is ${b.height}px thick`);
    if (!near(b.barTop, b.seqBottom - 1)) {
      fail.push(`reverse bar top ${b.barTop} does not meet letters bottom ${b.seqBottom}`);
    }
  }

  /* ---------------------------------------- a multi-row hit keeps its ends -- */

  await page.evaluate(() => document.dispatchEvent(
    new CustomEvent('__select', { detail: { start: 300, end: 324 } })));
  await page.waitForTimeout(300);
  out.plainSelectionHasNoBar = (await barsFor(page, '.veRowView .veRowViewSelectionLayer.notCaret'))
    .filter((b) => !/cutsiteLabel/.test(b.cls))
    .every((b) => b.content === 'none');
  if (!out.plainSelectionHasNoBar) fail.push('a hand-dragged selection drew a strand bar');

  /* ------------------------------------------- OVE Find, and the triangles -- */

  // The magnifier in the toolbar swaps itself for the find bar.
  await page.locator('.ve-tool-container-findTool').first().click();
  await page.waitForSelector('.ve-tool-container-findTool input', { timeout: 5000 });
  await page.locator('.ve-tool-container-findTool input').first().fill(BOTTOM_STRAND_QUERY);
  await page.waitForSelector(found, { timeout: 8000 });
  await page.waitForTimeout(400);

  out.findLayers = await barsFor(page, found);
  const bottom = out.findLayers.filter((b) => /BottomStrand/.test(b.cls));
  out.findBottomCount = bottom.length;
  if (!bottom.length) {
    fail.push(`Find returned no bottom-strand hit for ${BOTTOM_STRAND_QUERY}, so the triangles are unproven`);
  }
  for (const b of out.findLayers) {
    if (b.afterBorder > 0) fail.push(`a gold triangle survived on ::after (${b.afterBorder}px border)`);
    if (b.beforeContent !== 'none') {
      fail.push(`::before still renders on ${b.cls} -- a second triangle (${b.beforeBorder}px border)`);
    }
    if (!near(b.height, THICK, 0.5)) fail.push(`find bar is ${b.height}px thick`);
    if (b.layerOpacity !== 1) fail.push(`find layer opacity ${b.layerOpacity}`);
    const wantsBottom = /BottomStrand/.test(b.cls);
    const ok = wantsBottom ? near(b.barTop, b.seqBottom) : near(b.barTop + b.height, b.seqTop);
    if (!ok) fail.push(`find bar on ${wantsBottom ? 'bottom' : 'top'} strand is misplaced (${b.barTop})`);
  }

  /* --------------------------------- the variables track a layout change --- */

  // Narrowing the window reflows every row: fewer bases per row, so a different
  // label band above the letters. A one-shot measurement would go stale here.
  await page.setViewportSize({ width: 700, height: 700 });
  await page.waitForTimeout(1200);
  out.reflow = await page.evaluate(() =>
    [...document.querySelectorAll('.veRowView .veRowItem')].slice(0, 8).map((r) => {
      const seq = r.querySelector('.veRowItemSequenceContainer');
      return {
        published: r.style.getPropertyValue('--ovestrand-top'),
        // 2px layer offset, 6px bar, 1px nudge towards the letters: what the
        // value should be right now.
        expected: seq ? `${seq.offsetTop - 3}px` : null
      };
    }));
  const stale = out.reflow.filter((r) => r.expected && r.published !== r.expected);
  if (stale.length) {
    fail.push(`${stale.length} row(s) kept a stale offset after reflow: ${JSON.stringify(stale[0])}`);
  }

  /* --- reverse primers are spaced off the letters -------------------------- */

  /*
   * Both primer tracks carry the same class and the same inline 5px margin; the
   * reverse one is told apart by sitting after the letters, and is given more
   * room in media/rowView.css. Checked here rather than in its own suite
   * because the bar and the margin are the two things that read the letters'
   * geometry, and the trap is doing it with padding -- which would push
   * --ovestrand-bottom off the letters and is what the assertions above catch.
   */
  out.reverseTrack = await page.evaluate(() => {
    for (const row of document.querySelectorAll('.veRowItem')) {
      const seq = row.querySelector('.veRowItemSequenceContainer');
      if (!seq) continue;
      const after = [...row.querySelectorAll('.veRowViewPrimersContainer')].filter(
        (t) => seq.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (!after.length) continue;
      return {
        margin: parseFloat(getComputedStyle(after[0]).marginTop),
        gap: Math.round(after[0].getBoundingClientRect().top - seq.getBoundingClientRect().bottom)
      };
    }
    return null;
  });
  if (!out.reverseTrack) {
    fail.push('no reverse primer track on screen to measure');
  } else {
    // Upstream's inline value is 5px; anything at or below it means the rule
    // lost to the inline style -- which it does without !important.
    if (!(out.reverseTrack.margin > 5)) {
      fail.push(`the reverse primer track is at ${out.reverseTrack.margin}px, not spaced off the letters`);
    }
    if (out.reverseTrack.gap !== out.reverseTrack.margin) {
      fail.push(`margin ${out.reverseTrack.margin}px but the drawn gap is ${out.reverseTrack.gap}px`);
    }
  }

  /* --- the bar sits under the annotation tracks ---------------------------- */

  /*
   * Stacking here is document order: every row child is position:relative with
   * z-index auto, and the selection layer is the row's first child. So the bar
   * paints under the primer and feature tracks as long as nothing gives it an
   * explicit z-index -- which it used to have, and which put it across any
   * primer drawn over the same bases.
   */
  out.stacking = await page.evaluate(() => {
    const layer = document.querySelector('.veRowView .veSearchLayer.notCaret, .veRowView .ove-strand-rev.notCaret, .veRowView .ove-strand-fwd.notCaret');
    if (!layer) return null;
    const row = layer.closest('.veRowItem');
    const kids = [...row.children];
    const layerAt = kids.findIndex((n) => n === layer || n.contains(layer));
    const trackAt = kids.findIndex((n) => /PrimersContainer|FeaturesContainer/.test(n.className));
    return {
      barZ: getComputedStyle(layer, '::after').zIndex,
      layerAt,
      trackAt
    };
  });
  if (out.stacking) {
    if (out.stacking.barZ !== 'auto') {
      fail.push(`the bar has z-index ${out.stacking.barZ}; that lifts it over the primer track`);
    }
    if (out.stacking.trackAt >= 0 && !(out.stacking.layerAt < out.stacking.trackAt)) {
      fail.push(`selection layer at ${out.stacking.layerAt} is not before the track at ${out.stacking.trackAt}`);
    }
  }

  out.failures = fail;
  out.ok = fail.length === 0;
  return out;
}
