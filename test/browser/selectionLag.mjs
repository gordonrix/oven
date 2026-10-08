/*
 * Selecting with a long search open must not recut every restriction site.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/EditorDemo.html --script test/browser/selectionLag.mjs
 *
 * The guard for bundle patch 3g. An 18 kb plasmid, split as OVEN opens one --
 * sequence beside the circular map -- with a 2 kb stretch of itself in Find.
 * Unpatched, two kinds of component took turns evicting each other from the
 * one-entry cut-site cache, and every mouse move during a drag recut the whole
 * plasmid: a 40-step drag spent about 11 s in long tasks. Patched it spends
 * none. The threshold sits far from both, so a slow machine cannot fail it and
 * the regression cannot pass it.
 *
 * Synthetic sequence, like every sequence in this repo.
 */

/** Deterministic DNA, mulberry32, as the other fixtures make it. */
function makeSeq(len, seed) {
  let a = seed >>> 0;
  let out = '';
  for (let i = 0; i < len; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out += 'ACGT'[((t ^ (t >>> 14)) >>> 0) % 4];
  }
  return out;
}

const SEQ = makeSeq(18000, 20261005);
const QUERY = SEQ.slice(6000, 8000);
const LIMIT_MS = 2500;

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForSelector('.veRowView', { timeout: 30000 });
  await page.evaluate((seq) => document.dispatchEvent(new CustomEvent('__updateEditor', {
    detail: {
      sequenceData: { name: 'synthetic-18kb', circular: true, sequence: seq },
      panelsShown: [
        [{ id: 'sequence', name: 'Sequence Map', active: true }],
        [{ id: 'circular', name: 'Circular Map', active: true }]
      ]
    }
  })), SEQ);
  await page.waitForTimeout(1500);

  await page.addScriptTag({ content: `
    window.__long = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); })
      .observe({ entryTypes: ['longtask'] });
    document.addEventListener('__readLong', () => {
      document.body.dataset.long = JSON.stringify(window.__long); window.__long = [];
    });` });
  const readLong = async () => {
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('__readLong')));
    const l = await page.evaluate(() => JSON.parse(document.body.dataset.long || '[]'));
    return { count: l.length, totalMs: Math.round(l.reduce((a, b) => a + b, 0)) };
  };

  const row = page.locator('.veRowView').first();
  const box = await row.boundingBox();
  await row.click({ position: { x: 300, y: 60 } });
  await page.keyboard.press('Meta+f');
  await page.waitForSelector('.tg-find-tool-input', { timeout: 5000 });
  await page.locator('.tg-find-tool-input input, textarea.tg-find-tool-input').first().fill(QUERY);
  await page.waitForTimeout(2000);
  out.searchLayers = await page.evaluate(() => document.querySelectorAll('.veSearchLayer').length);
  if (!out.searchLayers) fail.push('the 2 kb search found nothing, so this tested nothing');

  // Somewhere else, leaving Find open, then a drag.
  await page.mouse.click(box.x + 200, box.y + 300);
  await page.waitForTimeout(500);
  await readLong();
  await page.mouse.move(box.x + 120, box.y + 120);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) await page.mouse.move(box.x + 120 + i * 20, box.y + 120 + i * 8);
  await page.mouse.up();
  await page.waitForTimeout(500);
  out.duringDrag = await readLong();
  if (out.duringDrag.totalMs > LIMIT_MS) {
    fail.push(`dragging a selection spent ${out.duringDrag.totalMs} ms in ${out.duringDrag.count} ` +
      'long tasks -- cut sites are being recut on every selection change');
  }

  // And the cut sites themselves are still there to be drawn.
  out.cutsiteLabels = await page.evaluate(() =>
    document.querySelectorAll('.veCutsiteLabel, .cutsiteLabelSelectionLayer, [class*="utsite"]').length);
  if (!out.cutsiteLabels) fail.push('no cut sites drawn at all');

  out.failures = fail;
  out.ok = fail.length === 0;
  return out;
}
