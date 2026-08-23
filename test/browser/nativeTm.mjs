/*
 * The status bar's selection stats, against a real OVE editor.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/SearchDemo.html --script test/browser/nativeTm.mjs
 *
 * Since 1.18.0 the Tm shown here is OVE's own, so this no longer pins a number
 * of ours -- it checks the two things that are actually ours to get wrong:
 *
 *   1. that our old override is gone, and
 *   2. that `oven.showSelectionStatsByDefault` turns both items on.
 *
 * The second is not free. "Percent GC Content of Selection" has a
 * showGCContentByDefault prop, but "Melting Temp of Selection" has none: OVE
 * reads it from localStorage in useMeltingTemp (index.umd.js:149800), so the
 * key has to be seeded. That seeding went out with our Tm code, and the
 * setting quietly did half of what it promised until this caught it.
 */
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

  await select(page, 100, 121);
  out.short = await bar(page);
  // A believable Tm rather than an exact one: the value is OVE's to define now,
  // and pinning their number would only break when they improve it. What is
  // ours to keep working is that a selection produces one at all.
  const degrees = /(\d+(?:\.\d+)?)/.exec(out.short.tmText || '');
  out.shortTmValue = degrees ? Number(degrees[1]) : null;
  if (out.shortTmValue === null) {
    fail.push(`no temperature for a 22 bp selection: ${out.short.tmText}`);
  } else if (out.shortTmValue < 40 || out.shortTmValue > 90) {
    fail.push(`22 bp Tm outside a believable range: ${out.shortTmValue}`);
  }
  // GC only renders once something is selected, so check it here not at rest.
  if (!/45\.5% GC/.test(out.short.items.join(' '))) {
    fail.push(`GC not on by default: ${out.short.items.join(' | ')}`);
  }

  await select(page, 400, 424);
  out.again = await bar(page);
  if (!out.again.tmPresent) fail.push('the Tm item vanished on a second selection');

  /* --- the length guard ---------------------------------------------------- */

  /*
   * Our own guard, patched into MeltingTemp. OVE computes a two-state Tm for
   * any selection at all: -294.7 for one base, 102.4 for 6 kb, and 0 with
   * nothing selected. This is the check that those never reach the status bar
   * again -- it went missing once already, when selectionTm.js was deleted.
   */
  const tmAt = async (len) => {
    await select(page, 100, 100 + len - 1);
    return (await bar(page)).tmText;
  };

  out.guard = {};
  for (const len of [1, 5, 8, 20, 100, 101, 2000]) out.guard[len] = await tmAt(len);

  for (const len of [1, 5, 101, 2000]) {
    if (!/\u2014/.test(out.guard[len] || '')) {
      fail.push(`${len} bp should show a dash, got ${out.guard[len]}`);
    }
  }
  // The bounds themselves are inclusive, and a real primer still gets a number.
  for (const len of [8, 20, 100]) {
    if (!/\d/.test(out.guard[len] || '') || /\u2014/.test(out.guard[len] || '')) {
      fail.push(`${len} bp is in range and should show a number, got ${out.guard[len]}`);
    }
  }
  // No selection is its own case: stock renders `Number(tm) || 0`, so the bug
  // this replaced showed a confident "Melting Temp: 0".
  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent('__select', { detail: { start: 0, end: -1 } })));
  await page.waitForTimeout(500);
  out.guardNoSelection = (await bar(page)).tmText;
  if (/Melting Temp: 0\b/.test(out.guardNoSelection || '')) {
    fail.push(`an empty selection must not read as 0: ${out.guardNoSelection}`);
  }

  out.FAILURES = fail; out.PASS = fail.length === 0;
  return out;
}
