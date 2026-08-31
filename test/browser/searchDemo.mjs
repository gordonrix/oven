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

const cell = (r, key) => {
  const n = r.querySelector(`.ovesearch-k-${key}`);
  return n ? n.textContent : null;
};
const rows = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.ovesearch-row:not(.ovesearch-header)')].map((r) => {
    const at = (key) => {
      const n = r.querySelector(`.ovesearch-k-${key}`);
      return n ? n.textContent : null;
    };
    return {
      pos: at('pos'),
      strand: at('str'),
      name: at('name'),
      anneal: at('anneal'),
      tm: at('tm'),
      tail: at('tail'),
      alias: at('col-alias'),
      description: at('col-description'),
      length: at('col-length'),
      action: r.querySelector('.ovesearch-attach').textContent,
      disabled: r.querySelector('.ovesearch-attach').disabled
    };
  }));

const headers = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.ovesearch-header > div')].map((d) => d.textContent.trim()));

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

  /* --- the caret starts in the filter box ---------------------------------- */

  /*
   * Opening the panel should leave you able to type straight away. This is not
   * a one-line focus() call: a render throws the panel away and builds it
   * again, so the focused input is destroyed by whichever render lands next --
   * results arriving, a column ticked, a row attached. Focus is carried across
   * rebuilds instead, which also keeps the caret where it was while typing.
   */
  await page.waitForTimeout(600);
  out.focusedOnOpen = await page.evaluate(() =>
    (document.activeElement.className || '').toString());
  if (!/ovesearch-filter/.test(out.focusedOnOpen)) {
    fail.push(`the filter box is not focused on open: ${JSON.stringify(out.focusedOnOpen)}`);
  }

  // Typing with nothing clicked has to reach the filter.
  await page.keyboard.type('DEMO_TAIL');
  await page.waitForTimeout(600);
  out.typedIntoFilter = await page.evaluate(() =>
    (document.querySelector('.ovesearch-filter') || {}).value);
  out.rowsWhileFiltered = (await rows(page)).length;
  if (out.typedIntoFilter !== 'DEMO_TAIL') {
    fail.push(`typing did not reach the filter: ${JSON.stringify(out.typedIntoFilter)}`);
  }
  if (!(out.rowsWhileFiltered > 0 && out.rowsWhileFiltered < 5)) {
    fail.push(`the typed filter did not narrow the rows: ${out.rowsWhileFiltered}`);
  }

  // ...but focus must not be yanked back once the caret has been put elsewhere.
  await page.evaluate(() => document.querySelector('.ovesearch-filter').blur());
  await page.locator('.ovesearch-header .ovesearch-k-tm').click();
  await page.waitForTimeout(500);
  out.focusAfterSort = await page.evaluate(() =>
    (document.activeElement.className || '').toString());
  if (/ovesearch-filter/.test(out.focusAfterSort)) {
    fail.push('a re-render stole focus back into the filter box');
  }
  // Cycle the sort back off, so the checks further down see the match order.
  await page.locator('.ovesearch-header .ovesearch-k-tm').click();
  await page.waitForTimeout(300);
  await page.locator('.ovesearch-header .ovesearch-k-tm').click();
  await page.waitForTimeout(400);
  out.sortCycledOff = await page.evaluate(() =>
    document.querySelector('.ovesearch-header .ovesearch-k-tm').textContent.trim());
  if (/[▲▼]/.test(out.sortCycledOff)) {
    fail.push(`sort not cleared before the rest of the suite: ${out.sortCycledOff}`);
  }

  await page.evaluate(() => {
    const f = document.querySelector('.ovesearch-filter');
    f.value = '';
    f.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(500);
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
    // 1499, not 1500: the tail's last base happens to match the template too,
    // so the annealing footprint legitimately extends one base further 5'.
    if (added.start !== 1499 || added.end !== 1521) fail.push(`footprint should be 1499..1521, got ${added.start}..${added.end}`);
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
    Math.round(document.querySelector('.ovesearch-header .ovesearch-k-name').getBoundingClientRect().width));

  out.colsDefault = await colsNow();
  out.nameWidthBefore = await nameWidth();

  await clearPosted(page);
  const grip = page.locator('.ovesearch-header .ovesearch-k-name .ovesearch-grip');
  out.gripCount = await page.locator('.ovesearch-grip').count();
  // Eight by default: six built-ins, the alias column, and the action column.
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
  // Widths are keyed by column key, not positional: which columns exist depends
  // on the inventory file, so an index means nothing without knowing the file.
  const savedW = out.savedWidths[0] && out.savedWidths[0].widths;
  if (Array.isArray(savedW)) fail.push('widths should be keyed by column, not an array');
  else if (!savedW || !savedW.name) fail.push(`resizing Name should store its width: ${JSON.stringify(savedW)}`);

  // body rows must track the header, or the table shears
  out.bodyNameWidth = await page.evaluate(() => Math.round(
    document.querySelector('.ovesearch-row:not(.ovesearch-header) .ovesearch-k-name').getBoundingClientRect().width));
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

  /* --- the description column, headed with the file's own wording ---------- */

  /*
   * The default is the six computed columns plus the *alias* column -- not the
   * first file column, which in a real spreadsheet is usually Length or a date.
   * The fixture puts Length first and Alias fourth so the two choices differ.
   */
  out.defaultHeaders = await headers(page);
  const expected = ['Pos', 'Str', 'Name', 'Tm', 'Anneal bp', 'Tail bp', 'Alias', ''];
  if (JSON.stringify(out.defaultHeaders) !== JSON.stringify(expected)) {
    fail.push(`default columns wrong: ${JSON.stringify(out.defaultHeaders)}`);
  }
  const withAlias = (await rows(page)).filter((r) => r.alias);
  if (!withAlias.length) fail.push('no row rendered an alias');
  if ((await rows(page)).some((r) => r.length !== null)) {
    fail.push('Length should be available but not shown by default');
  }

  /* --- the columns picker -------------------------------------------------- */

  await clearPosted(page);
  await page.locator('.ovesearch-cols > summary').click();
  await page.waitForTimeout(200);
  out.menuItems = await page.evaluate(() =>
    [...document.querySelectorAll('.ovesearch-colsitem')].map((n) => n.textContent.trim()));

  // Locked columns must not be offered at all -- a table without Pos/Str/Name
  // or the Attach button is broken, not compact.
  for (const locked of ['Pos', 'Str', 'Name']) {
    if (out.menuItems.includes(locked)) fail.push(`${locked} must not be de-selectable`);
  }
  for (const offered of ['Anneal bp', 'Tm', 'Tail bp', 'Length', 'Alias', 'Description']) {
    if (!out.menuItems.includes(offered)) fail.push(`${offered} should be in the picker`);
  }

  // Tick a file column that is off by default.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.ovesearch-colsitem')]
      .find((n) => n.textContent.trim() === 'Length');
    row.querySelector('input').click();
  });
  await page.waitForTimeout(300);
  out.headersWithLength = await headers(page);
  if (!out.headersWithLength.includes('Length')) fail.push('ticking Length did not show it');
  if ((await rows(page)).every((r) => r.length === null)) fail.push('Length column has no cells');

  // Untick a built-in one.
  await page.locator('.ovesearch-cols > summary').click();
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.ovesearch-colsitem')]
      .find((n) => n.textContent.trim() === 'Tail bp');
    row.querySelector('input').click();
  });
  await page.waitForTimeout(300);
  out.headersNoTail = await headers(page);
  if (out.headersNoTail.includes('Tail bp')) fail.push('unticking Tail bp did not hide it');

  // The choice must reach the host, or it cannot outlive the panel.
  out.savedColumns = (await posted(page)).filter((m) => m.type === 'search/setColumns');
  if (!out.savedColumns.length) fail.push('column choice was not persisted');
  const last = out.savedColumns[out.savedColumns.length - 1].columns;
  if (!last.includes('col:Length') || last.includes('tail')) {
    fail.push(`persisted set is wrong: ${JSON.stringify(last)}`);
  }

  // Header and body must stay in step, which is the failure a grid makes easy.
  out.trackCount = await page.evaluate(() => (
    getComputedStyle(document.querySelector('.ovesearch-row')).gridTemplateColumns.split(' ').length));
  if (out.trackCount !== out.headersNoTail.length) {
    fail.push(`grid has ${out.trackCount} tracks for ${out.headersNoTail.length} headers`);
  }

  /*
   * A file with no extra columns at all. The standing choice still applies --
   * Tail was unticked above and must stay unticked -- and the file columns
   * simply have nothing to contribute.
   */
  await page.evaluate(async () => {
    const fx = await fetch('../test/fixtures/searchHits.json').then((r) => r.json());
    window.postMessage({
      type: 'search/results',
      hits: fx.hits,
      inventory: { status: 'ok', path: '/demo/inventory.xlsx', message: null, rowCount: 6, extraColumns: [] },
      scoped: false, selection: null, fullLengthOnly: false, columnWidths: null, columns: null
    }, '*');
  });
  await page.waitForTimeout(300);
  out.headersNoExtras = await headers(page);
  if (JSON.stringify(out.headersNoExtras) !== JSON.stringify(['Pos', 'Str', 'Name', 'Tm', 'Anneal bp', ''])) {
    fail.push(`bare inventory should show only built-ins: ${JSON.stringify(out.headersNoExtras)}`);
  }

  // Reset puts Tail back and re-derives the alias column from the file.
  await page.locator('.ovesearch-cols > summary').click();
  await page.waitForTimeout(150);
  await page.locator('.ovesearch-colsreset').click();
  await page.waitForTimeout(300);
  out.headersAfterReset = await headers(page);
  if (!out.headersAfterReset.includes('Tail bp')) {
    fail.push(`reset should restore Tail: ${JSON.stringify(out.headersAfterReset)}`);
  }

  /* --- the tab closes from its own cross ----------------------------------- */

  // Same fix as the New Primer panel: the in-panel x is unreachable once the
  // panel shares a group with the sequence map, since only the active tab's
  // body renders. canClose puts OVE's own cross on the tab.
  out.tabCross = await page.locator('[class*=veTab-primerSearch] .bp3-icon-small-cross, [class*=veTabActive] .bp3-icon-small-cross').count();
  if (!out.tabCross) fail.push('no close cross on the Primer Search tab');

  /* --- the filter only matches what is on screen --------------------------- */

  // The bare-inventory case above left no file columns to hide, so put the full
  // fixture back before testing what the filter searches.
  await page.evaluate(async () => {
    const fx = await fetch('../test/fixtures/searchHits.json').then((r) => r.json());
    window.postMessage({
      type: 'search/results',
      hits: fx.hits,
      inventory: fx.inventory,
      scoped: false, selection: null, fullLengthOnly: false, columnWidths: null, columns: null
    }, '*');
  });
  await page.waitForTimeout(400);

  /*
   * It used to search every column of the inventory file, shown or not. That
   * sounded more useful and was not: filtering a real inventory by "896" matched
   * the date-ordered serial of three unrelated primers and returned rows with no
   * 896 anywhere visible, while the primer actually named ...896 was absent.
   *
   * "2026" lives only in Date ordered, which is not shown by default.
   */
  const filterBox = page.locator('.ovesearch-filter');
  await filterBox.fill('2026');
  await page.waitForTimeout(500);
  out.hiddenColumnMatches = (await rows(page)).length;
  if (out.hiddenColumnMatches !== 0) {
    fail.push(`a hidden column matched the filter: ${out.hiddenColumnMatches} rows`);
  }

  // Show that column and the same filter starts matching. The filter is cleared
  // first: with nothing on screen the picker has no file columns to list.
  await filterBox.fill('');
  await page.waitForTimeout(400);
  // Force it open rather than clicking: earlier sections leave the picker in
  // either state, and a toggle would shut it half the time.
  await page.evaluate(() => { document.querySelector('.ovesearch-cols').open = true; });
  await page.waitForTimeout(300);
  out.pickerLabels = await page.evaluate(() =>
    [...document.querySelectorAll('.ovesearch-colsitem')].map((n) => n.textContent.trim()));
  out.pickedDateColumn = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.ovesearch-colsitem')]
      .find((n) => n.textContent.trim() === 'Date ordered');
    if (!row) return false;
    row.querySelector('input').click();
    return true;
  });
  if (!out.pickedDateColumn) fail.push('no "Date ordered" entry in the columns picker');
  await page.waitForTimeout(400);
  await filterBox.fill('2026');
  await page.waitForTimeout(600);
  out.shownColumnMatches = (await rows(page)).length;
  if (!(out.shownColumnMatches > 0)) {
    fail.push('showing the column did not make the filter match it');
  }
  await filterBox.fill('');
  await page.waitForTimeout(400);
  // Put the column back, so the sort checks below run on the default layout.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.ovesearch-colsitem')]
      .find((n) => n.textContent.trim() === 'Date ordered');
    if (row) row.querySelector('input').click();
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => { document.querySelector('.ovesearch-cols').open = false; });
  await page.waitForTimeout(300);

  /* --- clicking a header sorts by it --------------------------------------- */

  const tmColumn = () => page.evaluate(() =>
    [...document.querySelectorAll('.ovesearch-row:not(.ovesearch-header) .ovesearch-k-tm')]
      .map((n) => n.textContent));
  const tmHeader = page.locator('.ovesearch-header .ovesearch-k-tm');

  out.tmDefault = await tmColumn();
  await tmHeader.click();
  await page.waitForTimeout(400);
  out.tmAsc = await tmColumn();
  out.sortMark = await page.evaluate(() =>
    document.querySelector('.ovesearch-header .ovesearch-k-tm').textContent.trim());
  await tmHeader.click();
  await page.waitForTimeout(400);
  out.tmDesc = await tmColumn();
  await tmHeader.click();
  await page.waitForTimeout(400);
  out.tmBack = await tmColumn();

  const asNums = (a) => a.map(Number);
  const ascending = (a) => asNums(a).every((v, i, arr) => i === 0 || arr[i - 1] <= v);
  if (!ascending(out.tmAsc)) fail.push(`first click should sort ascending: ${out.tmAsc}`);
  if (!ascending(out.tmDesc.slice().reverse())) {
    fail.push(`second click should sort descending: ${out.tmDesc}`);
  }
  // Third click returns to the matcher's own order, which is by position.
  if (JSON.stringify(out.tmBack) !== JSON.stringify(out.tmDefault)) {
    fail.push(`third click should restore the default order: ${out.tmBack}`);
  }
  if (!/▲/.test(out.sortMark)) fail.push(`no ascending marker on the sorted header: ${out.sortMark}`);

  /* --- an attached primer can actually be saved ---------------------------- */

  /*
   * Attaching writes into the store with updateEditor rather than through OVE's
   * annotation pipeline, so it has to mint a fresh stateTrackingId by hand.
   * Without one, File > Save stays greyed out and mod+s does nothing: the primer
   * draws on the map, looks attached, and never reaches the file.
   *
   * The strand check below is an invariant, not a fix. jsonToGenbank decides
   * complement() from `strand`, not `forward`, and attach only sets `forward` --
   * it is tidyUpSequenceData that fills in the other one on the way through. If
   * that ever stops happening, every reverse primer attached here would be
   * written to disk as a forward one, which is invisible until the file is
   * reopened.
   */
  const ids = async () => {
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('__dumpIds')));
    await page.waitForTimeout(200);
    return page.evaluate(() => JSON.parse(document.getElementById('ids').textContent || '{}'));
  };

  out.idsBeforeAttach = await ids();

  // Attach every hit that can be attached, so both strands are covered. A hit
  // whose footprint an existing primer already covers has its button disabled.
  const attachCount = await page.locator('.ovesearch-attach').count();
  for (let i = 0; i < attachCount; i++) {
    const btn = page.locator('.ovesearch-attach').nth(i);
    if (await btn.isDisabled()) continue;
    await btn.click();
    await page.waitForTimeout(350);
  }

  out.idsAfterAttach = await ids();
  if (out.idsAfterAttach.tracking === out.idsBeforeAttach.tracking) {
    fail.push('attaching did not change stateTrackingId, so File > Save stays disabled');
  }
  if (out.idsAfterAttach.tracking === 'initialLoadId') {
    fail.push('stateTrackingId is still initialLoadId after an attach');
  }

  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__clearPosted')));
  await page.locator('#save-button').click();
  await page.waitForTimeout(700);
  const saveMsg = (await posted(page)).find((m) => m.type === 'save');
  out.attachedPrimers = saveMsg
    ? Object.values(saveMsg.data.primers || {})
      .filter((pr) => /^inv-/.test(pr.id || ''))
      .map((pr) => ({ name: pr.name, forward: pr.forward, strand: pr.strand }))
    : [];

  if (!out.attachedPrimers.length) fail.push('no attached primer reached the save payload');
  for (const pr of out.attachedPrimers) {
    const want = pr.forward ? 1 : -1;
    if (pr.strand !== want) {
      fail.push(`${pr.name}: forward ${pr.forward} but strand ${pr.strand} -- the strand will be lost on save`);
    }
  }
  if (!out.attachedPrimers.some((pr) => pr.strand === -1)) {
    fail.push('no reverse primer among the attached ones, so the strand check proved nothing');
  }

  out.FAILURES = fail;
  out.PASS = fail.length === 0;
  return out;
}
