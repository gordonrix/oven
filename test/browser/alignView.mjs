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
  [...document.querySelectorAll('.ovealign-read')].map((c) => {
    const s = c.querySelector('.ovealign-readstat');
    return {
      name: c.querySelector('.ovealign-readname').textContent,
      stat: s ? s.textContent : null,
      // The colour carries as much meaning as the word, so check both.
      colour: s ? getComputedStyle(s).color : null,
      error: (c.querySelector('.ovealign-readerr') || {}).textContent || null
    };
  }));

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

/*
 * Paste is the route that survives the workbench's drop overlay -- copy files
 * in Finder, click the panel, Cmd+V -- so it is worth pinning.
 */
const paste = (page, names) => page.evaluate((names) => {
  const dt = new DataTransfer();
  for (const n of names) {
    dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], n, { type: 'application/octet-stream' }));
  }
  document.body.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, names);

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

  /* --- paste: the route the workbench cannot intercept -------------------- */

  await clearPosted(page);
  await paste(page, ['pasted-read.ab1']);
  await page.waitForTimeout(400);
  out.pastePosted = await posted(page);
  const pasteMsg = out.pastePosted.find((m) => m.type === 'align/addBytes');
  if (!pasteMsg) fail.push('a pasted file was not handled');
  else if (pasteMsg.files[0].name !== 'pasted-read.ab1') {
    fail.push('the pasted file arrived under the wrong name');
  }

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

  /*
   * Three verdicts, not a count: match / partial match / mismatch. A read that
   * never anchored is a different sequence, not a near miss, and must not be
   * shown in the same colour as one that differs by three bases.
   */
  out.afterAlign = await chips(page);
  const want = [
    // perfect and spans the whole reference
    ['clean-read.ab1', 'match', 'rgb(15, 153, 96)'],           // green
    // perfect, but only over its own window -- all a Sanger read can be
    ['window-read.ab1', 'partial match', 'rgb(191, 115, 38)'], // gold
    // three bases missing: a real difference, whatever the coverage
    ['gb-read.gb', 'mismatch', 'rgb(194, 48, 48)'],            // red
    ['wrong-plasmid.ab1', 'mismatch', 'rgb(194, 48, 48)']      // red
  ];
  for (const [name, label, colour] of want) {
    const c = out.afterAlign.find((x) => x.name === name);
    if (!c) { fail.push(`no chip for ${name}`); continue; }
    if (c.stat !== label) fail.push(`${name} says "${c.stat}", want "${label}"`);
    if (c.colour !== colour) fail.push(`${name} is ${c.colour}, want ${colour}`);
  }
  if (out.afterAlign.some((c) => /\d+\s*mismatch/.test(c.stat || ''))) {
    fail.push('a raw mismatch count is still being shown');
  }
  // Coverage is the distinction the labels turn on, so it has to be readable.
  out.coverageTooltip = await page.evaluate(() => {
    const c = [...document.querySelectorAll('.ovealign-read')]
      .find((x) => x.querySelector('.ovealign-readname').textContent === 'window-read.ab1');
    return c ? c.querySelector('.ovealign-readstat').title : null;
  });
  if (!/covers \d+ of \d+ bp/.test(out.coverageTooltip || '')) {
    fail.push('the tooltip does not say how much of the reference was covered');
  }

  /* --- the picker folds away once there is something to look at ----------- */

  out.afterAlignPicker = await page.evaluate(() => ({
    dropZones: document.querySelectorAll('.ovealign-drop').length,
    toggle: (document.querySelector('.ovealign-addtoggle') || {}).textContent || null
  }));
  if (out.afterAlignPicker.dropZones !== 0) {
    fail.push('the drop box is still taking space after aligning');
  }
  if (!/Add sequences/.test(out.afterAlignPicker.toggle || '')) {
    fail.push('no Add sequences button after aligning');
  }

  await page.locator('.ovealign-addtoggle').click();
  await page.waitForTimeout(200);
  out.toggledOpen = await page.locator('.ovealign-drop').count();
  await page.locator('.ovealign-addtoggle').click();
  await page.waitForTimeout(200);
  out.toggledShut = await page.locator('.ovealign-drop').count();
  if (out.toggledOpen !== 1 || out.toggledShut !== 0) {
    fail.push(`Add sequences did not toggle the box (open=${out.toggledOpen}, shut=${out.toggledShut})`);
  }

  /* --- OVE's alignment-type label must not show a guess -------------------- */

  out.alignmentTypeVisible = await page.evaluate(() => {
    const e = document.querySelector('.veAlignmentType');
    return e ? getComputedStyle(e).display !== 'none' : false;
  });
  if (out.alignmentTypeVisible) fail.push('the alignment-type label is still visible');
  if (/Sanger sequencing/.test(await page.locator('body').innerText())) {
    fail.push('"Sanger sequencing" is still on screen');
  }

  /* --- the view fills the panel ------------------------------------------- */

  out.fill = await page.evaluate(() => {
    const view = document.querySelector('.ovealign-view');
    const av = document.querySelector('.alignmentView');
    const pin = document.querySelector('.alignmentTrackFixedToTop');
    return {
      body: Math.round(document.body.getBoundingClientRect().height),
      view: Math.round(view.getBoundingClientRect().height),
      alignment: av ? Math.round(av.getBoundingClientRect().height) : 0,
      pin: pin ? Math.round(pin.getBoundingClientRect().height) : 0
    };
  });
  // The alignment should take what is left of the window, not a fixed strip.
  if (out.fill.view < out.fill.body * 0.5) {
    fail.push(`the alignment view is only ${out.fill.view}px of ${out.fill.body}px`);
  }
  if (!out.fill.pin) fail.push('the pinned reference did not render');
  if (Math.abs(out.fill.alignment - out.fill.view) > 4) {
    fail.push(`OVE rendered ${out.fill.alignment}px inside a ${out.fill.view}px host`);
  }

  out.rendered = await page.evaluate(() => ({
    rowItems: document.querySelectorAll('.veRowItem').length,
    canvases: document.querySelectorAll('#view canvas').length,
    names: [...document.querySelectorAll('#view [class*=Name], #view .alignmentTrackName')]
      .map((e) => e.textContent.trim()).filter(Boolean).slice(0, 8),
    // Query the annotation itself rather than substring-matching the panel's
    // text, which moves as soon as the reference gets longer.
    featureLabels: [...document.querySelectorAll('#view svg text')]
      .map((e) => e.textContent.trim()).filter((t) => t === 'demo feature').length,
    text: (document.getElementById('view').innerText || '').slice(0, 240)
  }));

  // One track per sequence: the reference plus two reads.
  if (out.rendered.rowItems < 4) fail.push(`expected 4 tracks, saw ${out.rendered.rowItems}`);
  // Two reads carry trace data; the GenBank one must render without, which is
  // the case that has to keep working for non-trace formats.
  if (out.rendered.canvases !== 2) {
    fail.push(`expected exactly 2 chromatogram canvases, saw ${out.rendered.canvases}`);
  }
  if (!out.rendered.featureLabels) {
    fail.push('the reference annotations are not drawn along the top');
  }

  /* --- a mutated codon shows its amino acid on the read ------------------- */

  out.readTranslations = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#view .veRowItem')];
    return rows.map((r) => [...r.querySelectorAll('svg text')]
      .map((t) => t.textContent.trim()).filter((t) => /^[A-Z*]$/.test(t)).join(''));
  });
  // Row 0 is the reference, which carries the CDS translation; a read shows an
  // amino acid only where a substitution changed a codon.
  if (!out.readTranslations[0]) fail.push('the reference lost its translation track');
  if (!out.readTranslations.slice(1).some(Boolean)) {
    fail.push('no read shows an amino acid for its mutated codon');
  }

  /* --- one trace-height control, driving every chromatogram ---------------- */

  out.traceControl = await page.evaluate(() => {
    const ctl = document.querySelector('.ovealign-topctl');
    return {
      // The controls belong in OVE's own top bar, beside the eye -- not
      // stranded above the view in our chrome.
      inTopBar: Boolean(ctl && ctl.closest('.ve-alignment-top-bar')),
      groups: ctl ? ctl.querySelectorAll('.ovealign-ctlgroup').length : 0,
      heightSlider: Boolean(ctl && ctl.querySelector('.ovealign-ctlslider')),
      amplitudeButtons: ctl ? ctl.querySelectorAll('.ovealign-ctlbtn').length : 0,
      icons: ctl ? ctl.querySelectorAll('svg.ovealign-ctlicon').length : 0,
      // Upstream puts a pair inside each chromatogram at a sticky offset.
      perTrackVisible: [...document.querySelectorAll(
        '#view .scaleChromatogramButtonUp, #view .scaleChromatogramButtonDown')]
        .filter((b) => b.offsetParent !== null).length,
      canvasHeights: [...document.querySelectorAll('#view canvas')].map((c) => c.height)
    };
  });
  if (!out.traceControl.inTopBar) fail.push('the chromatogram controls are not in OVE\'s top bar');
  if (out.traceControl.groups !== 2) fail.push('expected a window-height and an amplitude group');
  if (!out.traceControl.heightSlider) fail.push('no window-height slider');
  if (out.traceControl.amplitudeButtons < 3) fail.push('amplitude control is missing buttons');
  if (out.traceControl.icons < 3) fail.push('the controls have no icons to say what they do');
  if (out.traceControl.perTrackVisible) {
    fail.push(`${out.traceControl.perTrackVisible} per-track scale button(s) still visible`);
  }

  /* --- window height drives every canvas ----------------------------------- */

  const canvasHeights = () => page.evaluate(() =>
    [...document.querySelectorAll('#view canvas')].map((c) => c.height));
  out.heightBefore = await canvasHeights();
  await page.evaluate(() => {
    const s = document.querySelector('.ovealign-ctlslider');
    s.value = '140';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(600);
  out.heightAfter = await canvasHeights();
  if (!out.heightAfter.length || out.heightAfter.some((h) => h !== 140)) {
    fail.push(`the height slider did not resize every canvas: ${out.heightAfter.join()}`);
  }

  /* --- the reference stays put while the reads scroll ---------------------- */

  out.frozenReference = await page.evaluate(async () => {
    // Two holders once the reference is pinned: OVE renders the template into
    // its own, and keeps its scrollLeft in step with the main one.
    const holders = [...document.querySelectorAll('.alignmentHolder')];
    const pinned = document.querySelector('.alignmentTrackFixedToTop .alignmentHolder');
    const main = holders.find((h) => h !== pinned);
    const top = (sel) => {
      const e = document.querySelector(sel);
      return e ? Math.round(e.getBoundingClientRect().top) : null;
    };
    const before = {
      pin: top('.alignmentTrackFixedToTop .veRowItem'),
      read: top('.alignmentHolder:not(.alignmentTrackFixedToTop .alignmentHolder) .veRowItem')
    };

    main.scrollTop = 150;
    main.scrollLeft = 400;
    main.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 300));

    return {
      holders: holders.length,
      // Exactly one track pinned, and the scroller must not draw it again --
      // OVE offsets the virtualised indices by one to make sure of that.
      pinTracks: document.querySelectorAll('.alignmentTrackFixedToTop .veRowItem').length,
      pinName: (document.querySelector('.alignmentTrackFixedToTop .alignmentTrackName') || {}).textContent,
      pinShadow: getComputedStyle(
        document.querySelector('.alignmentTrackFixedToTop .alignmentViewTrackContainer')).boxShadow,
      before,
      after: {
        pin: top('.alignmentTrackFixedToTop .veRowItem'),
        read: top('.alignmentHolder:not(.alignmentTrackFixedToTop .alignmentHolder) .veRowItem')
      },
      scrolled: main.scrollTop > 0,
      pinnedLeft: pinned.scrollLeft,
      mainLeft: main.scrollLeft
    };
  });
  const fr = out.frozenReference;
  if (fr.holders !== 2) fail.push(`expected a pinned holder and a main one, saw ${fr.holders}`);
  // OVE marks its template track in red, which is the mismatch colour used
  // everywhere else here -- on the one track that cannot mismatch.
  if (/rgb\(255, *0, *0\)/.test(fr.pinShadow)) {
    fail.push(`the pinned reference is still ruled in red (${fr.pinShadow})`);
  }
  if (fr.pinTracks !== 1) fail.push(`the pinned row holds ${fr.pinTracks} tracks, want 1`);
  if (fr.scrolled) {
    if (fr.before.pin !== fr.after.pin) fail.push('the pinned reference scrolled away');
    if (fr.before.read === fr.after.read) {
      fail.push('the reads did not scroll, so the pin proves nothing');
    }
  }
  // Vertically frozen but horizontally in step -- otherwise the pinned bases sit
  // above the wrong columns, which is worse than not pinning at all.
  if (fr.pinnedLeft !== fr.mainLeft) {
    fail.push(`the pinned reference is at column ${fr.pinnedLeft}, the reads at ${fr.mainLeft}`);
  }

  /* --- one selection, shared with the pinned reference --------------------- */

  /*
   * The reason the reference is pinned by OVE rather than by a second view of
   * our own: a second view carries its own redux store, so it had its own
   * selection and highlighting in one did nothing to the other.
   */
  out.sharedSelection = await page.evaluate(async () => {
    const row = document.querySelector(
      '.alignmentHolder:not(.alignmentTrackFixedToTop .alignmentHolder) .veRowItem');
    const r = row.getBoundingClientRect();
    const fire = (type, x) => row.dispatchEvent(
      new MouseEvent(type, { clientX: x, clientY: r.top + 8, bubbles: true, buttons: 1 }));
    fire('mousedown', r.left + 60);
    fire('mousemove', r.left + 300);
    fire('mouseup', r.left + 300);
    await new Promise((res) => setTimeout(res, 400));

    const wide = (root) => [...root.querySelectorAll('.veSelectionLayer')]
      .some((e) => e.getBoundingClientRect().width > 4);
    return {
      onPinned: wide(document.querySelector('.alignmentTrackFixedToTop')),
      anywhere: wide(document)
    };
  });
  if (out.sharedSelection.anywhere && !out.sharedSelection.onPinned) {
    fail.push('a selection in the reads does not show on the pinned reference');
  }

  /* --- the chromatogram rows carry no dead space --------------------------- */

  out.chromRow = await page.evaluate(() => {
    const cv = document.querySelector('.alignmentHolder canvas');
    if (!cv) return null;
    const chrom = cv.closest('.chromatogram');
    return {
      row: Math.round(chrom.getBoundingClientRect().height),
      trace: Math.round(chrom.querySelector('.chromatogram-trace').getBoundingClientRect().height),
      brs: [...chrom.children].filter((e) => e.tagName === 'BR' &&
        e.getBoundingClientRect().height > 0).length
    };
  });
  if (out.chromRow) {
    // OVE leaves a <br> above each trace to clear scale buttons we hide; the
    // line box it leaves was 19px of white per read.
    if (out.chromRow.brs) fail.push(`${out.chromRow.brs} <br> still takes space above the trace`);
    if (out.chromRow.row - out.chromRow.trace > 4) {
      fail.push(`the chromatogram row is ${out.chromRow.row}px around a ${out.chromRow.trace}px trace`);
    }
  }

  /* --- shift+wheel scrolls sideways, not down ------------------------------ */

  out.shiftScroll = await page.evaluate(async () => {
    const h = document.querySelector(
      '.alignmentHolder:not(.alignmentTrackFixedToTop .alignmentHolder)');
    // Back to the left edge first: the frozen-reference check above leaves this
    // scrolled, and possibly already at its maximum, where a wheel event has
    // nowhere to move it and this would fail for the wrong reason.
    h.scrollLeft = 0;
    await new Promise((r) => setTimeout(r, 150));
    const at = () => ({ left: h.scrollLeft, top: h.scrollTop });
    const before = at();
    (h.querySelector('.veRowItem') || h).dispatchEvent(
      new WheelEvent('wheel', { deltaY: 240, shiftKey: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 250));
    return { before, after: at() };
  });
  if (!(out.shiftScroll.after.left > out.shiftScroll.before.left)) {
    fail.push('shift+wheel did not scroll the alignment sideways');
  }
  if (out.shiftScroll.after.top !== out.shiftScroll.before.top) {
    fail.push('shift+wheel scrolled vertically as well');
  }

  /* --- the sequence list collapses, and starts open ------------------------ */

  out.readList = await page.evaluate(() => ({
    label: (document.querySelector('.ovealign-readstoggle') || {}).textContent || null,
    chips: document.querySelectorAll('.ovealign-read').length
  }));
  if (!out.readList.chips) fail.push('the sequence list did not start open');
  await page.locator('.ovealign-readstoggle').click();
  await page.waitForTimeout(250);
  out.readListCollapsed = await page.evaluate(() =>
    document.querySelectorAll('.ovealign-read').length);
  if (out.readListCollapsed !== 0) fail.push('the sequence list did not collapse');
  await page.locator('.ovealign-readstoggle').click();
  await page.waitForTimeout(250);

  /* --- the summary strip is grey, with red meaning one thing --------------- */

  out.minimap = await page.evaluate(() => {
    const yellowish = (c) => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || '');
      if (!m) return false;
      const [r, g, b] = [+m[1], +m[2], +m[3]];
      return r > 150 && g > 150 && b < 120;
    };
    const mm = document.querySelector('.alignmentMinimap');
    if (!mm) return null;
    // Upstream washes the viewport in translucent yellow and rules it with
    // 2px yellow borders, which turns a red mismatch orange.
    const stillYellow = [...mm.querySelectorAll('*')].filter((e) => {
      const cs = getComputedStyle(e);
      return yellowish(cs.backgroundColor) ||
        (cs.borderTopWidth !== '0px' && yellowish(cs.borderTopColor)) ||
        (cs.borderBottomWidth !== '0px' && yellowish(cs.borderBottomColor)) ||
        yellowish(cs.fill);
    }).length;
    // Every lane has a red path; only lanes with a difference have any data in
    // it, so take the first non-empty one.
    const red = [...mm.querySelectorAll('.miniRedPath')].find((p) => p.getAttribute('d'));
    const redStyle = red ? getComputedStyle(red) : null;
    return {
      tracksBackground: getComputedStyle(mm.querySelector('.alignmentMinimapTracks')).backgroundColor,
      sequence: getComputedStyle(mm.querySelector('.miniBluePath')).fill,
      mismatch: redStyle && redStyle.fill,
      // A single-base difference is a fraction of a pixel wide, so the mark is
      // widened in the path geometry. Measuring the first subpath is the only
      // way to see that -- and it must NOT be stroked, which would grow it
      // vertically past its lane and leave the ends ragged.
      mismatchWidth: (() => {
        const d = red && red.getAttribute('d');
        const m = d && /^M([\d.-]+),[\d.-]+ L([\d.-]+),/.exec(d);
        return m ? Number(m[2]) - Number(m[1]) : 0;
      })(),
      mismatchStroke: redStyle && redStyle.stroke,
      stillYellow
    };
  });

  const rgb = (c) => (/rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || '') || []).slice(1).map(Number);
  // Neutral means no hue: the strip should carry no colour except the red.
  const neutral = (c) => {
    const [r, g, b] = rgb(c);
    return r !== undefined && Math.max(r, g, b) - Math.min(r, g, b) <= 12;
  };
  const lightness = (c) => { const [r, g, b] = rgb(c); return (r + g + b) / 3; };

  if (!out.minimap) fail.push('no summary strip rendered');
  else {
    if (out.minimap.stillYellow) {
      fail.push(`${out.minimap.stillYellow} element(s) still tint the strip yellow`);
    }
    if (!neutral(out.minimap.sequence)) {
      fail.push(`sequences are ${out.minimap.sequence}, which is not a neutral grey`);
    }
    if (!neutral(out.minimap.tracksBackground)) {
      fail.push(`the strip ground is ${out.minimap.tracksBackground}, which is not a neutral grey`);
    }
    // The bars have to read against the ground, and the ground has to be the
    // lighter of the two so an uncovered region recedes.
    const gap = lightness(out.minimap.tracksBackground) - lightness(out.minimap.sequence);
    if (!(gap > 20)) {
      fail.push(`sequence and ground are too close in tone (${gap.toFixed(0)})`);
    }
    if (out.minimap.mismatch !== 'rgb(255, 0, 0)') {
      fail.push(`mismatches are ${out.minimap.mismatch}, want true red`);
    }
    if (!(out.minimap.mismatchWidth >= 3)) {
      fail.push(`the mismatch mark is only ${out.minimap.mismatchWidth}px wide`);
    }
    if (out.minimap.mismatchStroke && out.minimap.mismatchStroke !== 'none') {
      fail.push(`the mismatch mark is stroked (${out.minimap.mismatchStroke}), which makes it ragged`);
    }
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
