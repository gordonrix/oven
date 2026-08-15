/*
 * Drives media/EditorDemo.html to check Change Amino Acid end to end.
 *
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/EditorDemo.html --script test/browser/aminoAcid.mjs
 *
 * The codon arithmetic is unit-tested in test/unit/codonEdit.test.js; what only
 * a browser can answer is whether the menu entry appears on a translation,
 * whether the dialog reads the right residue, and whether choosing a codon
 * changes those three bases and nothing else.
 */

const published = (page) => page.evaluate(() => {
  document.dispatchEvent(new CustomEvent('__publish'));
  return JSON.parse(document.getElementById('editorState').textContent || '{}');
});

export default async function run(page) {
  const fail = [];
  const out = {};

  await page.waitForFunction(() => document.querySelector('.translationLayer'), { timeout: 60000 });
  await page.waitForTimeout(1800);
  const before = (await published(page)).sequence;

  /* --- the entry appears on a translation --------------------------------- */

  await page.locator('.translationLayer > g').nth(2).click({ button: 'right', force: true });
  await page.waitForTimeout(500);
  out.menu = await page.evaluate(() => [...document.querySelectorAll('[class*=menu-item]')]
    .map((e) => e.textContent.trim()).filter(Boolean));
  if (!out.menu.some((t) => /Change Amino Acid/.test(t))) {
    fail.push('no Change Amino Acid entry on a translation right-click');
  }
  await page.keyboard.press('Escape');

  /* --- the dialog describes the residue that was clicked ------------------- */

  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent('__openAA', { detail: { index: 2 } })));
  await page.waitForTimeout(500);

  out.dialog = await page.evaluate(() => {
    const p = document.querySelector('.oveaa-panel');
    if (!p) return null;
    const codon = (c) => c.querySelector('.oveaa-codon').textContent;
    const cells = [...p.querySelectorAll('.oveaa-cell')];
    const rows = [...p.querySelectorAll('.oveaa-coderow')];
    return {
      current: p.querySelector('.oveaa-current').textContent,
      organisms: [...p.querySelectorAll('.oveaa-select option')].map((o) => o.value),
      cells: cells.length,
      codons: cells.map(codon),
      rowCount: rows.length,
      // The first body row fixes the whole arrangement: second base across.
      firstRow: [...rows[0].querySelectorAll('.oveaa-cell')].map(codon),
      // And the left column fixes the blocks: first base down.
      firstDown: rows.map((r) => codon(r.querySelector('.oveaa-cell'))),
      axes: {
        first: [...p.querySelectorAll('.oveaa-first')].map((e) => e.textContent),
        second: [...p.querySelectorAll('.oveaa-base')].map((e) => e.textContent),
        third: [...rows[0].parentNode.querySelectorAll('.oveaa-third')].map((e) => e.textContent)
      },
      highlighted: cells.filter((c) => c.classList.contains('is-current')).map(codon),
      atg: cells.filter((c) => codon(c) === 'ATG')
        .map((c) => [...c.querySelectorAll('span')].map((x) => x.textContent))[0],
      stops: cells.filter((c) => ['TAA', 'TAG', 'TGA'].includes(codon(c)))
        .map((c) => c.querySelectorAll('span')[1].textContent),
      link: (p.querySelector('.oveaa-link') || {}).textContent,
      notation: [...p.querySelectorAll('.oveaa-radio')].map((l) => l.textContent.trim())
    };
  });

  if (!out.dialog) {
    fail.push('the dialog did not open');
    return { ...out, failures: fail, ok: false };
  }
  const d = out.dialog;

  // The whole genetic code, not the residue's synonyms: changing which amino
  // acid is encoded is the common case and is unreachable from a synonym list.
  if (d.cells !== 64) fail.push(`${d.cells} codons shown, expected all 64`);
  if (new Set(d.codons).size !== 64) fail.push('a codon is repeated or missing');
  if (d.rowCount !== 16) fail.push(`${d.rowCount} rows, expected 16`);

  // Arranged as a genetic-code table is printed: first base down the side,
  // second across the top, third within the block -- so an amino acid's codons
  // are the block they sit in, and T/C/A/G rather than alphabetical.
  if (d.firstRow.join(',') !== 'TTT,TCT,TAT,TGT') {
    fail.push(`the top row is ${d.firstRow.join(',')}, expected TTT,TCT,TAT,TGT`);
  }
  if (d.firstDown.join(',') !== 'TTT,TTC,TTA,TTG,CTT,CTC,CTA,CTG,ATT,ATC,ATA,ATG,GTT,GTC,GTA,GTG') {
    fail.push(`the left column reads ${d.firstDown.join(',')}`);
  }
  if (d.axes.first.join('') !== 'TCAG') fail.push(`first-letter axis is ${d.axes.first.join('')}`);
  if (d.axes.second.join('') !== 'TCAG') fail.push(`second-letter axis is ${d.axes.second.join('')}`);
  if (d.axes.third.join('') !== 'TCAGTCAGTCAGTCAG') {
    fail.push(`third-letter axis is ${d.axes.third.join('')}`);
  }

  // Every codon keeps its own label, rather than one spanning a block.
  const labels = d.stops.length;
  if (labels !== 3) fail.push(`${labels} stop codons labelled, expected all 3 to carry their own`);
  if (d.stops.some((x) => x !== '*')) fail.push(`stops show as ${d.stops.join(',')}, expected *`);

  if (!/Alanine/.test(d.current)) fail.push(`the residue reads "${d.current}", expected alanine`);
  if (d.highlighted.join(',') !== 'GCG') {
    fail.push(`highlighted ${d.highlighted.join(',') || 'nothing'}, expected exactly GCG`);
  }
  if (d.organisms.length !== 4) fail.push(`${d.organisms.length} organisms, expected 4`);
  if (d.notation.join('/') !== 'Three-letter/Single-letter') {
    fail.push(`notation options are ${d.notation.join('/')}`);
  }
  // Trailing zeros dropped, as the published tables print them.
  if (d.atg && d.atg[2] !== '1') fail.push(`ATG fraction shows as ${d.atg[2]}, expected 1`);
  if (!/showcodon\.cgi\?species=\d+/.test(d.link)) {
    fail.push(`the source link is "${d.link}", expected a species-specific Kazusa url`);
  }

  /* --- choosing one rewrites exactly those three bases --------------------- */

  // A different amino acid entirely, which the old synonyms-only list could
  // not reach: TTA is leucine where GCG is alanine.
  const pick = 'TTA';
  await page.locator('.oveaa-cell').filter({ hasText: pick }).first().click();
  await page.waitForTimeout(700);

  const after = (await published(page)).sequence;
  out.edit = { pick, before: before.slice(15, 24), after: after.slice(15, 24) };

  if (after.length !== before.length) {
    fail.push(`the sequence changed length: ${before.length} -> ${after.length}`);
  }
  if (after.slice(18, 21).toUpperCase() !== pick) {
    fail.push(`bases 18-20 are ${after.slice(18, 21)}, expected ${pick}`);
  }
  // Written in the opposite case, so an edit can be found by eye afterwards.
  if (after.slice(18, 21) !== pick.toLowerCase()) {
    fail.push(`the edit is ${after.slice(18, 21)}, expected lower case`);
  }
  if (after.slice(0, 18) !== before.slice(0, 18) || after.slice(21) !== before.slice(21)) {
    fail.push('something outside the codon changed');
  }
  out.dialogClosed = await page.evaluate(() => !document.querySelector('.oveaa-panel'));
  if (!out.dialogClosed) fail.push('the dialog stayed open after choosing a codon');

  /* --- and it can be undone ------------------------------------------------ */

  /*
   * The edit goes through OVE's own updateSequenceData rather than
   * updateEditor. updateEditor replaces the editor's state wholesale -- it is
   * how a file is loaded -- so an edit made that way sits outside the undo
   * stack, and cmd+Z did nothing to it.
   */
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(700);
  out.undone = (await published(page)).sequence;
  if (out.undone !== before) fail.push('undo did not put the codon back');

  await page.keyboard.press('Meta+Shift+z');
  await page.waitForTimeout(700);
  out.redone = (await published(page)).sequence;
  if (out.redone !== after) fail.push('redo did not re-apply the codon');

  return { ...out, failures: fail, ok: fail.length === 0 };
}
