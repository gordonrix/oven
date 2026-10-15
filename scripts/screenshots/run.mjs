#!/usr/bin/env node
/*
 * Retakes the README screenshots, in a real VS Code running this checkout,
 * with nothing on your screen.
 *
 *   npm run screenshots                            all of them, into images/
 *   npm run screenshots -- alignment codon-table   just these
 *   npm run screenshots -- --size 1600x1000        a size in points (default: this display's)
 *   npm run screenshots -- --scale 1               pixels per point (default 2)
 *   npm run screenshots -- --keep                  keep the profile afterwards, to look at
 *   npm run screenshots -- --out /some/dir         somewhere other than images/
 *
 * Nothing opens a window. VS Code's own server -- the one `code serve-web`
 * runs, matched to the installed VS Code -- serves the real workbench and runs
 * the real extension host, with OVEN installed from a freshly packaged .vsix,
 * and headless Chrome draws it. The pictures are the size of the display the
 * script runs on unless --size says otherwise, so they come out full-screen.
 *
 * Everything lives in a throwaway profile under /tmp: no extension but this
 * one, none of your settings or state, and nothing it does reaches your own
 * VS Code. The files it opens are generated (fixtures.mjs): the repo is
 * public, and a screenshot publishes a construct as surely as committing it.
 *
 * Needs VS Code (VSCODE_PATH if it is not in /Applications), Google Chrome or
 * Playwright's Chromium, and MAFFT for the two alignment shots. The first run
 * downloads the server, about 80 MB, into node_modules/.cache.
 *
 * A scene that fails leaves a picture of where it got to beside the profile,
 * and the run carries on with the rest; the exit code says whether all of them
 * worked.
 */
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { writeFixtures } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const CACHE = path.join(REPO, 'node_modules', '.cache', 'oven-screenshots');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- options -- */

function parseArgs(argv) {
  const opts = { scenes: [], size: null, scale: 2, keep: false, out: path.join(REPO, 'images') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--size') opts.size = argv[++i];
    else if (a === '--scale') opts.scale = Number(argv[++i]);
    else if (a === '--keep') opts.keep = true;
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else opts.scenes.push(a);
  }
  return opts;
}

/** The display's size in points, which is what full-screen means here. */
function screenSize() {
  if (process.platform === 'darwin') {
    try {
      const bounds = execFileSync('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop'])
        .toString().split(',').map((n) => Number(n.trim()));
      if (bounds.length === 4 && bounds[2] > 0) return { width: bounds[2], height: bounds[3] };
    } catch { /* fall through */ }
  }
  return { width: 1920, height: 1080 };
}

/* ----------------------------------------------------------------- server -- */

function findVSCode() {
  const app = [
    process.env.VSCODE_PATH,
    '/Applications/Visual Studio Code.app',
    path.join(os.homedir(), 'Applications/Visual Studio Code.app'),
    '/usr/share/code'
  ].filter(Boolean).find((p) => fs.existsSync(p));
  if (!app) throw new Error('VS Code not found; set VSCODE_PATH to the app or its install folder');
  const resources = app.endsWith('.app') ? path.join(app, 'Contents/Resources/app') : path.join(app, 'resources/app');
  const product = JSON.parse(fs.readFileSync(path.join(resources, 'product.json'), 'utf8'));
  return { cli: path.join(resources, 'bin', 'code'), commit: product.commit };
}

function findMafft() {
  try {
    return execFileSync('which', ['mafft']).toString().split('\n')[0].trim();
  } catch {
    return null;   // OVEN still looks in Homebrew and conda for itself
  }
}

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
  server.on('error', reject);
});

async function waitForHttp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`nothing answered at ${url}`);
}

/** Start a process in its own group, so the whole tree can be ended at once. */
function startGroup(cmd, args) {
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  return () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } };
}

/**
 * The VS Code server for the installed VS Code's commit. `code serve-web`
 * fetches it on the first request it gets, so that is how it is fetched; it
 * is kept, and only fetched again when VS Code updates.
 */
