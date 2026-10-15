/*
 * Pasting a table of sequences into the alignment panel.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/AlignDemo.html --script test/browser/pasteTable.mjs
 *
 * A block copied from a spreadsheet is tab-separated text, and a paste into
 * any cell of the table should spread it over the rows from there down. The
 * host stub refuses what is not letters, as the real one refuses what is not
 * DNA, so a refused row can be seen coming back with its reason.
 */

const posted = (page) =>
  page.evaluate(() => JSON.parse(document.getElementById('posted').textContent || '[]'));

/** A paste event carrying text, as a copy from Excel or Sheets delivers it. */
const pasteText = (page, selector, text) => page.evaluate(({ selector, text }) => {
  const input = document.querySelector(selector);
  input.focus();
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, { selector, text });

const rows = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.ovealign-pasterow')].map((r) => {
    const [name, seq] = r.querySelectorAll('input');
    return [name.value, seq.value];
  }));

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForSelector('.ovealign-pastetable', { timeout: 30000 });

  /* --- a spreadsheet block fills the table -------------------------------- */

  const TSV = 'Name\tSequence\nT7\tTAATACGACTCACTATAGGG\nSP6\tATTTAGGTGACACTATAGAA\nbad one\tACGT#ACGT';
  await pasteText(page, '.ovealign-pasterow input.ovealign-pastename', TSV);
  await page.waitForTimeout(300);
  out.afterPaste = await rows(page);
  const filled = out.afterPaste.filter(([n, q]) => n || q);
  if (filled.length !== 3) fail.push(`expected three rows (header dropped), got ${JSON.stringify(out.afterPaste)}`);
  if (JSON.stringify(filled[0]) !== JSON.stringify(['T7', 'TAATACGACTCACTATAGGG'])) {
    fail.push(`first row should be T7: ${JSON.stringify(filled[0])}`);
  }
  const last = out.afterPaste[out.afterPaste.length - 1];
  if (last[0] || last[1]) fail.push('there should be an empty row left at the bottom to type into');

  out.addLabel = await page.locator('.ovealign-pasteadd').textContent();
  if (out.addLabel !== 'Add 3') fail.push(`the Add button should count the rows: ${out.addLabel}`);

  /* --- adding them: good rows go in, the bad one stays with its reason ---- */

  await page.locator('.ovealign-pasteadd').click();
  await page.waitForTimeout(500);
  const sent = (await posted(page)).filter((m) => m.type === 'align/addSequences').pop();
  out.sentRows = sent ? sent.rows.length : 0;
  if (out.sentRows !== 3) fail.push(`expected three rows sent in one message, got ${out.sentRows}`);

  out.chips = await page.evaluate(() =>
    [...document.querySelectorAll('.ovealign-read .ovealign-readname')].map((n) => n.textContent));
  for (const name of ['T7', 'SP6']) {
    if (!out.chips.includes(name)) fail.push(`${name} was not added: ${JSON.stringify(out.chips)}`);
  }
  out.afterAdd = await rows(page);
  out.errorText = await page.evaluate(() =>
    (document.querySelector('.ovealign-pasteerr') || {}).textContent || '');
  if (JSON.stringify(out.afterAdd[0]) !== JSON.stringify(['bad one', 'ACGT#ACGT'])) {
    fail.push(`the refused row should stay in the table: ${JSON.stringify(out.afterAdd)}`);
  }
  if (!/not DNA/.test(out.errorText)) fail.push(`the refused row should say why: ${out.errorText}`);

  /* --- fixing it clears the error, and Enter adds ----------------------- */

  await page.locator('.ovealign-pasterow input.ovealign-pastebases').first().fill('ACGTTACGT');
  out.errorAfterEdit = await page.locator('.ovealign-pasterow.has-error').count();
  if (out.errorAfterEdit) fail.push('editing a refused row should clear its error mark');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  out.chipsAfterFix = await page.evaluate(() =>
    [...document.querySelectorAll('.ovealign-read .ovealign-readname')].map((n) => n.textContent));
  if (!out.chipsAfterFix.includes('bad one')) fail.push('the corrected row was not added');
  out.emptyAfterFix = await rows(page);
  if (out.emptyAfterFix.some(([n, q]) => n || q)) fail.push('the table should be empty once everything went in');

  /* --- typing still works one at a time, and grows the table ------------ */

  await page.locator('.ovealign-pasterow input.ovealign-pastebases').first().click();
  await page.keyboard.type('GGCC');
  await page.waitForTimeout(200);
  out.rowsWhileTyping = (await rows(page)).length;
  if (out.rowsWhileTyping !== 2) fail.push(`typing in the last row should add an empty one below: ${out.rowsWhileTyping}`);
  await page.keyboard.type('AATT');
  out.typedValue = (await rows(page))[0][1];
  if (out.typedValue !== 'GGCCAATT') fail.push(`typing should carry on in the same box after it grows: ${out.typedValue}`);

  /* --- one line is an ordinary paste ------------------------------------ */

  await pasteText(page, '.ovealign-pasterow:last-child input.ovealign-pastebases', 'ACGTACGT');
  out.rowsAfterOneLine = (await rows(page)).length;
  if (out.rowsAfterOneLine !== 2) fail.push('a one-line paste should not be split into rows');

  /* --- a single column fills only its own column ----------------------- */

  // Clear the table: remove every filled row.
  while (await page.locator('.ovealign-pasterow .ovealign-x').count()) {
    await page.locator('.ovealign-pasterow .ovealign-x').first().click();
    await page.waitForTimeout(100);
  }

  // Sequences first, as a column copied from a spreadsheet with its header.
  await pasteText(page, '.ovealign-pasterow input.ovealign-pastebases',
    'Sequence\nTAATACGACTCACTATAGGG\nATTTAGGTGACACTATAGAA\nGCTAGTTATTGCTCAGCGG');
  await page.waitForTimeout(300);
  out.afterSeqColumn = (await rows(page)).filter(([n, q]) => n || q);
  if (out.afterSeqColumn.length !== 3) fail.push(`a sequence column should fill three rows: ${JSON.stringify(out.afterSeqColumn)}`);
  if (out.afterSeqColumn.some(([n]) => n)) fail.push('a sequence column should leave the names empty');

  // Then the names, into the name column: the sequences stay.
  await pasteText(page, '.ovealign-pasterow input.ovealign-pastename', 'Name\nT7\nSP6\nT7 term');
  await page.waitForTimeout(300);
  out.afterNameColumn = (await rows(page)).filter(([n, q]) => n || q);
  const want = [['T7', 'TAATACGACTCACTATAGGG'], ['SP6', 'ATTTAGGTGACACTATAGAA'], ['T7 term', 'GCTAGTTATTGCTCAGCGG']];
  if (JSON.stringify(out.afterNameColumn) !== JSON.stringify(want)) {
    fail.push(`names then sequences should pair up: ${JSON.stringify(out.afterNameColumn)}`);
  }

  // Pasted from a row partway down, it fills from there.
  await pasteText(page, '.ovealign-pasterow:nth-child(2) input.ovealign-pastename', 'second\nthird');
  await page.waitForTimeout(300);
  out.fromRowTwo = (await rows(page)).map(([n]) => n).slice(0, 3);
  if (JSON.stringify(out.fromRowTwo) !== JSON.stringify(['T7', 'second', 'third'])) {
    fail.push(`a column pasted from row two should start there: ${JSON.stringify(out.fromRowTwo)}`);
  }

  // One sequence that spans lines is still one sequence.
  const wrapped = 'ACGT'.repeat(40);
  await pasteText(page, '.ovealign-pasterow:last-child input.ovealign-pastebases',
    `${wrapped.slice(0, 60)}\n${wrapped.slice(60, 120)}\n${wrapped.slice(120)}`);
  await page.waitForTimeout(300);
  out.wrappedRows = (await rows(page)).filter(([n, q]) => n || q).length;
  if (out.wrappedRows !== 4) fail.push(`a wrapped sequence should add one row, got ${out.wrappedRows - 3}`);

  /* --- Remove all clears the sequences in one go ----------------------- */

  out.chipsBeforeRemoveAll = await page.locator('.ovealign-read').count();
  await page.locator('.ovealign-removeall').click();
  await page.waitForTimeout(400);
  const asked = (await posted(page)).filter((m) => m.type === 'align/removeAll');
  if (!asked.length) fail.push('Remove all did not reach the host');
  out.chipsAfterRemoveAll = await page.locator('.ovealign-read').count();
  if (out.chipsBeforeRemoveAll < 2) fail.push('the test needs several sequences to remove');
  if (out.chipsAfterRemoveAll !== 0) fail.push(`${out.chipsAfterRemoveAll} sequences left after Remove all`);

  out.failures = fail;
  out.ok = fail.length === 0;
  return out;
}
