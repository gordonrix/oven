/*
 * Drives media/EditorDemo.html to check the button row against a real OVE
 * editor -- the only place its menu bar exists to be measured against.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/EditorDemo.html --script test/browser/toolButtons.mjs
 *
 * Two things, both of which have been wrong: that Align/Primer Search/Add to
 * Cart/Save are styled as menu-bar items rather than as coloured pills bolted
 * on top, and that the row stays inside OVE's content instead of hanging off
 * its right edge into the webview gutter.
 */

const IDS = ['ove-align-button', 'ove-search-button', 'ove-cart-button', 'save-button'];

export default async function run(page) {
  const fail = [];
  const out = {};

  await page.waitForFunction(() => document.querySelector('.tg-menu-bar'), { timeout: 60000 });
  await page.waitForTimeout(1200);

  /* --- styled like File / Edit / View -------------------------------------- */

  out.style = await page.evaluate((ids) => {
    const box = (e) => {
      const cs = getComputedStyle(e);
      return { bg: cs.backgroundColor, color: cs.color, font: cs.fontSize, pad: cs.padding };
    };
    // OVE's own menu bar renders Blueprint minimal buttons; whichever is first
    // is the thing ours have to be indistinguishable from.
    const menuItem = document.querySelector('.tg-menu-bar button');
    return {
      menuItem: menuItem ? box(menuItem) : null,
      menuText: menuItem ? menuItem.textContent.trim() : null,
      ours: ids.map((id) => {
        const e = document.getElementById(id);
        return e ? Object.assign({ id, text: e.textContent.trim() }, box(e)) : { id, missing: true };
      })
    };
  }, IDS);

  if (!out.style.menuItem) {
    fail.push('no menu-bar item to compare against — did OVE render its menu bar?');
  } else {
    const want = out.style.menuItem;
    for (const b of out.style.ours) {
      if (b.missing) { fail.push(`${b.id} is not on the page`); continue; }
      // A transparent background is the whole point: a coloured fill is what
      // made these read as a separate toolbar.
      if (b.bg !== 'rgba(0, 0, 0, 0)') fail.push(`${b.id} has a background (${b.bg})`);
      if (b.color !== want.color) fail.push(`${b.id} is ${b.color}, menu items are ${want.color}`);
      if (b.font !== want.font) fail.push(`${b.id} is ${b.font}, menu items are ${want.font}`);
      if (b.pad !== want.pad) fail.push(`${b.id} pads ${b.pad}, menu items pad ${want.pad}`);
    }
  }

  /* --- inside OVE's content, at every width -------------------------------- */

  out.placement = [];
  for (const width of [1400, 1200, 1000, 820]) {
    await page.setViewportSize({ width, height: 700 });
    // The row is repositioned on resize, which lands on the next frame.
    await page.waitForTimeout(350);
    const at = await page.evaluate(() => {
      const row = document.querySelector('.ove-toolbtns').getBoundingClientRect();
      const bar = document.querySelector('.tg-menu-bar').getBoundingClientRect();
      const menu = [...document.querySelectorAll('.tg-menu-bar button')]
        .map((e) => e.getBoundingClientRect());
      return {
        overhang: Math.round(row.right - bar.right),
        // Narrow enough and the row would start colliding with File/Edit/View,
        // which is a different failure from hanging off the right.
        collides: menu.some((m) => m.right > row.left && m.left < row.right)
      };
    });
    out.placement.push(Object.assign({ width }, at));

    if (at.overhang > 0) {
      fail.push(`at ${width}px the row hangs ${at.overhang}px past OVE's right edge`);
    }
    if (at.collides) fail.push(`at ${width}px the row overlaps OVE's own menus`);
  }

  /* --- the hover label carries the shortcut -------------------------------- */

  /*
   * The buttons say what they do, so a label earns its place only by naming the
   * key. Primer Search has one; Align and the cart do not, and get no label
   * rather than one repeating the text already on them.
   */
  out.tips = await page.evaluate(() =>
    ['ove-align-button', 'ove-search-button', 'ove-cart-button'].map((id) => {
      const el = document.getElementById(id);
      return el ? el.getAttribute('data-tip') : 'MISSING';
    }));
  const searchTip = out.tips[1];
  if (!searchTip || !/Primer Search/.test(searchTip)) {
    fail.push(`no hover label on Primer Search: ${JSON.stringify(searchTip)}`);
  } else if (!/\u2318\u2325F|Ctrl\+Alt\+F/.test(searchTip)) {
    fail.push(`the hover label does not name the shortcut: ${JSON.stringify(searchTip)}`);
  }
  if (out.tips[0] || out.tips[2]) {
    fail.push(`a button with no shortcut should have no label: ${JSON.stringify(out.tips)}`);
  }

  return { ...out, failures: fail, ok: fail.length === 0 };
}
