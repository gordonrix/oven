/*
 * Drives media/EditorDemo.html to check that a Filter Cut Sites change is
 * noticed and posted to the host, and that nothing is posted when it has not
 * changed.
 *
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/EditorDemo.html --script test/browser/cutSites.mjs
 *
 * The editor handle exposes no store to subscribe to, so the client reads the
 * state shortly after any interaction. Both halves of that are worth pinning:
 * that a real change gets through, and that idle clicking does not write.
 */

const posted = (page) => page.evaluate(() =>
  JSON.parse(document.getElementById('posted').textContent || '[]'));

const setFilter = (page, filter) => page.evaluate((f) =>
  document.dispatchEvent(new CustomEvent('__updateEditor', {
    detail: { restrictionEnzymes: f }
  })), filter);

const FILTER = {
  isEnzymeFilterAnd: true,
  filteredRestrictionEnzymes: [{ value: 'ecori', label: 'EcoRI' }]
};

export default async function run(page) {
  const fail = [];
  const out = {};

  await page.waitForFunction(() => document.querySelector('.tg-menu-bar'), { timeout: 60000 });
  await page.waitForTimeout(1200);

  /* --- clicking without changing anything must not write ------------------- */

  await page.locator('.tg-menu-bar button').first().click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  out.afterIdleClick = (await posted(page)).filter((m) => m.type === 'cutsites/save').length;
  if (out.afterIdleClick) {
    fail.push(`${out.afterIdleClick} save(s) posted without the filter changing`);
  }

  /* --- a real change is posted once ---------------------------------------- */

  await setFilter(page, FILTER);
  // The client reads state after an interaction, so there has to be one.
  await page.locator('.tg-menu-bar button').first().click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);

  const saves = (await posted(page)).filter((m) => m.type === 'cutsites/save');
  out.saves = saves.length;
  out.filter = saves.length ? saves[saves.length - 1].filter : null;

  if (!saves.length) {
    fail.push('changing the filter posted nothing');
  } else {
    const f = out.filter;
    if (f.isEnzymeFilterAnd !== true) fail.push('the and/or flag was not carried');
    if (!(f.filteredRestrictionEnzymes || []).some((e) => e.value === 'ecori')) {
      fail.push('the chosen enzyme was not carried');
    }
  }

  /* --- and not posted again while it stays put ----------------------------- */

  await page.locator('.tg-menu-bar button').first().click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  out.savesAfter = (await posted(page)).filter((m) => m.type === 'cutsites/save').length;
  if (out.savesAfter > out.saves) {
    fail.push(`the same filter was written again (${out.saves} -> ${out.savesAfter})`);
  }

  return { ...out, failures: fail, ok: fail.length === 0 };
}
