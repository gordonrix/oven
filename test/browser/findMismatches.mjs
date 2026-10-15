/*
 * Find, with mismatches, and DNA/AA in one click.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/EditorDemo.html --script test/browser/findMismatches.mjs
 *
 * The guard for bundle patch 3h. OVE's Find is a regex: exact, or with IUPAC
 * codes, never "give or take two". The patch adds a mismatches box to the find
 * bar and a scan that honours it, and puts DNA/AA on two always-visible
 * buttons instead of a dropdown in the wrench menu.
 *
 * The hit counts are checked against a brute-force count over the demo's own
 * sequence -- both strands, across the origin -- rather than a number written
 * down, so the test says what is right, not what happened once.
 */

const COMPLEMENT = { A: 'T', T: 'A', G: 'C', C: 'G' };
const revComp = (s) => [...s].reverse().map((c) => COMPLEMENT[c] || 'N').join('');

/** Hits with at most `k` substitutions, both strands, the sequence circular. */
function bruteForce(sequence, query, k) {
  const seq = sequence.toUpperCase();
  const n = seq.length;
  const found = new Set();
  for (const [strand, q] of [['+', query], ['-', revComp(query)]]) {
    for (let i = 0; i < n; i++) {
      let misses = 0;
      for (let j = 0; j < q.length && misses <= k; j++) if (seq[(i + j) % n] !== q[j]) misses++;
      if (misses <= k) found.add(`${strand}${i}`);
    }
  }
  return found.size;
}

const total = (page) => page.evaluate(() => {
  const bar = document.querySelector('.veFindBar');
  const m = bar && /(\d+)\s*\/\s*(\d+)/.exec(bar.textContent);
  return m ? Number(m[2]) : null;
});

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForSelector('.veRowView', { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__publish')));
  const sequence = await page.evaluate(() => JSON.parse(document.getElementById('editorState').textContent).sequence);

  await page.locator('.veRowView').first().click({ position: { x: 200, y: 40 } });
  await page.keyboard.press('Meta+f');
  await page.waitForSelector('.tg-find-tool-input', { timeout: 5000 });

  /* --- a protein: amino-acid search with mismatches --------------------- */

  if (new URL(page.url()).searchParams.has('protein')) {
    const residues = await page.evaluate(() =>
      JSON.parse(document.getElementById('editorState').textContent).proteinSequence);
    const peptide = residues.slice(10, 22);
    const changed = peptide.slice(0, 5) + (peptide[5] === 'W' ? 'Y' : 'W') + peptide.slice(6);
    /** Residue hits with at most `k` substitutions: proteins have one strand and two ends. */
    const count = (q, k) => {
      let hits = 0;
      for (let i = 0; i + q.length <= residues.length; i++) {
        let m = 0;
        for (let j = 0; j < q.length && m <= k; j++) if (residues[i + j] !== q[j]) m++;
        if (m <= k) hits++;
      }
      return hits;
    };
    out.proteinMode = await page.evaluate(() =>
      (document.querySelector('.oven-find-mode.bp3-active') || {}).textContent || null);
    if (out.proteinMode !== 'AA') await page.locator('.oven-find-mode', { hasText: 'AA' }).click();
    await page.locator('.tg-find-tool-input input').first().fill(changed);
    out.proteinHits = {};
    for (const k of [0, 1]) {
      await page.locator('[data-test="ovenFindMismatches"]').fill(String(k));
      await page.waitForTimeout(500);
      const shown = await total(page);
      const expected = count(changed, k);
      out.proteinHits[k] = { shown, expected };
      if (shown !== expected) fail.push(`protein, ${k} mismatches: bar shows ${shown}, brute force finds ${expected}`);
    }
    if (out.proteinHits[1].expected < 1) fail.push('the changed peptide should be found with one mismatch');
    out.failures = fail;
    out.ok = fail.length === 0;
    return out;
  }

  /* --- the controls are there without opening a menu -------------------- */

  out.modeButtons = await page.locator('.oven-find-mode').allTextContents();
  if (JSON.stringify(out.modeButtons) !== JSON.stringify(['DNA', 'AA'])) {
    fail.push(`expected DNA and AA buttons on the bar, got ${JSON.stringify(out.modeButtons)}`);
  }
  out.mismatchBox = await page.locator('[data-test="ovenFindMismatches"]').count();
  if (out.mismatchBox !== 1) fail.push('no mismatches box on the find bar');
  out.mismatchDefault = await page.locator('[data-test="ovenFindMismatches"]').inputValue();
  if (out.mismatchDefault !== '0') fail.push(`mismatches should start at 0, got ${out.mismatchDefault}`);

  /* --- mismatches -------------------------------------------------------- */

  // A stretch of the sequence with two bases changed: no exact hit there.
  const at = 37;
  const exact = sequence.slice(at, at + 20).toUpperCase();
  const flip = (c) => (c === 'A' ? 'C' : 'A');
  const query = exact.slice(0, 6) + flip(exact[6]) + exact.slice(7, 14) + flip(exact[14]) + exact.slice(15);
  await page.locator('.tg-find-tool-input input').first().fill(query);
  await page.waitForTimeout(500);

  out.hits = {};
  for (const k of [0, 1, 2, 3]) {
    await page.locator('[data-test="ovenFindMismatches"]').fill(String(k));
    await page.waitForTimeout(500);
    const shown = await total(page);
    const expected = bruteForce(sequence, query, k);
    out.hits[k] = { shown, expected };
    if (shown !== expected) fail.push(`with ${k} mismatches the bar shows ${shown}, brute force finds ${expected}`);
  }
  if (out.hits[0].expected !== 0 || out.hits[2].expected < 1) {
    fail.push('the query should miss exactly and hit with two mismatches -- the fixture is wrong');
  }

  // Typing into the box is not taken for editor hotkeys or a new search.
  out.queryStillThere = await page.locator('.tg-find-tool-input input').first().inputValue();
  if (out.queryStillThere !== query) fail.push('typing in the mismatches box changed the search text');

  /* --- DNA / AA, one click each ---------------------------------------- */

  const mode = () => page.evaluate(() => {
    const active = document.querySelector('.oven-find-mode.bp3-active');
    return active ? active.textContent : null;
  });
  out.modeBefore = await mode();
  await page.locator('.oven-find-mode', { hasText: 'AA' }).click();
  await page.waitForTimeout(300);
  out.modeAfterOneClick = await mode();
  if (out.modeAfterOneClick !== 'AA') fail.push(`one click on AA should switch to AA, got ${out.modeAfterOneClick}`);
  await page.locator('.oven-find-mode', { hasText: 'DNA' }).click();
  await page.waitForTimeout(300);
  out.modeBack = await mode();
  if (out.modeBack !== 'DNA') fail.push(`one click on DNA should switch back, got ${out.modeBack}`);

  // And the dropdown is gone from the wrench menu, rather than duplicated.
  await page.locator('[data-test="veFindBarOptionsToggle"]').click();
  await page.waitForTimeout(300);
  out.dropdownInMenu = await page.evaluate(() =>
    Boolean(document.querySelector('.ve-find-options-popover select[name="dnaOrAA"]')));
  if (out.dropdownInMenu) fail.push('the DNA/AA dropdown is still in the wrench menu');
  await page.keyboard.press('Escape');

  out.failures = fail;
  out.ok = fail.length === 0;
  return out;
}