async function ensureServer(vscode) {
  const bin = path.join(CACHE, 'serve-web', vscode.commit, 'bin', 'code-server');
  if (fs.existsSync(bin)) return bin;
  console.log('fetching the VS Code server (once per VS Code version) …');
  const port = await freePort();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oven-serve-web-'));
  const stopIt = startGroup(vscode.cli, ['serve-web', '--host', '127.0.0.1', '--port', String(port),
    '--without-connection-token', '--accept-server-license-terms',
    '--cli-data-dir', CACHE, '--server-data-dir', scratch]);
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`, 60000);
    const end = Date.now() + 300000;
    while (!fs.existsSync(bin) && Date.now() < end) {
      await fetch(`http://127.0.0.1:${port}/`).catch(() => {});
      await sleep(2000);
    }
  } finally {
    stopIt();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  if (!fs.existsSync(bin)) throw new Error('the VS Code server did not download');
  return bin;
}

/*
 * Under /tmp rather than os.tmpdir(): VS Code puts sockets in its data
 * directory, and a socket path has to fit in 103 characters. macOS's own
 * temporary directory is deep enough on its own to push it over.
 */
function makeProfile() {
  return fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'oven-shots-'));
}

/** This checkout, packaged and installed into the profile's extensions. */
function installOven(server, profile) {
  const vsix = path.join(profile, 'oven.vsix');
  execFileSync('npx', ['vsce', 'package', '--no-dependencies', '-o', vsix], { cwd: REPO, stdio: 'ignore' });
  execFileSync(server, ['--extensions-dir', path.join(profile, 'extensions'), '--install-extension', vsix], { stdio: 'ignore' });
}

/*
 * User settings. In the browser they are kept by the page, not on disk, so
 * they are typed into Preferences: Open User Settings (JSON) once the
 * workbench is up, and the page reloaded.
 */
function userSettings(fixtures) {
  const settings = {
    'workbench.colorTheme': 'Default Dark Modern',
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'workbench.editor.enablePreview': false,
    'workbench.layoutControl.enabled': false,
    'window.commandCenter': false,
    'chat.disableAIFeatures': true,
    'chat.commandCenter.enabled': false,
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'extensions.ignoreRecommendations': true,
    'git.enabled': false,
    'editor.minimap.enabled': false,
    'workbench.editorAssociations': {
      '*.gb': 'oven.editor', '*.gbk': 'oven.editor', '*.ab1': 'oven.editor',
      '*.fasta': 'oven.editor', '*.fa': 'oven.editor', '*.faa': 'oven.editor'
    },
    'oven.inventoryPath': fixtures.files.inventory
  };
  const mafft = findMafft();
  if (mafft) settings['oven.mafftPath'] = mafft;
  return settings;
}

async function launchBrowser() {
  try {
    return await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    try {
      return await chromium.launch({ headless: true });
    } catch {
      throw new Error('no browser: install Google Chrome, or run `npx playwright-core install chromium`');
    }
  }
}

/* ---------------------------------------------------------------- helpers -- */

/**
 * Everything a scene drives the window with.
 */
