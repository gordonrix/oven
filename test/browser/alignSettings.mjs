/*
 * The alignment settings form.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/AlignDemo.html --script test/browser/alignSettings.mjs
 *
 * The host stub in AlignDemo saves what the real host would save and refuses
 * what it would refuse, so this covers the client: what the form offers, what
 * it sends, and -- the part that is easy to get wrong -- that an edit survives
 * the panel being redrawn under it, and survives being refused.
 */

const posted = (page) =>
  page.evaluate(() => JSON.parse(document.getElementById('posted').textContent || '[]'));

export default async function run(page) {
  const out = {};
  const fail = [];
  const protein = new URL(page.url()).searchParams.has('protein');

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForSelector('.ovealign-actions', { timeout: 30000 });

  const box = () => page.locator('.ovealign-settings');
  out.closedAtFirst = (await box().count()) === 0;
  if (!out.closedAtFirst) fail.push('the settings form should start folded away');

  await page.locator('.ovealign-actions button', { hasText: 'Settings' }).click();
  await page.waitForSelector('.ovealign-settings', { timeout: 3000 });

  out.strategies = await page.evaluate(() =>
    [...document.querySelectorAll('.ovealign-strategy option')].map((o) => o.textContent));
  for (const s of ['Auto', 'Accurate (L-INS-i)', 'Fast (FFT-NS-1)', 'Custom…']) {
    if (!out.strategies.includes(s)) fail.push(`no ${s} strategy: ${JSON.stringify(out.strategies)}`);
  }
  out.fields = await page.evaluate(() =>
    [...document.querySelectorAll('.ovealign-field > span')].map((n) => n.textContent));
  const hasTrim = out.fields.some((f) => /Trim/.test(f));
  if (protein && hasTrim) fail.push('a protein alignment offers trace trimming');
  if (!protein && !hasTrim) fail.push('no trace-trimming field');
  out.placeholders = await page.evaluate(() =>
    [...document.querySelectorAll('.ovealign-settings input[type=number]')].map((i) => i.placeholder));
  if (out.placeholders[0] !== '1.53') fail.push(`gap opening should show MAFFT's default: ${out.placeholders}`);

  // Custom reveals its own box.
  await page.selectOption('.ovealign-strategy', 'custom');
  out.customBox = await page.locator('.ovealign-customargs').count();
  if (out.customBox !== 1) fail.push('Custom did not offer a box for MAFFT arguments');
  await page.locator('.ovealign-customargs').fill('--globalpair --maxiterate 100');

  // Typed values survive the strip being redrawn by an unrelated update.
  const gapOpen = page.locator('.ovealign-settings input[type=number]').first();
  await gapOpen.fill('2.5');
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__mafftFound')));
  await page.waitForTimeout(300);
  out.afterRedraw = await page.locator('.ovealign-settings input[type=number]').first().inputValue();
  if (out.afterRedraw !== '2.5') fail.push(`an edit was wiped by a redraw: ${out.afterRedraw}`);
  out.customAfterRedraw = await page.locator('.ovealign-customargs').inputValue();
  if (out.customAfterRedraw !== '--globalpair --maxiterate 100') fail.push('the custom arguments were wiped');

  // A refused value stays in the box to be corrected.
  await page.locator('.ovealign-settings input[type=number]').first().fill('-1');
  await page.locator('.ovealign-settings button', { hasText: 'Save settings' }).click();
  await page.waitForTimeout(300);
  out.refusedStatus = await page.evaluate(() =>
    (document.querySelector('.ovealign-status.is-error') || {}).textContent || '');
  out.afterRefusal = await page.locator('.ovealign-settings input[type=number]').first().inputValue();
  if (!/0 or more/.test(out.refusedStatus)) fail.push(`a negative penalty was not refused: ${out.refusedStatus}`);
  if (out.afterRefusal !== '-1') fail.push(`a refused value was snapped back: ${out.afterRefusal}`);

  // A good one is sent as choices, and the form then shows what was saved.
  await page.locator('.ovealign-settings input[type=number]').first().fill('3');
  await page.locator('.ovealign-settings button', { hasText: 'Save settings' }).click();
  await page.waitForTimeout(300);
  const sent = (await posted(page)).filter((m) => m.type === 'align/updateSettings').pop();
  out.sent = sent && sent.settings;
  if (!out.sent) fail.push('Save settings did not reach the host');
  else {
    if (out.sent.strategy !== 'custom') fail.push(`strategy sent as ${out.sent.strategy}`);
    if (out.sent.custom !== '--globalpair --maxiterate 100') fail.push(`custom sent as ${out.sent.custom}`);
    if (String(out.sent.gapOpen) !== '3') fail.push(`gap opening sent as ${out.sent.gapOpen}`);
  }
  out.afterSave = await page.locator('.ovealign-settings input[type=number]').first().inputValue();
  if (out.afterSave !== '3') fail.push(`after saving the form shows ${out.afterSave}`);
  out.savedStatus = await page.evaluate(() =>
    (document.querySelector('.ovealign-status') || {}).textContent || '');
  if (!/saved/i.test(out.savedStatus)) fail.push(`no word that it saved: ${out.savedStatus}`);

  // Folds away again.
  await page.locator('.ovealign-actions button', { hasText: 'Hide settings' }).click();
  out.foldsAway = (await box().count()) === 0;
  if (!out.foldsAway) fail.push('Hide settings did not fold the form away');

  out.failures = fail;
  out.ok = fail.length === 0;
  return out;
}
