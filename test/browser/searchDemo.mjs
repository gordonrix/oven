/*
 * Drives media/SearchDemo.html to exercise primer search and attach against
 * the real OVE bundle.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/SearchDemo.html --script test/browser/searchDemo.mjs
 *
 * All page state is read through DOM bridges — page.evaluate runs in an
 * isolated world and cannot see the page's JS globals.
 */

const probe = (page) => page.evaluate(() => {
  document.dispatchEvent(new CustomEvent('__probe'));
  return JSON.parse(document.getElementById('probe').textContent || '{}');
});
const posted = (page) =>
  page.evaluate(() => JSON.parse(document.getElementById('posted').textContent || '[]'));
const clearPosted = (page) =>
  page.evaluate(() => document.dispatchEvent(new CustomEvent('__clearPosted')));
const menus = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.bp3-menu')].map((m) => m.innerText.replace(/\n/g, ' / ')));

const rows = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.ovesearch-row:not(.ovesearch-header)')].map((r) => ({
    pos: r.querySelector('.ovesearch-c0').textContent,
    strand: r.querySelector('.ovesearch-c1').textContent,
    name: r.querySelector('.ovesearch-c2').textContent,
    anneal: r.querySelector('.ovesearch-c3').textContent,
    tm: r.querySelector('.ovesearch-c4').textContent,
    tail: r.querySelector('.ovesearch-c5').textContent,
    alias: r.querySelector('.ovesearch-c6').textContent,
    action: r.querySelector('.ovesearch-attach').textContent,
    disabled: r.querySelector('.ovesearch-attach').disabled
  })));

