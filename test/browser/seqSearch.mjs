/*
 * The Sequence Search panel.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/SeqSearchDemo.html --script test/browser/seqSearch.mjs
 *
 * The matching itself is unit-tested in test/unit/seqSearch.test.js against the
 * real algorithm; this drives the panel, whose host is stubbed by the demo.
 */

const posted = (page) => page.evaluate(() =>
  JSON.parse(document.getElementById('posted').textContent || '[]'));

/** One array of cell texts per row, so a column can be checked by position. */
const hits = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.oveseq-hit')].map((row) =>
    [...row.querySelectorAll('.oveseq-cell')].map((c) => c.textContent.trim())));

const headers = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.oveseq-header .oveseq-cell')].map((c) => c.textContent.trim()));

/** rgb(...) -> perceived lightness, for comparing two greys. */
const lightness = (css) => {
  const m = /(\d+), ?(\d+), ?(\d+)/.exec(css || '');
  if (!m) return null;
  return 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]);
};

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.setViewportSize({ width: 560, height: 900 });
  await page.waitForSelector('body[data-ready=true]', { timeout: 30000 });
  await page.waitForTimeout(600);

  /* --- the controls are all there ------------------------------------------ */

  out.controls = await page.evaluate(() => ({
    drop: Boolean(document.querySelector('.oveseq-drop')),
    query: Boolean(document.querySelector('.oveseq-query')),
    radios: [...document.querySelectorAll('.oveseq-radio')].map((r) => r.textContent.trim())
  }));
  for (const label of ['Nucleotide', 'Amino acid', 'Exact', 'Fuzzy']) {
    if (!out.controls.radios.includes(label)) fail.push(`no ${label} radio`);
  }
  if (!out.controls.drop) fail.push('no drop zone');
  if (!out.controls.query) fail.push('no query box');

  const modeOn = () => page.evaluate(() => {
    const wrap = document.querySelector('.oveseq-radios[data-group="mode"]');
    const on = [...wrap.querySelectorAll('.oveseq-radio')].find((r) => r.classList.contains('is-on'));
    return on ? on.textContent.trim() : null;
  });
  const ident = page.locator('.oveseq-ident input');

  /*
   * The threshold belongs to Fuzzy, so under Exact -- the default -- there is
   * nothing to see. It was greyed out instead, which read as a control you
   * ought to be able to use and could not.
   */
  out.mode = { start: await modeOn(), identShown: await ident.isVisible() };
  if (out.mode.start !== 'Exact') fail.push(`Exact should be the default, got ${out.mode.start}`);
  if (out.mode.identShown) fail.push('Exact has no threshold, so the box should not be shown');

  await page.locator('.oveseq-radio', { hasText: 'Fuzzy' }).click();
  await page.waitForTimeout(300);
  out.identUnderFuzzy = {
    shown: await ident.isVisible(),
    disabled: await ident.isDisabled()
  };
  if (!out.identUnderFuzzy.shown) fail.push('Fuzzy should bring the threshold back');
  if (out.identUnderFuzzy.disabled) fail.push('the threshold should be editable under Fuzzy');

  await ident.fill('80');
  await page.waitForTimeout(200);

  // Going back and forth must not cost what was typed: the strip is patched in
  // place rather than rebuilt, which is the whole reason the value survives.
  await page.locator('.oveseq-radio', { hasText: 'Exact' }).click();
  await page.waitForTimeout(300);
  out.hiddenAgain = await ident.isVisible();
  if (out.hiddenAgain) fail.push('Exact should take the threshold away again');

  await page.locator('.oveseq-radio', { hasText: 'Fuzzy' }).click();
  await page.waitForTimeout(300);
  out.keptValue = await ident.inputValue();
  if (out.keptValue !== '80') {
    fail.push(`the typed threshold should survive a round trip: ${out.keptValue}`);
  }

  /*
   * --- the panel fills its tab --------------------------------------------
   *
   * The host sets no page height, so a root that only sizes to its content
   * leaves the tab's own background showing underneath -- which looks like a
   * short white strip floating on grey rather than a panel.
   */
  out.fill = await page.evaluate(() => {
    const root = document.querySelector('.oveseq-root');
    const box = root.getBoundingClientRect();
    return {
      bottom: Math.round(box.bottom),
      viewport: window.innerHeight,
      background: getComputedStyle(root).backgroundColor
    };
  });
  if (out.fill.bottom < out.fill.viewport) {
    fail.push(`the panel stops at ${out.fill.bottom} of ${out.fill.viewport}px `
      + '-- it should reach the bottom of the tab');
  }
  if (!/255, 255, 255/.test(out.fill.background)) {
    fail.push(`the panel should be white, got ${out.fill.background}`);
  }

  /* --- a folder chip reads as three weights -------------------------------- */

  await page.locator('.oveseq-btn.secondary').click();     // Browse…
  await page.waitForTimeout(500);

  out.folder = await page.evaluate(() => {
    const chip = document.querySelector('.oveseq-folder');
    if (!chip) return null;
    const part = (sel) => {
      const n = chip.querySelector(sel);
      return n ? { text: n.textContent, color: getComputedStyle(n).color } : null;
    };
    return {
      name: part('.oveseq-foldername'),
      sub: part('.oveseq-foldersub'),
      count: part('.oveseq-foldercount'),
      tick: Boolean(chip.querySelector('.oveseq-foldertick input'))
    };
  });

  if (!out.folder) {
    fail.push('Browse added no folder');
  } else {
    if (out.folder.sub === null || !/and subfolders/.test(out.folder.sub.text)) {
      fail.push('a folder searched recursively should say so');
    }
    if (!out.folder.tick) fail.push('no subfolder tickbox on the chip');
    /*
     * The point of the three weights: the folder is the thing, the file count
     * is a fact about it, and "and subfolders" only qualifies the reach. Each
     * step has to be lighter than the last or the qualifier competes with the
     * name.
     */
    const name = lightness(out.folder.name.color);
    const count = lightness(out.folder.count.color);
    const sub = lightness(out.folder.sub.color);
    if (!(sub > count && count > name)) {
      fail.push(`greys out of order: name ${name.toFixed(0)}, count ${count.toFixed(0)}, `
        + `subfolders ${sub.toFixed(0)} -- expected each lighter than the last`);
    }
  }

  /* --- a dropped file is refused, a dropped folder is not ------------------ */

  const drop = async (uri) => {
    await page.evaluate((u) => {
      const zone = document.querySelector('.oveseq-drop');
      const dt = new DataTransfer();
      dt.setData('text/uri-list', u);
      zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, uri);
    await page.waitForTimeout(500);
  };

  const folderCount = () => page.evaluate(() => document.querySelectorAll('.oveseq-folder').length);

  const before = await folderCount();
  await drop('file:///maps/pUC19.gb');
  out.afterFileDrop = {
    folders: await folderCount(),
    status: await page.evaluate(() => (document.querySelector('.oveseq-status') || {}).textContent || '')
  };
  if (out.afterFileDrop.folders !== before) fail.push('a dropped file was added as a folder');
  if (!/is a file|are files/.test(out.afterFileDrop.status)) {
    fail.push(`a refused file should say why, got ${JSON.stringify(out.afterFileDrop.status)}`);
  }

  await drop('file:///maps/Level%200');
  out.afterFolderDrop = await folderCount();
  if (out.afterFolderDrop !== before + 1) fail.push('a dropped folder was not added');

  /* --- the chosen threshold reaches the search ----------------------------- */


  /* --- searching ----------------------------------------------------------- */

  await page.locator('.oveseq-query').fill('GAGTTTCATATGGCTAGCAAAGGAGAAGAACTT');
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__clearPosted')));
  await page.locator('.oveseq-go').click();
  await page.waitForTimeout(600);

  out.ranSearch = (await posted(page)).find((m) => m.type === 'seqsearch/run') || null;
  if (!out.ranSearch) {
    fail.push('Search posted nothing');
  } else {
    if (out.ranSearch.exact !== false) fail.push('the search did not carry the Fuzzy choice');
    // The typed 80, not the 90 it started at -- an edited threshold that does
    // not reach the host is the same as one that cannot be edited.
    if (out.ranSearch.minIdentity !== 0.8) {
      fail.push(`the search used a threshold of ${out.ranSearch.minIdentity}, expected 0.8`);
    }
  }

  out.headers = await headers(page);
  if (out.headers.join('|') !== 'Name|Pos|% ID|Length bp|Str') {
    fail.push(`unexpected columns: ${out.headers.join('|')}`);
  }

  out.hits = await hits(page);
  if (out.hits.length !== 3) fail.push(`expected 3 hits, got ${out.hits.length}`);
  // Every row has to fill every column, or the grid stops lining up.
  for (const row of out.hits) {
    if (row.length !== out.headers.length) {
      fail.push(`a row has ${row.length} cells for ${out.headers.length} columns`);
      break;
    }
  }
  // Best first by default -- the ranking the host sent, not a column sort.
  if (out.hits[0] && out.hits[0][0] !== 'pUC19.gb') {
    fail.push(`the best hit should be first: ${JSON.stringify(out.hits[0])}`);
  }
  // 1-based the way the editor counts.
  if (out.hits[0] && out.hits[0][1] !== '1204..1236') {
    fail.push(`coordinates should be 1-based: ${JSON.stringify(out.hits[0])}`);
  }

  /* --- clicking a header sorts by that column ------------------------------ */

  const clickHeader = async (label) => {
    await page.locator('.oveseq-header .oveseq-cell', { hasText: label }).first().click();
    await page.waitForTimeout(300);
  };
  const names = (rows) => rows.map((r) => r[0]);

  const ranked = names(out.hits);

  await clickHeader('Name');
  out.byName = names(await hits(page));
  const alphabetical = [...ranked].sort();
  if (out.byName.join() !== alphabetical.join()) {
    fail.push(`sorting by Name gave ${out.byName.join()}, expected ${alphabetical.join()}`);
  }

  await clickHeader('Name');                       // second click reverses
  out.byNameDesc = names(await hits(page));
  if (out.byNameDesc.join() !== [...alphabetical].reverse().join()) {
    fail.push(`the second click should reverse, got ${out.byNameDesc.join()}`);
  }

  // A third click goes back to the ranking, which is otherwise unreachable
  // without re-running the search.
  await clickHeader('Name');
  out.backToRank = names(await hits(page));
  if (out.backToRank.join() !== ranked.join()) {
    fail.push(`the third click should restore the ranking, got ${out.backToRank.join()}`);
  }

  // A numeric column has to sort numerically, not as text.
  await clickHeader('Length');
  out.byLen = (await hits(page)).map((r) => Number(r[3]));
  if (out.byLen.join() !== [...out.byLen].sort((a, b) => a - b).join()) {
    fail.push(`Length sorted as ${out.byLen.join()}, which is not ascending`);
  }
  await clickHeader('Length');
  await clickHeader('Length');                     // back to the ranking

  /* --- the filter box ------------------------------------------------------ */

  await page.locator('.oveseq-filter').fill('pGR');
  await page.waitForTimeout(300);
  out.filtered = names(await hits(page));
  if (out.filtered.length !== 1 || !/pGR/.test(out.filtered[0])) {
    fail.push(`filtering for pGR gave ${JSON.stringify(out.filtered)}`);
  }
  out.filterCount = await page.evaluate(() =>
    (document.querySelector('.oveseq-count') || {}).textContent || '');
  if (!/1 of 3/.test(out.filterCount)) {
    fail.push(`the count should say what was hidden, got ${JSON.stringify(out.filterCount)}`);
  }

  // Typing must not cost the caret -- the box is rebuilt on a state push, but
  // filtering is not a state push.
  out.filterFocused = await page.evaluate(() =>
    document.activeElement === document.querySelector('.oveseq-filter'));
  if (!out.filterFocused) fail.push('the filter box lost focus while typing');

  await page.locator('.oveseq-filter').fill('');
  await page.waitForTimeout(300);

  /* --- clicking a hit asks for it to be opened ----------------------------- */

  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__clearPosted')));
  await page.locator('.oveseq-hit').first().click();
  await page.waitForTimeout(400);
  out.opened = (await posted(page)).find((m) => m.type === 'seqsearch/open') || null;
  if (!out.opened) {
    fail.push('clicking a hit asked for nothing to be opened');
  } else {
    // 0-based on the wire: the editor selects in its own coordinates.
    if (out.opened.file !== '/maps/pUC19.gb') fail.push(`wrong file: ${out.opened.file}`);
    if (out.opened.start !== 1203 || out.opened.end !== 1235) {
      fail.push(`wrong range: ${out.opened.start}..${out.opened.end}`);
    }
  }

  /* --- an amino acid hit names its frame ----------------------------------- */

  await page.locator('.oveseq-radio', { hasText: 'Amino acid' }).click();
  await page.waitForTimeout(300);
  await page.locator('.oveseq-query').fill('MKLVAGIE');
  await page.locator('.oveseq-go').click();
  await page.waitForTimeout(600);
  out.aaHeaders = await headers(page);
  out.aaHits = await hits(page);
  if (!out.aaHits.length) {
    fail.push('an amino acid search returned nothing');
  } else {
    // The unit changes with the kind of search, and it lives in the header
    // rather than being repeated down every row.
    if (out.aaHeaders[3] !== 'Length aa') {
      fail.push(`protein hits should be measured in residues: ${out.aaHeaders[3]}`);
    }
    // Without the frame the nucleotide coordinates of a protein hit are
    // unreadable -- you cannot tell which of three offsets it came from.
    if (out.aaHeaders[4] !== 'Frame') {
      fail.push(`the last column should name the frame: ${out.aaHeaders[4]}`);
    }
    if (out.aaHits[0][4] !== '+2') {
      fail.push(`a protein hit should show its frame: ${JSON.stringify(out.aaHits[0])}`);
    }
    if (!out.aaHits.some((r) => r[4] === '\u22123')) {
      fail.push(`no reverse-frame hit: ${JSON.stringify(out.aaHits.map((r) => r[4]))}`);
    }
  }

  out.FAILURES = fail;
  out.PASS = fail.length === 0;
  return out;
}
