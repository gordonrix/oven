/*
 * Which map a sequence opens on.
 *
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/EditorDemo.html --script test/browser/linearMap.mjs
 *   node <browser-automation>/browser.mjs \
 *     "http://127.0.0.1:8742/media/EditorDemo.html?linear" --script test/browser/linearMap.mjs
 *
 * Open Vector Editor has a Linear Map -- the whole sequence on one rail, the
 * linear equivalent of the Circular Map -- and OVEN never offered it, so a
 * linear .gb opened as a circle with a gap in it. OVE warns about exactly that
 * on the circular tab, which meant meeting the warning on every linear file.
 *
 * Both maps are offered either way; only which one is showing changes. ?linear
 * makes the demo's sequence linear, and ?map brings a map tab up rather than
 * the sequence -- the other suites on this page work on the sequence letters
 * and have to keep landing on them.
 */

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.setViewportSize({ width: 1300, height: 900 });
  await page.waitForSelector('.veVectorInteractionWrapper', { timeout: 60000 });
  await page.waitForTimeout(2500);

  out.linearFile = await page.evaluate(() => location.search.includes('linear'));
  out.state = await page.evaluate(() => ({
    hasCircularTab: Boolean(document.querySelector('.veTabCircularMap')),
    hasLinearTab: Boolean(document.querySelector('.veTabLinearMap')),
    activeTab: (document.querySelector('.veTabActive') || {}).textContent || null,
    circularDrawn: Boolean(document.querySelector('[class*=CircularView]'))
  }));
  /*
   * A linear sequence gets no Circular Map tab at all. OVE only draws it there
   * to warn you off it, so the tab exists solely to be a wrong turn. A circular
   * sequence keeps both -- a linear map of a plasmid is a reasonable want.
   */
  if (!out.state.hasLinearTab) fail.push('no Linear Map tab');
  if (out.linearFile && out.state.hasCircularTab) {
    fail.push('a linear sequence still offers a Circular Map tab');
  }
  if (!out.linearFile && !out.state.hasCircularTab) {
    fail.push('a circular sequence lost its Circular Map tab');
  }

  const want = out.linearFile ? 'Linear Map' : 'Circular Map';
  if (out.state.activeTab !== want) {
    fail.push(`a ${out.linearFile ? 'linear' : 'circular'} sequence opened on `
      + `${JSON.stringify(out.state.activeTab)}, expected ${want}`);
  }

  /*
   * And the circular drawing is the thing to check, not just the tab: a linear
   * sequence rendered there comes out as a circle with a gap in it, which is
   * what OVE itself warns about on that tab.
   */
  if (out.linearFile && out.state.circularDrawn) {
    fail.push('a linear sequence is being drawn as a circle');
  }
  if (!out.linearFile && !out.state.circularDrawn) {
    fail.push('a circular sequence is not being drawn as a circle');
  }

  out.FAILURES = fail;
  out.PASS = fail.length === 0;
  return out;
}
