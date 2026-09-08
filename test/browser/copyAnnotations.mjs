/*
 * Copying a stretch of sequence carries its annotations.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/EditorDemo.html --script test/browser/copyAnnotations.mjs
 *
 * Open Vector Editor's paste already reads an `application/json` flavour off
 * the clipboard and inserts whatever features, parts and primers it finds --
 * but nothing ever wrote one. Stock calls preventDefault on the copy event and
 * then puts the bases on with navigator.clipboard.writeText, which carries
 * plain text only, so a copied feature was dropped every time.
 *
 * Both flavours are set on the copy event now. That has to happen before the
 * first await, or the event has finished dispatching and setData is a no-op.
 *
 * The fixture has "rev CDS" at 150..248. The selection below contains it whole,
 * so it is not dropped as a partial feature.
 */
const FEATURE = 'rev CDS';
const FROM = 140;
const TO = 260;              // 121 bp inclusive
const PASTE_AT = 400;

const publish = async (page) => {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__publish')));
  return page.evaluate(() => {
    const sd = JSON.parse(document.getElementById('editorState').textContent || '{}');
    return { len: (sd.sequence || '').length, features: (sd.features || []).map((f) => f.name) };
  });
};

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.setViewportSize({ width: 1300, height: 850 });
  await page.waitForSelector('.veVectorInteractionWrapper', { timeout: 60000 });
  await page.waitForTimeout(1800);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('__captureCopies')));

  const box = await page.locator('.veRowItemSequenceContainer').first().boundingBox();
  await page.mouse.click(box.x + 60, box.y + box.height / 2);
  await page.waitForTimeout(400);

  out.before = await publish(page);
  if (!out.before.features.includes(FEATURE)) {
    fail.push(`the fixture no longer has ${FEATURE}: ${JSON.stringify(out.before.features)}`);
    return { ...out, FAILURES: fail, PASS: false };
  }

  await page.evaluate(([s, e]) => document.dispatchEvent(new CustomEvent('__updateEditor', {
    detail: { selectionLayer: { start: s, end: e }, caretPosition: -1 } })), [FROM, TO]);
  await page.waitForTimeout(600);
  await page.keyboard.press('Meta+c');
  await page.waitForTimeout(900);

  /* --- the annotated flavour reaches the clipboard -------------------------- */

  out.clipboard = await page.evaluate(() => {
    const raw = document.getElementById('copyJson').textContent || '';
    if (!raw) return { present: false };
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { return { present: true, parseError: String(e) }; }
    return {
      present: true,
      sequenceLength: (parsed.sequence || '').length,
      features: Object.values(parsed.features || {}).map((f) => f.name)
    };
  });
  if (!out.clipboard.present) {
    fail.push('a copy put no application/json on the clipboard, so annotations cannot travel');
  } else if (out.clipboard.parseError) {
    fail.push(`the clipboard payload is not JSON: ${out.clipboard.parseError}`);
  } else {
    if (out.clipboard.sequenceLength !== TO - FROM + 1) {
      fail.push(`the payload holds ${out.clipboard.sequenceLength} bp, expected ${TO - FROM + 1}`);
    }
    if (!(out.clipboard.features || []).includes(FEATURE)) {
      fail.push(`the payload carries no ${FEATURE}: ${JSON.stringify(out.clipboard.features)}`);
    }
  }

  /* --- and pasting puts it back -------------------------------------------- */

  await page.evaluate((at) => document.dispatchEvent(new CustomEvent('__updateEditor', {
    detail: { selectionLayer: { start: -1, end: -1 }, caretPosition: at } })), PASTE_AT);
  await page.waitForTimeout(500);
  await page.keyboard.press('Meta+v');
  await page.waitForTimeout(1600);
  out.after = await publish(page);

  const grew = out.after.len - out.before.len;
  if (grew !== TO - FROM + 1) {
    fail.push(`the paste added ${grew} bp, expected ${TO - FROM + 1}`);
  }
  const copies = out.after.features.filter((n) => n === FEATURE).length;
  if (copies !== 2) {
    fail.push(`expected a second ${FEATURE} after pasting, got ${JSON.stringify(out.after.features)}`);
  }

  out.FAILURES = fail;
  out.PASS = fail.length === 0;
  return out;
}