function helpers(page, opts, fixtures) {
  const h = {
    page,
    fixtures,

    /** Run a command from the palette by its title, as typed there. */
    async command(title) {
      await page.keyboard.press('F1');
      await page.waitForSelector('.quick-input-widget .quick-input-box input', { state: 'visible' });
      await page.keyboard.type(title);
      await sleep(400);
      await page.keyboard.press('Enter');
      await sleep(800);
    },

    /** Open a workspace file through Quick Open. */
    async open(file) {
      await page.keyboard.press(`${MOD}+P`);
      await page.waitForSelector('.quick-input-widget .quick-input-box input', { state: 'visible' });
      await page.keyboard.type(path.relative(fixtures.dir, file));
      await sleep(600);
      await page.keyboard.press('Enter');
      await sleep(1500);
    },

    /**
     * The webview showing `selector`, once it does. Every webview is a frame
     * of the workbench; ones in background tabs are hidden, so asking for a
     * visible match picks the one on screen.
     */
    async frame(selector, timeout = 60000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        for (const f of page.frames()) {
          try {
            if (await f.locator(selector).first().isVisible()) return f;
          } catch { /* a frame that went away mid-look */ }
        }
        await sleep(300);
      }
      throw new Error(`no webview showed ${selector}`);
    },

    /** Drop files or folders on an element, as Finder would. */
    async drop(frame, selector, files) {
      const uris = files.map((f) => pathToFileURL(f).href);
      await frame.evaluate(({ selector, uris }) => {
        const zone = document.querySelector(selector);
        const dt = new DataTransfer();
        dt.setData('text/uri-list', uris.join('\r\n'));
        for (const type of ['dragenter', 'dragover', 'drop']) {
          zone.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, shiftKey: true }));
        }
      }, { selector, uris });
    },

    /** The page's box for an element inside a webview. */
    async box(frame, selector) {
      const b = await frame.locator(selector).first().boundingBox();
      if (!b) throw new Error(`${selector} has no box`);
      return b;
    },

    /** The workbench below the title bar. */
    async window() {
      const vp = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const title = await page.locator('.part.titlebar').boundingBox().catch(() => null);
      const top = title ? title.y + title.height : 0;
      return { x: 0, y: top, width: vp.width, height: vp.height - top };
    },

    /** The editor area, tabs included. */
    async editorArea() {
      return page.locator('.part.editor').boundingBox();
    },

    /** The active editor group, its tabs included. */
    async group() {
      return page.locator('.part.editor .editor-group-container.active').boundingBox();
    },

    /*
     * The secondary side bar opens empty on the right, for chat, and takes a
     * fifth of the width; nothing here uses it.
     */
    async hideSecondarySideBar() {
      const bar = page.locator('.part.auxiliarybar');
      if (!(await bar.count()) || !(await bar.first().isVisible())) return;
      await h.command('View: Hide Secondary Side Bar');
      if (await bar.first().isVisible()) await h.command('View: Toggle Secondary Side Bar Visibility');
    },

    async shot(name, clip) {
      const file = path.join(opts.out, `Screenshot_${name}.png`);
      // Off anything with a tooltip: the mouse is wherever the last click was.
      const vp = page.viewportSize();
      await page.mouse.move(vp.width - 3, vp.height / 2);
      await sleep(900);
      await page.screenshot({ path: file, clip: clip || await h.window() });
      return file;
    },

    /** Close every editor and every split, so each scene starts from one empty group. */
    async closeAll() {
      await h.command('View: Close All Editors');
      // A modified file would ask whether to save; nothing here is kept.
      const dontSave = page.locator('.monaco-dialog-box button', { hasText: /Don.t Save/ });
      if (await dontSave.count()) await dontSave.first().click();
      await h.command('View: Single Column Editor Layout');
      await sleep(500);
    },

    /** Activate an editor by its tab's label. */
    async tab(label) {
      await page.locator('.tabs-container .tab', { hasText: label }).first().click();
      await sleep(800);
    },

    /** Replace the user settings, through the Settings (JSON) editor. */
    async writeSettings(settings) {
      await h.command('Preferences: Open User Settings (JSON)');
      // It opens focused, in a modal over the workbench; keys go straight in.
      await page.waitForSelector('.monaco-editor.focused', { state: 'visible' });
      await page.keyboard.press(`${MOD}+A`);
      await page.keyboard.press('Backspace');
      // One line, inserted whole: typed a key at a time, the editor would
      // auto-close every quote and bracket.
      await page.keyboard.insertText(JSON.stringify(settings));
      await page.keyboard.press(`${MOD}+S`);
      await sleep(1000);
      await page.keyboard.press('Escape');
    }
  };
  return h;
}

/* ----------------------------------------------------------------- scenes -- */

/** The editor of the plasmid, with OVE drawn. */
async function openPlasmid(h) {
  await h.open(h.fixtures.files.plasmid);
  const f = await h.frame('.veRowView');
  await sleep(1500);
  return f;
}

/** Select a stretch of the open sequence, 1-based inclusive like the README. */
const select = (frame, start, end) => frame.evaluate(({ start, end }) => {
  window.__oveEditor.updateEditor({ selectionLayer: { start: start - 1, end: end - 1 } });
}, { start, end });

/** Zoom an alignment right in and bring a base to the middle. */
async function zoomAlignmentTo(h, frame, base, length) {
  const slider = await h.box(frame, '.veZoomAlignmentSlider .bp3-slider');
  await h.page.mouse.click(slider.x + slider.width - 1, slider.y + slider.height / 2);
  await sleep(1200);
  await frame.evaluate(({ base, length }) => {
    for (const holder of document.querySelectorAll('.alignmentHolder')) {
      const per = holder.scrollWidth / length;
      holder.scrollLeft = Math.max(0, base * per - holder.clientWidth / 2);
      holder.dispatchEvent(new Event('scroll'));
    }
  }, { base, length });
  await sleep(1500);
}

/**
 * The alignment's group, down to the end of its last track: below that is
 * empty until the overview strip at the very bottom.
 */
