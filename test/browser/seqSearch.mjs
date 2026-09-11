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

const hits = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.oveseq-hit')].map((h) => h.innerText.replace(/\n/g, ' ')));

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
    radios: [...document.querySelectorAll('.oveseq-radio')].map((r) => r.textContent.trim()),
    identDisabled: document.querySelector('.oveseq-ident input').disabled
  }));
  for (const label of ['Nucleotide', 'Amino acid', 'Exact', 'Fuzzy']) {
    if (!out.controls.radios.includes(label)) fail.push(`no ${label} radio`);
  }
  if (!out.controls.drop) fail.push('no drop zone');
  if (!out.controls.query) fail.push('no query box');
  // The threshold only means something under Fuzzy.
  if (!out.controls.identDisabled) fail.push('the identity box should start disabled under Exact');

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

  /* --- fuzzy enables the threshold ----------------------------------------- */

  await page.locator('.oveseq-radio', { hasText: 'Fuzzy' }).click();
  await page.waitForTimeout(400);
  out.identAfterFuzzy = await page.evaluate(() =>
    document.querySelector('.oveseq-ident input').disabled);
  if (out.identAfterFuzzy) fail.push('the identity box should enable under Fuzzy');

  /* --- searching ----------------------------------------------------------- */

  await page.locator('.oveseq-query').fill('GAGTTTCATATGGCTAGCAAAGGAGAAGAACTT');
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__clearPosted')));
  await page.locator('.oveseq-go').click();
  await page.waitForTimeout(600);

  out.ranSearch = (await posted(page)).find((m) => m.type === 'seqsearch/run') || null;
  if (!out.ranSearch) fail.push('Search posted nothing');
  else if (out.ranSearch.exact !== false) fail.push('the search did not carry the Fuzzy choice');

  out.hits = await hits(page);
  if (out.hits.length !== 3) fail.push(`expected 3 hits, got ${out.hits.length}`);
  // Best first, and coordinates 1-based the way the editor counts.
  if (out.hits[0] && !/pUC19/.test(out.hits[0])) {
    fail.push(`the best hit should be first: ${JSON.stringify(out.hits[0])}`);
  }
  if (out.hits[0] && !/1204\.\.1236/.test(out.hits[0])) {
    fail.push(`coordinates should be 1-based: ${JSON.stringify(out.hits[0])}`);
  }

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
  out.aaHits = await hits(page);
  if (!out.aaHits.length) {
    fail.push('an amino acid search returned nothing');
  } else {
    // Without the frame the nucleotide coordinates of a protein hit are
    // unreadable -- you cannot tell which of three offsets it came from.
    if (!/frame \+2/.test(out.aaHits[0])) {
      fail.push(`a protein hit should name its frame: ${JSON.stringify(out.aaHits[0])}`);
    }
    if (!/8 aa/.test(out.aaHits[0])) {
      fail.push(`a protein hit should be measured in residues: ${JSON.stringify(out.aaHits[0])}`);
    }
    if (!out.aaHits.some((h) => /frame -3/.test(h))) {
      fail.push('no reverse-frame hit, so the negative frames were not rendered');
    }
  }

  out.FAILURES = fail;
  out.PASS = fail.length === 0;
  return out;
}
