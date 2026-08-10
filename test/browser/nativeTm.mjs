const bar = (page) => page.evaluate(() => {
  const tm = document.querySelector('[data-test="veStatusBar-selection-tm"]');
  return {
    items: [...document.querySelectorAll('.veStatusBarItem')].map(n => n.textContent.trim()).filter(Boolean),
    tmPresent: Boolean(tm),
    tmText: tm ? tm.textContent.trim() : null,
    ours: document.querySelector('.ove-seltm') ? 'STILL THERE' : 'removed',
    storedFlag: localStorage.getItem('showMeltingTemp')
  };
});
const select = async (page, s, e) => {
  await page.evaluate(([a, b]) =>
    document.dispatchEvent(new CustomEvent('__select', { detail: { start: a, end: b } })), [s, e]);
  await page.waitForTimeout(700);
};

export default async function run(page) {
  const out = {}; const fail = [];
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30000 });
  await page.waitForSelector('.veStatusBarItem', { timeout: 20000 });
  await page.waitForTimeout(900);

  out.initial = await bar(page);
  if (out.initial.ours !== 'removed') fail.push('our own readout should be gone');
  if (out.initial.storedFlag !== 'true') fail.push(`showMeltingTemp not seeded: ${out.initial.storedFlag}`);
  if (!out.initial.tmPresent) fail.push('OVE melting temp item is not showing by default');

  await select(page, 100, 121);          // 22 bp -> our value is 64.5
  out.short = await bar(page);
  if (!/64\.5/.test(out.short.tmText)) {
    fail.push(`native item should show our 64.5 (not OVE's 64.6), got: ${out.short.tmText}`);
  }
  // GC only renders once something is selected, so check it here not at rest.
  if (!/45\.5% GC/.test(out.short.items.join(' '))) {
    fail.push(`GC not on by default: ${out.short.items.join(' | ')}`);
  }

  await select(page, 0, 100);            // 101 bp -> over the limit
  out.over = await bar(page);
  if (!/>100 bp/.test(out.over.tmText)) fail.push(`101 bp should decline: ${out.over.tmText}`);

  await select(page, 400, 424);
  out.again = await bar(page);
  out.FAILURES = fail; out.PASS = fail.length === 0;
  return out;
}
