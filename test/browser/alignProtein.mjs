/*
 * A protein alignment, against the real OVE bundle.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/AlignDemo.html?protein --script test/browser/alignProtein.mjs
 *
 * OVE's alignment view has no protein mode, so OVEN hands proteins over as
 * plain letters with ovenUnit "aa" (src/alignPanel.js, toProteinPayload). This
 * checks that what that produces is a protein alignment and not a DNA one with
 * odd letters in it: residues drawn and numbered, lengths in aa, verdicts that
 * say how identical rather than just "mismatch", and none of the DNA-only
 * layers -- even when the eye menu has them saved on from a DNA alignment.
 *
 * Also the guard for bundle patch 3f: unpatched, every track label says "bps".
 */

/* OVE's nucleotide colours (dnaToColor), which must never appear behind residues. */
const DNA_FILLS = ['lightgreen', '#658fff', 'yellow', '#EE6262'];

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForSelector('.ovealign-drop', { timeout: 30000 });

  /*
   * The eye menu saves its toggles to localStorage, and OVE reads them when the
   * bundle loads. Seeding DNA Colors and Reverse Sequence on -- what someone who
   * had used them on a DNA alignment would have -- and reloading puts the
   * protein alignment up against exactly that.
   */
  await page.evaluate(() => {
    localStorage.setItem('alignmentAnnotationVisibility',
      JSON.stringify({ dnaColors: true, reverseSequence: true }));
  });
  await page.reload();
  await page.waitForSelector('.ovealign-drop', { timeout: 30000 });

  /* --- before aligning ------------------------------------------------------ */

  out.refMeta = await page.evaluate(() =>
    (document.querySelector('.ovealign-refmeta') || {}).textContent || '');
  if (!/^\d+ aa$/.test(out.refMeta)) fail.push(`reference meta should be "N aa": ${JSON.stringify(out.refMeta)}`);

  out.placeholder = await page.evaluate(() =>
    (document.querySelector('.ovealign-pastebases') || {}).placeholder || '');
  if (!/protein/.test(out.placeholder)) fail.push(`paste box does not ask for a protein: ${out.placeholder}`);

  out.lengthsBefore = await page.evaluate(() =>
    [...document.querySelectorAll('.ovealign-read:not(.is-error) .ovealign-readstat')].map((n) => n.textContent));
  if (!out.lengthsBefore.length || !out.lengthsBefore.every((t) => / aa$/.test(t))) {
    fail.push(`unaligned chips should be in aa: ${JSON.stringify(out.lengthsBefore)}`);
  }

  /* --- aligned --------------------------------------------------------------- */

  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__mafftFound')));
  await page.waitForTimeout(300);
  await page.locator('.ovealign-actions button', { hasText: 'Align' }).click();
  await page.waitForSelector('.alignmentHolder', { timeout: 20000 });
  await page.waitForTimeout(1500);

  // Patch 3f: the length under each track name is in residues.
  out.labels = await page.evaluate(() =>
    [...document.querySelectorAll('.alignmentTrackNameDiv')].map((n) => n.parentElement.textContent.trim()));
  if (!out.labels.length) fail.push('no track labels found');
  if (out.labels.some((l) => /bps/.test(l))) fail.push('a protein track is labelled in bps');
  if (!out.labels.every((l) => /\d+ aa$/.test(l))) {
    fail.push(`every track should end in "N aa": ${JSON.stringify(out.labels)}`);
  }

  // The residues a DNA parse used to delete are on screen.
  out.letters = await page.evaluate(() =>
    (document.querySelector('.ve-row-item-sequence text') || {}).textContent || '');
  for (const r of 'EFILPQW') {
    if (!out.letters.includes(r)) fail.push(`residue ${r} is not drawn`);
  }

  // None of the DNA-only layers, saved setting or not.
  out.dnaFills = await page.evaluate((fills) =>
    [...document.querySelectorAll('.alignmentHolder path')]
      .filter((p) => fills.includes(p.getAttribute('fill'))).length, DNA_FILLS);
  if (out.dnaFills) fail.push(`${out.dnaFills} nucleotide colour boxes behind the residues`);
  out.reverseRows = await page.evaluate(() =>
    document.querySelectorAll('.alignmentHolder [class*="reverse" i]').length);
  if (out.reverseRows) fail.push(`${out.reverseRows} reverse-strand elements on a protein`);

  // Mismatches are still highlighted, residue by residue.
  out.highlights = await page.evaluate(() =>
    document.querySelectorAll('.alignmentHolder .veSelectionLayer, .alignmentHolder [class*="ighlight"]').length);

  /* --- verdicts ------------------------------------------------------------- */

  out.chips = await page.evaluate(() => [...document.querySelectorAll('.ovealign-read')].map((c) => ({
    name: c.querySelector('.ovealign-readname').textContent,
    stat: (c.querySelector('.ovealign-readstat') || {}).textContent || null,
    error: (c.querySelector('.ovealign-readerr') || {}).textContent || null,
    tip: (c.querySelector('.ovealign-readstat') || {}).title || ''
  })));
  const chip = (name) => out.chips.find((c) => c.name.startsWith(name)) || {};
  if (chip('clean-protein').stat !== 'match') fail.push(`identical protein: ${chip('clean-protein').stat}`);
  if (chip('window-protein').stat !== 'partial match') fail.push(`70-residue window: ${chip('window-protein').stat}`);
  if (chip('substituted-protein').stat !== '98.9% identical') {
    fail.push(`two substitutions should read 98.9% identical: ${chip('substituted-protein').stat}`);
  }
  if (chip('deleted-protein').stat !== '98.3% identical') {
    fail.push(`three deleted residues should read 98.3% identical: ${chip('deleted-protein').stat}`);
  }
  if (!/DNA — this reference is a protein/.test(chip('clone-read').error || '')) {
    fail.push(`the DNA read should be refused: ${JSON.stringify(chip('clone-read'))}`);
  }
  const tip = chip('substituted-protein').tip;
  if (!/ aa \(/.test(tip)) fail.push(`tooltip coverage should be in aa: ${JSON.stringify(tip)}`);
  if (/strand|rotated|anchor/.test(tip)) fail.push(`tooltip carries DNA-only lines: ${JSON.stringify(tip)}`);

  /* --- trace controls ------------------------------------------------------- */

  out.traceControls = await page.evaluate(() => {
    const bar = document.querySelector('.ovealign-topctl');
    return bar ? { off: bar.classList.contains('is-off'),
      why: (bar.querySelector('[title]') || {}).title || '' } : null;
  });
  if (!out.traceControls || !out.traceControls.off) fail.push('trace controls are live on a protein');
  else if (!/Protein alignment/.test(out.traceControls.why)) {
    fail.push(`trace controls do not say why: ${out.traceControls.why}`);
  }

  out.failures = fail;
  out.ok = fail.length === 0;
  return out;
}
