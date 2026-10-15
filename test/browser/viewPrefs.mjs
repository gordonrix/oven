/*
 * View settings remembered from one file to the next.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/EditorDemo.html --script test/browser/viewPrefs.mjs
 *
 * OVE keeps View menu choices only for the editor they were made in, so Amino
 * Acid Numbers was off again in every file opened. media/viewPrefs.js reports
 * a change to the host, which applies it to the next file
 * (test/unit/editorHtml.test.js covers that half). This drives the real View
 * menu and checks what is reported.
 */

const posted = (page) =>
  page.evaluate(() => JSON.parse(document.getElementById('posted').textContent || '[]'));

async function toggleAminoAcidNumbers(page) {
  await page.locator('.tg-menu-bar button', { hasText: 'View' }).first().click();
  await page.waitForTimeout(350);
  const item = page.locator('.bp3-menu-item', { hasText: 'Amino Acid Numbers' }).first();
  if (!(await item.count())) return false;
  await item.click();
  await page.waitForTimeout(350);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  return true;
}

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForSelector('.tg-menu-bar', { timeout: 30000 });
  await page.waitForTimeout(1200);

  out.reportedOnOpen = (await posted(page)).filter((m) => m.type === 'viewprefs/save').length;
  if (out.reportedOnOpen) fail.push('opening a file reported a view setting nobody changed');

  out.foundItem = await toggleAminoAcidNumbers(page);
  if (!out.foundItem) fail.push('no Amino Acid Numbers item in the View menu');
  let saves = (await posted(page)).filter((m) => m.type === 'viewprefs/save');
  out.afterOn = saves.length ? saves[saves.length - 1].prefs : null;
  if (!out.afterOn || out.afterOn.aminoAcidNumbers !== true) {
    fail.push(`turning numbering on should be remembered as on: ${JSON.stringify(out.afterOn)}`);
  }

  await toggleAminoAcidNumbers(page);
  saves = (await posted(page)).filter((m) => m.type === 'viewprefs/save');
  out.afterOff = saves.length ? saves[saves.length - 1].prefs : null;
  if (!out.afterOff || out.afterOff.aminoAcidNumbers !== false) {
    fail.push(`turning it off again should be remembered too: ${JSON.stringify(out.afterOff)}`);
  }

  /** Click one View menu item by its text. */
  const viewItem = async (text) => {
    await page.locator('.tg-menu-bar button', { hasText: 'View' }).first().click();
    await page.waitForTimeout(350);
    const item = page.locator('.bp3-menu-item').filter({ hasText: new RegExp(`^${text}`) }).first();
    const found = await item.count();
    if (found) await item.click();
    await page.waitForTimeout(350);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    return Boolean(found);
  };

  // ORFs is a remembered drawing setting.
  out.foundOrfs = await viewItem('ORFs');
  saves = (await posted(page)).filter((m) => m.type === 'viewprefs/save');
  out.afterOrfs = saves.length ? saves[saves.length - 1].prefs : null;
  if (!out.foundOrfs) fail.push('no ORFs item in the View menu');
  else if (!out.afterOrfs || out.afterOrfs.orfs !== true) fail.push(`ORFs should be remembered: ${JSON.stringify(out.afterOrfs)}`);

  // Primers is what is in the file: hiding it is not remembered.
  const before = saves.length;
  out.foundPrimers = await viewItem('Primers');
  out.contentSettingReported = (await posted(page)).filter((m) => m.type === 'viewprefs/save').length - before;
  if (out.contentSettingReported) fail.push('hiding primers, which is per file, was reported to be remembered');

  out.failures = fail;
  out.ok = fail.length === 0;
  return out;
}
