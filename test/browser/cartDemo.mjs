/*
 * Drives media/CartDemo.html in a headless browser to prove the editor-side
 * flow against the real OVE bundle.
 *
 * Serve the repo root, then:
 *   node <browser-automation>/browser.mjs http://127.0.0.1:PORT/media/CartDemo.html --script test/browser/cartDemo.mjs
 *
 * page.evaluate runs in an isolated world with no access to the page's JS
 * globals, so all page state is read back through DOM bridge nodes that
 * CartDemo.html maintains (#posted, #probe, body[data-ready]).
 */

const menus = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.bp3-menu')].map((m) => m.innerText.replace(/\n/g, ' / ')));

const posted = (page) =>
  page.evaluate(() => JSON.parse(document.getElementById('posted').textContent || '[]'));

const clearPosted = (page) =>
  page.evaluate(() => document.dispatchEvent(new CustomEvent('__clearPosted')));

const probe = (page) =>
  page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('__probe'));
    return JSON.parse(document.getElementById('probe').textContent || '{}');
  });

const dismiss = async (page) => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.mouse.click(4, 4);
  await page.waitForTimeout(250);
};

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.waitForSelector('body[data-ready="true"]', { timeout: 30000 });
  await page.waitForSelector('.veVectorInteractionWrapper', { timeout: 20000 });

  out.initialState = await probe(page);
  if (out.initialState.readOnly !== false) fail.push('readOnly should be false after updateEditor payload');

  // --- regression guard: the Create submenu used to render completely empty
  await page.locator('.tg-menu-bar-item', { hasText: 'Edit' }).first().click();
  await page.waitForTimeout(600);
  out.editMenu = (await menus(page))[0];
  await page.locator('.bp3-menu-item').filter({ hasText: /^Create/ }).first().hover();
  await page.waitForTimeout(800);
  out.createSubmenu = (await menus(page)).slice(-1)[0];
  await dismiss(page);

  for (const want of ['New Feature', 'New Part', 'New Primer']) {
    if (!out.createSubmenu.includes(want)) fail.push(`Create submenu missing "${want}"`);
  }

  // --- disableBpEditing must have removed the destructive commands ---------
  out.cutHidden = !out.editMenu.includes('Cut');
  out.pasteHidden = !out.editMenu.includes('Paste');
  if (!out.cutHidden) fail.push('Cut should be hidden by disableBpEditing');
  if (!out.pasteHidden) fail.push('Paste should be hidden by disableBpEditing');

  // --- picker lists the file's primers with derived sequences --------------
  await page.locator('#ove-cart-button').click();
  await page.waitForSelector('.ovecart-panel', { timeout: 8000 });
  out.pickerRows = await page.evaluate(() =>
    [...document.querySelectorAll('.ovecart-row')].map((r) => ({
      name: (r.querySelector('.ovecart-name-text') || {}).textContent || '(selection)',
      seq: (r.querySelector('.ovecart-seq') || {}).textContent || '',
      meta: (r.querySelector('.ovecart-meta') || {}).textContent || ''
    }))
  );
  if (out.pickerRows.length !== out.initialState.primerCount) {
    fail.push(`picker showed ${out.pickerRows.length} rows, expected ${out.initialState.primerCount}`);
  }

  /*
   * The reverse primer's derived sequence must match the /Sequence qualifier
   * the fixture states independently -- that is the whole point of the check.
   * The literal comes from test/fixtures/make-synthetic-plasmid.mjs, which is
   * deterministic; regenerate the fixture and this moves with it.
   */
  const rev = out.pickerRows.find((r) => r.name.startsWith('SYN-rev-primer'));
  out.reversePrimerDerived = rev ? rev.seq : null;
  if (!rev || rev.seq !== 'GGGGCCTCTCTTACTGTGT') {
    fail.push(`reverse primer derived as ${rev && rev.seq}, expected GGGGCCTCTCTTACTGTGT`);
  }

  // --- check two, add ------------------------------------------------------
  await clearPosted(page);
  await page.evaluate(() => {
    [...document.querySelectorAll('.ovecart-row input[type=checkbox]')]
      .filter((b) => !b.disabled)
      .slice(0, 2)
      .forEach((b) => { b.checked = true; });
  });
  await page.locator('.ovecart-primary').click();
  await page.waitForTimeout(600);

  const addMsgs = await posted(page);
  out.addMessage = addMsgs.find((m) => m.type === 'cart/add') || null;
  out.pickerClosed = (await page.locator('.ovecart-panel').count()) === 0;
  if (!out.addMessage) fail.push('no cart/add message was posted');
  else if (out.addMessage.items.length !== 2) fail.push(`cart/add carried ${out.addMessage.items.length} items, expected 2`);
  if (!out.pickerClosed) fail.push('picker did not close after adding');

  // --- creating a primer must add to the cart AND create the annotation ----
  await clearPosted(page);
  const before = (await probe(page)).primerCount;

  // Select bases 101..122 (0-based, inclusive) so the dialog opens pre-filled,
  // exactly as it would after dragging across the sequence map.
  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent('__select', { detail: { start: 100, end: 121 } }))
  );
  await page.waitForTimeout(400);

  await page.locator('.tg-menu-bar-item', { hasText: 'Edit' }).first().click();
  await page.waitForTimeout(500);
  await page.locator('.bp3-menu-item').filter({ hasText: /^Create/ }).first().hover();
  await page.waitForTimeout(600);
  await page.locator('.bp3-menu-item').filter({ hasText: /New Primer/ }).last().click();
  await page.waitForTimeout(1000);

  out.createDialogOpen = (await page.locator('.bp3-dialog').count()) > 0;
  if (!out.createDialogOpen) {
    fail.push('Create > New Primer did not open a dialog');
  } else {
    await page.locator('.bp3-dialog input[type="text"]').first().fill('QA_TEST_PRIMER');
    await page.waitForTimeout(200);
    const submit = page.locator('.bp3-dialog button').filter({ hasText: /^(Save|Add|Create|OK)$/i }).last();
    out.submitLabel = (await submit.count()) ? await submit.textContent() : null;
    if (await submit.count()) await submit.click();
    else await page.locator('.bp3-dialog .bp3-intent-primary').last().click();
    await page.waitForTimeout(1400);

    const after = await probe(page);
    out.primersBefore = before;
    out.primersAfter = after.primerCount;
    out.createdPosted = (await posted(page)).find((m) => m.type === 'cart/add' && m.origin === 'created') || null;

    if (after.primerCount !== before + 1) {
      fail.push(`primer count went ${before} -> ${after.primerCount}; beforeAnnotationCreate must not abort creation`);
    }
    if (!out.createdPosted) {
      fail.push('creating a primer did not post cart/add with origin=created');
    } else {
      const item = out.createdPosted.items[0];
      // The 22 bp selection must reach the cart as 22 bases, not a stub.
      if (item.sequence.length !== 22) {
        fail.push(`created primer carried ${item.sequence.length} bases, expected 22 from the selection`);
      }
      if (item.name !== 'QA_TEST_PRIMER') fail.push(`created primer named "${item.name}"`);
    }
  }

  out.FAILURES = fail;
  out.PASS = fail.length === 0;
  return out;
}