async function tracksOnly(h, frame) {
  const group = await h.group();
  const tracks = frame.locator('.alignmentViewTrackContainer');
  let bottom = 0;
  for (let i = 0; i < await tracks.count(); i++) {
    const b = await tracks.nth(i).boundingBox();
    if (b) bottom = Math.max(bottom, b.y + b.height);
  }
  return { ...group, height: Math.min(group.height, bottom + 16 - group.y) };
}

async function alignAndWait(h, frame, count) {
  await frame.locator('.ovealign-read').nth(count - 1).waitFor({ timeout: 30000 });
  await frame.locator('button', { hasText: /^Align$/ }).click();
  await frame.waitForSelector('.alignmentHolder', { timeout: 120000 });
  await sleep(2500);
}

const SCENES = {
  /*
   * The first thing the README shows: a plasmid open, a stretch selected,
   * Primer Search's hits for it on the right, and the right-click menu.
   */
  async overview(h) {
    const f = await openPlasmid(h);
    await select(f, 181, 420);
    await sleep(500);
    await f.locator('#ove-search-button').click();
    await f.waitForSelector('.ovesearch-row', { timeout: 30000 });
    await sleep(1500);
    // Right-click the bases of a row inside the selection, as you would: the
    // selection is drawn as several pieces, and the rows also carry
    // translations and features, which have menus of their own.
    const pieces = f.locator('.veRowView .veSelectionLayer');
    let sel = null;
    for (let i = 0; i < await pieces.count(); i++) {
      const b = await pieces.nth(i).boundingBox();
      if (b && (!sel || b.width * b.height > sel.width * sel.height)) sel = b;
    }
    const rows = f.locator('.veRowView .ve-row-item-sequence');
    let target = null;
    for (let i = 0; i < await rows.count() && !target; i++) {
      const b = await rows.nth(i).boundingBox();
      if (b && b.y > sel.y && b.y + b.height < sel.y + sel.height) target = b;
    }
    if (!target) throw new Error('no row of bases inside the selection');
    await h.page.mouse.click(target.x + target.width * 0.4, target.y + target.height / 2, { button: 'right' });
    await f.waitForSelector('.bp3-menu', { timeout: 10000 });
    await sleep(500);
    await h.shot('overview');
    await h.page.keyboard.press('Escape');
  },

  /* The cart in its own group beside the plasmid, holding the map's primers. */
  async 'primer-cart'(h) {
    const f = await openPlasmid(h);
    await f.locator('#ove-cart-button').click();
    await f.waitForSelector('.ovecart-panel', { timeout: 10000 });
    await f.evaluate(() => {
      for (const box of document.querySelectorAll('.ovecart-row input[type=checkbox]')) {
        if (!box.disabled && !box.checked) box.click();
      }
    });
    await f.locator('.ovecart-primary').click();
    await sleep(800);
    await h.command('OVEN: Show Primer Cart');
    await h.tab('Primer Cart');
    await h.command('View: Move Editor into Right Group');
    await h.frame('.rowbody', 30000);
    // Room for the plasmid beside it: no Explorer, and the cart narrower.
    await h.command('View: Toggle Primary Side Bar Visibility');
    for (let i = 0; i < 4; i++) await h.command('View: Decrease Current View Width');
    await sleep(1500);
    await h.shot('primer-cart', await h.editorArea());
    await h.command('View: Toggle Primary Side Bar Visibility');
  },

  /*
   * Three reads over demoA: two clean, one with a substitution that changes
   * an amino acid, zoomed in on it so the bases and the new residue show.
   */
  async alignment(h) {
    const f = await openPlasmid(h);
    await f.locator('#ove-align-button').click();
    const a = await h.frame('.ovealign-drop');
    await h.drop(a, '.ovealign-drop', h.fixtures.files.reads);
    await alignAndWait(h, a, h.fixtures.files.reads.length);
    await zoomAlignmentTo(h, a, h.fixtures.mutantBase, h.fixtures.plasmid.length);
    await h.shot('alignment', await tracksOnly(h, a));
  },

  /* Change Amino Acid, opened from a residue of demoA's translation. */
  async 'codon-table'(h) {
    const f = await openPlasmid(h);
    await select(f, 201, 1100);
    await sleep(800);
    await f.locator('.translationLayer > g').nth(4).click({ button: 'right', force: true });
    await f.locator('.bp3-menu-item', { hasText: /Change Amino Acid/ }).first().click();
    await f.waitForSelector('.oveaa-panel', { timeout: 10000 });
    await sleep(800);
    const panel = await h.box(f, '.oveaa-panel');
    const pad = 24;
    await h.shot('codon-table', {
      x: Math.max(0, panel.x - pad), y: Math.max(0, panel.y - pad),
      width: panel.width + 2 * pad, height: panel.height + 2 * pad
    });
    await h.page.keyboard.press('Escape');
  },

  /* A piece of demoA searched for, fuzzily, across a folder of maps. */
  async 'sequence-search'(h) {
    const f = await openPlasmid(h);
    await f.locator('#ove-seqsearch-button').click();
    const s = await h.frame('.oveseq-query');
    await h.drop(s, '.oveseq-drop', [h.fixtures.files.maps]);
    await s.waitForSelector('.oveseq-folder', { timeout: 20000 });
    await s.locator('.oveseq-query').fill(h.fixtures.searchQuery);
    await s.locator('.oveseq-radio', { hasText: 'Fuzzy' }).click();
    await s.locator('.oveseq-go').click();
    await s.waitForSelector('.oveseq-body > *', { timeout: 30000 });
    await sleep(1000);
    const group = await h.group();
    const hits = await h.box(s, '.oveseq-body');
    await h.shot('sequence-search', { ...group, height: hits.y + hits.height + 24 - group.y });
  },

  /* demoA's protein against four variants of it. */
  async 'protein-alignment'(h) {
    await h.open(h.fixtures.files.protein);
    const f = await h.frame('.veRowView');
    await sleep(1500);
    await f.locator('#ove-align-button').click();
    const a = await h.frame('.ovealign-drop');
    await h.drop(a, '.ovealign-drop', [h.fixtures.files.proteinReads]);
    await alignAndWait(h, a, 4);
    await zoomAlignmentTo(h, a, 120, 299);
    await h.shot('protein-alignment', await tracksOnly(h, a));
  }
};