const dismiss = async (page) => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.mouse.click(4, 4);
  await page.waitForTimeout(250);
};

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.waitForSelector('body[data-ready="true"]', { timeout: 30000 });
  await page.waitForSelector('.veVectorInteractionWrapper', { timeout: 20000 });
  out.baseline = await probe(page);

  // --- the toolbar button opens the panel, beside the sequence ------------
  await page.locator('#ove-search-button').click();
  await page.waitForSelector('.ovesearch-row', { timeout: 8000 });
  out.rows = await rows(page);

  // The whole point of the panel: the sequence must remain on screen.
  out.sequenceVisibleWithPanel = await page.locator('.veRowView, .veRowViewSequence').first().isVisible();
  out.panelTabs = await page.evaluate(() =>
    [...document.querySelectorAll('[class*=veTab]')].map((e) => e.innerText.trim()).filter(Boolean));
  if (!out.sequenceVisibleWithPanel) fail.push('the sequence map is hidden while the search panel is open');
  if (!out.panelTabs.includes('Primer Search')) fail.push(`no Primer Search tab: ${out.panelTabs}`);
  if (!out.panelTabs.includes('Sequence Map')) fail.push('the Sequence Map tab disappeared');

  if (out.rows.length !== 5) fail.push(`expected 5 hits, got ${out.rows.length}`);
  const strands = out.rows.map((r) => r.strand);
  if (!strands.includes('+') || !strands.includes('−')) fail.push(`strand column missing a direction: ${strands}`);
  const positions = out.rows.map((r) => parseInt(r.pos, 10));
  if (positions.slice().sort((a, b) => a - b).join() !== positions.join()) {
    fail.push(`rows are not sorted by position: ${positions}`);
  }
  const tailed = out.rows.filter((r) => r.tail !== '—');
  if (tailed.length !== 2) fail.push(`expected 2 tailed hits, got ${tailed.length}`);

  // --- 100% match only, filtered client-side ------------------------------
  await clearPosted(page);
  await page.locator('.ovesearch-check input').check();
  await page.waitForTimeout(300);
  out.rowsFullOnly = await rows(page);
  out.countFullOnly = await page.evaluate(() => document.querySelector('.ovesearch-count').textContent);
  out.postedWhileToggling = await posted(page);

  if (out.rowsFullOnly.length !== 3) fail.push(`100% filter should leave 3, got ${out.rowsFullOnly.length}`);
  if (out.rowsFullOnly.some((r) => r.tail !== '—')) fail.push('a tailed hit survived the 100% filter');
  if (!/3 of 5 hits/.test(out.countFullOnly)) fail.push(`count should read "3 of 5 hits", got "${out.countFullOnly}"`);
  if (out.postedWhileToggling.length) fail.push('toggling the filter must not trigger another search/run');

  await page.locator('.ovesearch-check input').uncheck();
  await page.waitForTimeout(300);
  if ((await rows(page)).length !== 5) fail.push('unticking the filter did not restore the hidden rows');

  // --- ATTACH must not clobber anything -----------------------------------
  await clearPosted(page);
  const before = await probe(page);
  const tailRow = page.locator('.ovesearch-row', { hasText: 'DEMO_TAIL_F' }).first();
  await tailRow.locator('.ovesearch-attach').click();
  await page.waitForTimeout(700);
  const after = await probe(page);
  out.attachBefore = { seqLen: before.seqLen, features: before.features, primerIds: before.primerIds };
  out.attachAfter = { seqLen: after.seqLen, features: after.features, primerIds: after.primerIds };

  if (after.seqLen !== before.seqLen) fail.push(`sequence length changed ${before.seqLen} -> ${after.seqLen}`);
  if (after.name !== before.name) fail.push(`sequence name changed to ${after.name}`);
  if (after.circular !== before.circular) fail.push('circularity changed');
  if (after.features !== before.features) fail.push(`feature count changed ${before.features} -> ${after.features}`);
  for (const id of before.primerIds) {
    if (!after.primerIds.includes(id)) fail.push(`pre-existing primer ${id} was dropped`);
  }
  if (after.primerIds.length !== before.primerIds.length + 1) {
    fail.push(`expected exactly one new primer, went ${before.primerIds.length} -> ${after.primerIds.length}`);
  }

  const added = after.primers.find((p) => !before.primerIds.includes(p.id));
  out.attached = added;
  if (added) {
    if (added.name !== 'DEMO_TAIL_F') fail.push(`attached primer named ${added.name}`);
    if (added.type !== 'primer_bind') fail.push(`attached primer type ${added.type}`);
    if (added.start !== 1500 || added.end !== 1521) fail.push(`footprint should be 1500..1521, got ${added.start}..${added.end}`);
    if (added.strand !== 1) fail.push(`strand should be 1, got ${added.strand}`);
    // The tail is absent from the template but must survive on the primer.
    if (!added.bases || added.bases.length !== 38) {
      fail.push(`bases should be the full 38 nt ordered primer, got ${added.bases && added.bases.length}`);
    }
    if (added.bases && !added.bases.startsWith('GGGGCCCCTTTTAAAA')) {
      fail.push('the 5′ tail was lost from bases');
    }
  }

  out.postedDuringAttach = await posted(page);
  if (out.postedDuringAttach.some((m) => m.type === 'cart/add')) {
    fail.push('attach must not add to the cart (beforeAnnotationCreate should stay out of it)');
  }

  // the row should now read as attached
  out.rowsAfterAttach = await rows(page);
  const nowAttached = out.rowsAfterAttach.find((r) => r.name === 'DEMO_TAIL_F');
  if (!nowAttached || !nowAttached.disabled) {
    fail.push('the attached row should be marked and its button disabled');
  }

  // --- right-click entries -------------------------------------------------
  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent('__select', { detail: { start: 200, end: 260 } })));
  await page.waitForTimeout(400);
  const selEl = page.locator('.veRowViewSelectionLayer, [class*=SelectionLayer]').first();
  if (await selEl.count()) {
    await selEl.click({ button: 'right' });
    await page.waitForTimeout(700);
    out.selectionMenu = (await menus(page))[0] || null;
    if (!out.selectionMenu || !out.selectionMenu.includes('Search primers in selection')) {
      fail.push('selection right-click is missing the search entry');
    }
    if (out.selectionMenu && !out.selectionMenu.includes('Copy')) {
      fail.push('the override dropped OVE’s own selection menu entries');
    }
    await dismiss(page);
  } else {
    fail.push('no selection layer rendered to right-click');
  }

  // Clear the selection first: right-clicking inside a selection legitimately
  // opens the selection menu, so leaving one set tests the wrong handler.
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__clearSelection')));
  await page.waitForTimeout(400);
  const bg = page.locator('.veRowViewSequence, .veRowView').first();
  await bg.click({ button: 'right' });
  await page.waitForTimeout(700);
  out.backgroundMenu = (await menus(page))[0] || null;
  /*
   * Whatever lies under the cursor -- translation, ORF, feature, bare sequence
   * -- the entry must be there. Note OVE selects an annotation when you
   * right-click it, so on an annotation the entry legitimately reads "in
   * selection"; only genuinely empty sequence yields "in plasmid". Assert the
   * entry exists and that its scope is one of the two, rather than pinning a
   * variant that depends on what the fixture happens to have at that pixel.
   */
  if (!out.backgroundMenu || !/Search primers in (selection|plasmid)/.test(out.backgroundMenu)) {
    fail.push(`right-clicking the sequence is missing the search entry: ${out.backgroundMenu}`);
  }
  if (out.backgroundMenu && !out.backgroundMenu.includes('Create')) {
    fail.push('the override displaced OVE’s own entries on this menu');
  }
  await dismiss(page);

  // --- resizable columns ---------------------------------------------------
  const colsNow = () => page.evaluate(() =>
    getComputedStyle(document.querySelector('.ovesearch-root'))
      .getPropertyValue('--ovesearch-cols').trim());
  const nameWidth = () => page.evaluate(() =>
    Math.round(document.querySelector('.ovesearch-header .ovesearch-c2').getBoundingClientRect().width));

  out.colsDefault = await colsNow();
  out.nameWidthBefore = await nameWidth();

  await clearPosted(page);
  const grip = page.locator('.ovesearch-header .ovesearch-c2 .ovesearch-grip');
  out.gripCount = await page.locator('.ovesearch-grip').count();
  if (out.gripCount !== 8) fail.push(`expected a grip per column, got ${out.gripCount}`);

  const box = await grip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  out.nameWidthAfter = await nameWidth();
  out.colsAfter = await colsNow();
  out.savedWidths = (await posted(page)).filter((m) => m.type === 'search/setColumnWidths');

  const grew = out.nameWidthAfter - out.nameWidthBefore;
  if (grew < 50 || grew > 90) fail.push(`dragging +70px should widen the Name column by ~70, got ${grew}`);
  if (out.savedWidths.length !== 1) fail.push(`expected one width save on mouseup, got ${out.savedWidths.length}`);
  if (out.savedWidths[0] && out.savedWidths[0].widths.length !== 8) fail.push('saved widths should cover all 8 columns');

  // body rows must track the header, or the table shears
  out.bodyNameWidth = await page.evaluate(() => Math.round(
    document.querySelector('.ovesearch-row:not(.ovesearch-header) .ovesearch-c2').getBoundingClientRect().width));
  if (Math.abs(out.bodyNameWidth - out.nameWidthAfter) > 2) {
    fail.push(`body column ${out.bodyNameWidth} does not match header ${out.nameWidthAfter}`);
  }

  // double-click resets every column
  await clearPosted(page);
  await grip.dblclick();
  await page.waitForTimeout(300);
  out.colsAfterReset = await colsNow();
  if (out.colsAfterReset !== out.colsDefault) {
    fail.push(`double-click should restore the defaults: ${out.colsAfterReset} vs ${out.colsDefault}`);
  }

  // a re-search must not throw the widths away
  await grip.boundingBox().then(async (b) => {
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 40, b.y + b.height / 2, { steps: 5 });
    await page.mouse.up();
  });
  await page.waitForTimeout(250);
  const widened = await nameWidth();
  await page.locator('.ovesearch-tab', { hasText: 'Whole plasmid' }).click();
  await page.waitForTimeout(700);
  out.nameWidthAfterResearch = await nameWidth();
  if (Math.abs(out.nameWidthAfterResearch - widened) > 2) {
    fail.push(`widths must survive a re-search: ${widened} -> ${out.nameWidthAfterResearch}`);
  }

  // --- scoping ------------------------------------------------------------
  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent('__select', { detail: { start: 1400, end: 1600 } })));
  await page.waitForTimeout(300);
  await page.locator('#ove-search-button').click();
  await page.waitForTimeout(700);
  out.scopedRows = await rows(page);
  out.scopedCount = await page.evaluate(() => document.querySelector('.ovesearch-count').textContent);
  if (out.scopedRows.length !== 1 || out.scopedRows[0].name !== 'DEMO_TAIL_F') {
    fail.push(`scoping to 1400..1600 should leave only DEMO_TAIL_F, got ${out.scopedRows.map((r) => r.name)}`);
  }
  if (!/in selection/.test(out.scopedCount)) fail.push(`count should say "in selection": ${out.scopedCount}`);

  out.FAILURES = fail;
  out.PASS = fail.length === 0;
  return out;
}
