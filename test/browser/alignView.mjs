/*
 * Drives media/AlignDemo.html to exercise the alignment panel against the real
 * OVE bundle.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/AlignDemo.html --script test/browser/alignView.mjs
 *
 * The host is stubbed, so this covers the client half: the setup strip, all
 * three ways of adding reads, and the payload handed to createAlignmentView.
 * Whether the workbench actually delivers an OS drag is the one part only the
 * Extension Development Host can answer.
 */

const posted = (page) =>
  page.evaluate(() => JSON.parse(document.getElementById('posted').textContent || '[]'));
const clearPosted = (page) =>
  page.evaluate(() => document.dispatchEvent(new CustomEvent('__clearPosted')));

const chips = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.ovealign-read')].map((c) => ({
    name: c.querySelector('.ovealign-readname').textContent,
    stat: (c.querySelector('.ovealign-readstat') || {}).textContent || null,
    error: (c.querySelector('.ovealign-readerr') || {}).textContent || null
  })));

/** Synthesise a drop carrying either files or a uri-list. */
const drop = (page, kind, payload) => page.evaluate(({ kind, payload }) => {
  const dt = new DataTransfer();
  if (kind === 'files') {
    for (const f of payload) {
      dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], f, { type: 'application/octet-stream' }));
    }
  } else {
    dt.setData('text/uri-list', payload.join('\n'));
  }
  const zone = document.querySelector('.ovealign-drop');
  zone.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
  zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, { kind, payload });

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.setViewportSize({ width: 1400, height: 950 });
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30000 });
  await page.waitForSelector('.ovealign-drop', { timeout: 10000 });

  /* --- MAFFT missing: say so before any work is done ---------------------- */

  // The harness starts with MAFFT missing, which is what a new user sees.
  out.banner = await page.evaluate(() => {
    const b = document.querySelector('.ovealign-banner');
    if (!b) return null;
    return {
      title: (b.querySelector('.ovealign-bannertitle') || {}).textContent || '',
      commands: [...b.querySelectorAll('.ovealign-cmds code')].map((c) => c.textContent),
      buttons: [...b.querySelectorAll('button')].map((x) => x.textContent)
    };
  });
  if (!out.banner) fail.push('MAFFT was missing but the panel said nothing');
  else {
    if (!out.banner.commands.some((c) => /brew install mafft/.test(c))) {
      fail.push('the banner does not show an install command');
    }
    if (!out.banner.buttons.some((b) => /Locate/.test(b))) fail.push('no Locate MAFFT button');
    if (!out.banner.buttons.some((b) => /Re-check/.test(b))) fail.push('no Re-check button');
  }

  // Align must be unavailable, or it just leads to a failure the banner explains.
  out.alignDisabledWithoutMafft =
    await page.locator('.ovealign-actions button', { hasText: 'Align' }).isDisabled();
  if (!out.alignDisabledWithoutMafft) fail.push('Align was clickable with MAFFT missing');

  await clearPosted(page);
  await page.locator('.ovealign-banner button', { hasText: 'Locate' }).click();
  await page.waitForTimeout(200);
  if (!(await posted(page)).some((m) => m.type === 'align/locateMafft')) {
    fail.push('Locate MAFFT did not reach the host');
  }

  // Once found, the banner goes and Align becomes available.
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__mafftFound')));
  await page.waitForTimeout(300);
  out.bannerAfterFound = await page.locator('.ovealign-banner').count();
  out.alignEnabledAfterFound =
    await page.locator('.ovealign-actions button', { hasText: 'Align' }).isEnabled();
  if (out.bannerAfterFound !== 0) fail.push('the banner stayed up after MAFFT was found');
  if (!out.alignEnabledAfterFound) fail.push('Align stayed disabled after MAFFT was found');

  /* --- the empty state is the picker -------------------------------------- */

  out.initialChips = await chips(page);
  out.hasBrowse = await page.locator('.ovealign-drop button', { hasText: 'Browse' }).count() > 0;
  if (!out.hasBrowse) fail.push('no Browse button — the guaranteed input route is missing');

  out.emptyText = await page.locator('.ovealign-empty').first().textContent().catch(() => null);
  if (!out.emptyText) fail.push('no empty-state guidance before aligning');

  out.referenceLine = await page.locator('.ovealign-refrow').textContent();
  if (!/demo-reference/.test(out.referenceLine)) fail.push('reference not shown');

  /* --- Browse posts to the host ------------------------------------------- */

  await clearPosted(page);
  await page.locator('.ovealign-drop button', { hasText: 'Browse' }).click();
  await page.waitForTimeout(200);
  out.browsePosted = (await posted(page)).map((m) => m.type);
  if (!out.browsePosted.includes('align/browse')) fail.push('Browse did not reach the host');

  /* --- drops: Explorer uri-list, then Finder files ------------------------- */

  await clearPosted(page);
  await drop(page, 'uris', ['file:///demo/from-explorer.ab1']);
  await page.waitForTimeout(300);
  out.uriDropPosted = await posted(page);
  if (!out.uriDropPosted.some((m) => m.type === 'align/addUris')) {
    fail.push('an Explorer-style uri-list drop was not handled');
  }
  out.afterUriDrop = await chips(page);
  if (!out.afterUriDrop.some((c) => c.name === 'from-explorer.ab1')) {
    fail.push('the uri-list drop did not add a read');
  }

  await clearPosted(page);
  await drop(page, 'files', ['from-finder.ab1']);
  await page.waitForTimeout(400);
  out.fileDropPosted = await posted(page);
  const bytesMsg = out.fileDropPosted.find((m) => m.type === 'align/addBytes');
  if (!bytesMsg) fail.push('a Finder-style file drop was not handled');
  else if (!bytesMsg.files[0].base64) fail.push('file bytes were not sent as base64');

  /* --- an unsupported file is rejected, not silently swallowed ------------- */

  await clearPosted(page);
  await drop(page, 'files', ['notes.txt']);
  await page.waitForTimeout(300);
  out.rejectedPosted = (await posted(page)).map((m) => m.type);
  out.rejectionStatus = await page.locator('.ovealign-status').first().textContent().catch(() => null);
  if (out.rejectedPosted.includes('align/addBytes')) fail.push('an unsupported file was sent to the host');
  if (!/Ignored/i.test(out.rejectionStatus || '')) fail.push('rejecting a file said nothing to the user');

  /* --- duplicates are not added twice ------------------------------------- */

  const before = (await chips(page)).length;
  await drop(page, 'uris', ['file:///demo/from-explorer.ab1']);
  await page.waitForTimeout(300);
  out.duplicateAdded = (await chips(page)).length - before;
  if (out.duplicateAdded !== 0) fail.push('dropping the same file twice added it twice');

  /* --- align, and check what actually rendered ---------------------------- */

  await page.locator('.ovealign-actions button', { hasText: 'Align' }).click();
  await page.waitForTimeout(2500);

  out.afterAlign = await chips(page);
  const clean = out.afterAlign.find((c) => c.name === 'clean-read.ab1');
  const gb = out.afterAlign.find((c) => c.name === 'gb-read.gb');
  if (!/no mismatches/.test(clean && clean.stat || '')) fail.push('a clean read did not report zero mismatches');
  if (!/3 mismatches/.test(gb && gb.stat || '')) fail.push('the deleted read did not report its mismatches');

  out.rendered = await page.evaluate(() => ({
    rowItems: document.querySelectorAll('.veRowItem').length,
    canvases: document.querySelectorAll('#view canvas').length,
    names: [...document.querySelectorAll('#view [class*=Name], #view .alignmentTrackName')]
      .map((e) => e.textContent.trim()).filter(Boolean).slice(0, 8),
    text: (document.getElementById('view').innerText || '').slice(0, 240)
  }));

  // One track per sequence: the reference plus two reads.
  if (out.rendered.rowItems < 3) fail.push(`expected 3 tracks, saw ${out.rendered.rowItems}`);
  // Exactly one read has trace data; the GenBank one must render without.
  if (out.rendered.canvases !== 1) {
    fail.push(`expected exactly 1 chromatogram canvas, saw ${out.rendered.canvases}`);
  }
  if (!/demo feature/.test(out.rendered.text)) {
    fail.push('the reference annotations are not drawn along the top');
  }

  /* --- removing a read invalidates the alignment --------------------------- */

  await page.locator('.ovealign-read .ovealign-x').first().click();
  await page.waitForTimeout(600);
  out.afterRemove = {
    chips: (await chips(page)).length,
    stillShowingAlignment: await page.locator('#view .veRowItem').count()
  };
  if (out.afterRemove.stillShowingAlignment > 0) {
    fail.push('removing a read left the stale alignment on screen');
  }

  out.failures = fail;
  out.ok = fail.length === 0;
  return out;
}
