/*
 * The MAFFT banner as Windows sees it: neither brew nor conda exists there, so
 * the panel offers MAFFT's own download and the WSL route instead.
 *
 *   python3 -m http.server 8742 --bind 127.0.0.1 &
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/AlignDemo.html?windows --script test/browser/mafftWindows.mjs
 */

const posted = (page) =>
  page.evaluate(() => JSON.parse(document.getElementById('posted').textContent || '[]'));
const clearPosted = (page) =>
  page.evaluate(() => document.dispatchEvent(new CustomEvent('__clearPosted')));

export default async function run(page) {
  const out = {};
  const fail = [];

  await page.waitForSelector('body[data-ready="true"]', { timeout: 30000 });
  await page.waitForSelector('.ovealign-banner', { timeout: 10000 });

  out.banner = await page.evaluate(() => {
    const b = document.querySelector('.ovealign-banner');
    return {
      commands: [...b.querySelectorAll('.ovealign-cmds code')].map((c) => c.textContent),
      buttons: [...b.querySelectorAll('button')].map((x) => x.textContent)
    };
  });
  if (out.banner.commands.some((c) => /brew|bioconda/.test(c))) {
    fail.push('Windows was told to use brew or conda, neither of which it has');
  }
  if (!out.banner.commands.some((c) => /apt install mafft/.test(c))) fail.push('no WSL command');
  for (const label of ['Download', 'Locate', 'Re-check']) {
    if (!out.banner.buttons.some((b) => b.includes(label))) fail.push(`no ${label} button`);
  }

  await clearPosted(page);
  await page.locator('.ovealign-banner button', { hasText: 'Download' }).click();
  await page.waitForTimeout(200);
  if (!(await posted(page)).some((m) => m.type === 'align/mafftDownload')) {
    fail.push('Download MAFFT did not reach the host');
  }

  out.failures = fail;
  out.ok = fail.length === 0;
  return out;
}