/* ------------------------------------------------------------------- main -- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const names = opts.scenes.length ? opts.scenes : Object.keys(SCENES);
  const unknown = names.filter((n) => !SCENES[n]);
  if (unknown.length) throw new Error(`no scene ${unknown.join(', ')}; there are ${Object.keys(SCENES).join(', ')}`);
  const size = opts.size ? (([width, height]) => ({ width, height }))(opts.size.split('x').map(Number)) : screenSize();

  const vscode = findVSCode();
  const server = await ensureServer(vscode);
  const profile = makeProfile();
  const workspace = path.join(profile, 'demo');
  const fixtures = { ...writeFixtures(workspace), dir: workspace };
  fs.mkdirSync(opts.out, { recursive: true });
  console.log(`profile: ${profile}\nsize: ${size.width}x${size.height} at ${opts.scale}x`);

  installOven(server, profile);
  const port = await freePort();
  const stopServer = startGroup(server, ['--host', '127.0.0.1', '--port', String(port),
    '--without-connection-token', '--accept-server-license-terms', '--telemetry-level', 'off',
    '--server-data-dir', path.join(profile, 'server'), '--extensions-dir', path.join(profile, 'extensions')]);

  let browser;
  const failed = [];
  try {
    const url = `http://127.0.0.1:${port}/?folder=${encodeURIComponent(workspace)}`;
    await waitForHttp(url, 60000);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: size, deviceScaleFactor: opts.scale });
    const page = await context.newPage();
    const h = helpers(page, opts, fixtures);

    await page.goto(url);
    await page.waitForSelector('.monaco-workbench .part.editor', { timeout: 120000 });
    await sleep(3000);
    await h.writeSettings(userSettings(fixtures));
    await page.reload();
    await page.waitForSelector('.monaco-workbench .part.editor', { timeout: 120000 });
    await sleep(5000);   // extensions activating, the Explorer settling
    await h.command('Notifications: Clear All Notifications');
    await h.hideSecondarySideBar();

    for (const name of names) {
      process.stdout.write(`${name} … `);
      try {
        await h.closeAll();
        await SCENES[name](h);
        console.log('ok');
      } catch (err) {
        failed.push(name);
        const where = path.join(profile, `failed-${name}.png`);
        await page.screenshot({ path: where }).catch(() => {});
        console.log(`FAILED: ${err.message.split('\n')[0]}\n  where it got to: ${where}`);
      }
    }
  } finally {
    await browser?.close().catch(() => {});
    stopServer();
    if (!opts.keep && !failed.length) fs.rmSync(profile, { recursive: true, force: true });
  }

  console.log(failed.length ? `\n${failed.length} failed: ${failed.join(', ')}` : `\nall written to ${opts.out}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
