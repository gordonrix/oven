/*
 * A chromatogram on a read whose span is wider than one canvas can be.
 *
 *   node <browser-automation>/browser.mjs \
 *     "http://127.0.0.1:8742/media/AlignDemo.html?wide" --script test/browser/wideTrace.mjs
 *
 * A canvas dimension cannot exceed 65,535px, and past it a canvas draws nothing
 * at all -- no error, no warning, just an empty track. The chromatogram was one
 * canvas as wide as the read's column span, and a span is not a base count: a
 * read crossing the origin has its two ends at opposite ends of the reference,
 * so on a 10 kb plasmid it asked for ~124,000px and drew nothing. Found on four
 * real 5 kb reads, where the read that did not cross the origin spanned 62,028px
 * and drew fine -- 3,500px under the limit.
 *
 * ?wide makes the demo reference 6,000 bp, which puts the origin-crossing read
 * at ~71,600px: over the limit, and under it again once sliced.
 */

const LIMIT = 65535;

/**
 * Did anything actually get drawn on this canvas?
 *
 * The whole width, in strips -- a 32,768px canvas is too big to read in one go,
 * and sampling only the left of it misses a read whose bases sit at the far
 * edge, which is exactly the case here.
 */
const paintedIn = (canvas) => {
  try {
    const ctx = canvas.getContext('2d');
    for (let x = 0; x < canvas.width; x += 4096) {
      const w = Math.min(4096, canvas.width - x);
      const data = ctx.getImageData(x, 0, w, canvas.height).data;
      for (let i = 3; i < data.length; i += 4) if (data[i]) return true;
    }
    return false;
  } catch (e) {
    return `error: ${e.message}`;
  }
};

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30000 });
  await page.waitForSelector('.ovealign-drop', { timeout: 10000 });
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__mafftFound')));
  await page.waitForTimeout(300);
  await page.locator('.ovealign-drop button', { hasText: 'Browse' }).click();
  await page.waitForTimeout(400);
  await page.locator('.ovealign-actions button', { hasText: 'Align' }).click();
  await page.waitForTimeout(4000);

  out.traces = await page.evaluate((painted) => {
    const check = new Function('canvas', `return (${painted})(canvas)`);
    return [...document.querySelectorAll('.chromatogram-trace')].map((host) => {
      const canvases = [...host.querySelectorAll('canvas')];
      return {
        canvases: canvases.length,
        widths: canvases.map((c) => c.width),
        total: canvases.reduce((n, c) => n + c.width, 0),
        painted: canvases.map((c) => check(c))
      };
    });
  }, paintedIn.toString());

  if (!out.traces.length) fail.push('no chromatograms rendered at all');

  for (const trace of out.traces) {
    // The thing that was actually broken: a canvas over the limit is not drawn.
    const over = trace.widths.filter((w) => w > LIMIT);
    if (over.length) fail.push(`a canvas is ${over[0]}px, past the ${LIMIT}px limit`);
    /*
     * The two ends, not every slice. A read crossing the origin has its bases
     * at both ends of the reference and nothing in between, so a middle slice
     * being blank is the read, not the bug. Both ends drawing is what says the
     * far piece -- the one past the old limit -- made it onto the screen.
     */
    const ends = [trace.painted[0], trace.painted[trace.painted.length - 1]];
    if (ends.some((p) => p !== true)) {
      fail.push(`a trace is blank at one end: ${JSON.stringify(trace.painted)} `
        + `(widths ${trace.widths})`);
    }
  }

  // The wide one is the point: it has to be split, and the pieces have to add
  // up to the same width the single canvas would have been.
  out.widest = out.traces.reduce((a, b) => (a && a.total > b.total ? a : b), null);
  if (!out.widest || out.widest.total <= LIMIT) {
    fail.push(`nothing here exceeds one canvas, so the case is not covered: `
      + `widest is ${out.widest && out.widest.total}px`);
  } else if (out.widest.canvases < 2) {
    fail.push(`a ${out.widest.total}px trace was drawn on ${out.widest.canvases} canvas`);
  }

  out.FAILURES = fail;
  out.PASS = fail.length === 0;
  return out;
}
