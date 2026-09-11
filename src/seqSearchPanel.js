/*
 * The Sequence Search panel: folders in, ranked hits out.
 *
 * Shaped like src/alignPanel.js -- same show / push / fail / note and the same
 * one-message-per-state-change contract with its webview -- because the two
 * panels behave the same way from the outside and there is no reason for a
 * reader who knows one to have to learn the other.
 *
 * The matching itself is src/seqSearch.js, which touches neither vscode nor the
 * filesystem and is tested on its own.
 */
'use strict';

const path = require('path');
const vscode = require('vscode');

const seqSearch = require('./seqSearch');

/* Only GenBank for now. .fasta and .dna are a later decision, not an oversight. */
const EXTENSIONS = ['.gb', '.gbk'];

/** Stop walking a runaway tree rather than hanging on someone's home directory. */
const MAX_FILES = 20000;

class SeqSearchPanel {
  constructor(context, opts) {
    this.context = context;
    this.onDispose = (opts && opts.onDispose) || (() => {});
    this.panel = null;

    /** @type {Array<{path: string, subfolders: boolean, files: number}>} */
    this.folders = context.globalState.get(SeqSearchPanel.FOLDERS_KEY, []) || [];

    /*
     * path -> {mtime, size, bases}. Held for the session only: 10,000 maps is
     * about 114 MB of bases, which has no business in globalState. Re-reading
     * a folder costs about half a millisecond per file once the OS cache is
     * warm, so the rebuild is not worth persisting around.
     */
    this.index = new Map();

    this.results = [];
    this.status = '';
    this.error = '';
    this.busy = false;
    this.pending = false;
    this.query = '';
    this.kind = 'dna';
    this.exact = true;
    this.minIdentity = 0.9;
  }

  /* ------------------------------------------------------------- panel -- */

  show(column) {
    if (this.panel) {
      this.panel.reveal(column || this.panel.viewColumn, false);
      this.push(true);
      return this.panel;
    }

    const panel = vscode.window.createWebviewPanel(
      'oven.seqSearch',
      'Sequence Search',
      // Beside, like Align and the cart. The editor folds its own split when
      // this opens -- see panels/collapse in editorProvider.
      { viewColumn: column || vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))]
      }
    );
    this.panel = panel;
    panel.webview.html = this.html(panel.webview);

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (!msg) return;
      try {
        switch (msg.type) {
          case 'seqsearch/ready': this.push(true); break;
          case 'seqsearch/browse': await this.browse(); break;
          case 'seqsearch/addUris': await this.addUris(msg.uris || []); break;
          case 'seqsearch/removeFolder': await this.removeFolder(msg.path); break;
          case 'seqsearch/setSubfolders':
            await this.setSubfolders(msg.path, Boolean(msg.subfolders)); break;
          case 'seqsearch/run': await this.run(msg); break;
          case 'seqsearch/open': await this.open(msg); break;
          default: break;
        }
      } catch (e) {
        this.fail(e && e.message ? e.message : String(e));
      }
    });

    panel.onDidChangeViewState(() => {
      if (panel.visible && this.pending) this.push();
    });
    panel.onDidDispose(() => {
      if (this.panel !== panel) return;
      this.panel = null;
      this.onDispose();
    });
    return panel;
  }

  push(force) {
    if (!this.panel) return;
    if (!force && !this.panel.visible) { this.pending = true; return; }
    this.pending = false;
    this.panel.webview.postMessage({
      type: 'seqsearch/state',
      state: {
        folders: this.folders,
        results: this.results,
        status: this.status,
        error: this.error,
        busy: this.busy,
        query: this.query,
        kind: this.kind,
        exact: this.exact,
        minIdentity: this.minIdentity
      }
    });
  }

  fail(message) {
    this.busy = false;
    this.status = message;
    this.error = message;
    this.push(true);
  }

  note(message) {
    this.status = message;
    this.error = '';
    this.push(true);
  }

  /* ----------------------------------------------------------- folders -- */

  async browse() {
    const picked = await vscode.window.showOpenDialog({
      title: 'Choose a folder of sequence maps to search',
      openLabel: 'Search this folder',
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: true
    });
    if (!picked || !picked.length) return;
    await this.addUris(picked.map((u) => u.toString()));
  }

  /**
   * Add folders, refusing anything that is not one.
   *
   * A dropped file is a plausible mistake -- the aligner takes files, this
   * takes folders -- so it is named and refused rather than silently ignored.
   */
  async addUris(uris) {
    const rejected = [];
    let added = 0;
    for (const raw of uris) {
      let uri;
      try { uri = vscode.Uri.parse(raw); } catch { continue; }
      let stat;
      try { stat = await vscode.workspace.fs.stat(uri); } catch { continue; }
      if (stat.type !== vscode.FileType.Directory) {
        rejected.push(path.basename(uri.fsPath));
        continue;
      }
      if (this.folders.some((f) => f.path === uri.fsPath)) continue;
      this.folders.push({ path: uri.fsPath, subfolders: true, files: 0 });
      added++;
    }
    await this.saveFolders();

    if (rejected.length) {
      this.note(`${rejected.slice(0, 3).join(', ')}${rejected.length > 3 ? '…' : ''} `
        + `${rejected.length === 1 ? 'is a file' : 'are files'} — drop a folder instead.`);
    }
    if (added) await this.indexAll();
    else this.push(true);
  }

  async removeFolder(folderPath) {
    this.folders = this.folders.filter((f) => f.path !== folderPath);
    await this.saveFolders();
    this.push(true);
  }

  async setSubfolders(folderPath, subfolders) {
    const folder = this.folders.find((f) => f.path === folderPath);
    if (!folder) return;
    folder.subfolders = subfolders;
    await this.saveFolders();
    await this.indexAll();
  }

  saveFolders() {
    // Only the list. See the note on `this.index`.
    return this.context.globalState.update(SeqSearchPanel.FOLDERS_KEY,
      this.folders.map((f) => ({ path: f.path, subfolders: f.subfolders })));
  }

  /* ----------------------------------------------------------- indexing -- */

  /** Every map under a folder, honouring its subfolder setting. */
  async listFiles(folder) {
    const out = [];
    const walk = async (dir, depth) => {
      if (out.length >= MAX_FILES) return;
      let entries;
      try {
        entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
      } catch {
        return;    // unreadable folder: skipped, not fatal
      }
      for (const [name, kind] of entries) {
        if (out.length >= MAX_FILES) return;
        const full = path.join(dir, name);
        if (kind === vscode.FileType.Directory) {
          if (folder.subfolders && !name.startsWith('.')) await walk(full, depth + 1);
        } else if (EXTENSIONS.includes(path.extname(name).toLowerCase())) {
          out.push(full);
        }
      }
    };
    await walk(folder.path, 0);
    return out;
  }

  /**
   * Read every registered folder into the index.
   *
   * A file whose mtime and size are unchanged keeps the bases already read, so
   * re-indexing after adding a second folder does not re-read the first.
   */
  async indexAll() {
    this.busy = true;
    this.error = '';
    const keep = new Set();
    let read = 0;
    let reused = 0;

    for (const folder of this.folders) {
      const files = await this.listFiles(folder);
      folder.files = files.length;
      this.note(`Indexing ${path.basename(folder.path)}: ${files.length} file(s)…`);

      for (const file of files) {
        keep.add(file);
        let stat;
        try { stat = await vscode.workspace.fs.stat(vscode.Uri.file(file)); } catch { continue; }
        const cached = this.index.get(file);
        if (cached && cached.mtime === stat.mtime && cached.size === stat.size) { reused++; continue; }
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
          const bases = seqSearch.extractBases(Buffer.from(bytes).toString('utf8'));
          if (!bases) continue;
          this.index.set(file, { mtime: stat.mtime, size: stat.size, bases });
          read++;
        } catch { /* unreadable file: skipped */ }
      }
    }

    // Drop anything no longer under a registered folder.
    for (const file of [...this.index.keys()]) if (!keep.has(file)) this.index.delete(file);

    this.busy = false;
    const total = this.index.size;
    this.note(`${total} sequence${total === 1 ? '' : 's'} indexed`
      + (reused ? ` (${read} read, ${reused} unchanged)` : ''));
    await this.saveFolders();
  }

  /* ------------------------------------------------------------ search -- */

  async run(msg) {
    this.query = String((msg && msg.query) || '').trim();
    this.kind = msg && msg.kind === 'protein' ? 'protein' : 'dna';
    this.exact = !(msg && msg.exact === false);
    this.minIdentity = msg && msg.minIdentity ? Number(msg.minIdentity) : this.minIdentity;

    const cleaned = this.query.replace(/\s/g, '').toUpperCase();
    if (!cleaned) { this.results = []; this.note('Enter a sequence to search for.'); return; }
    if (!this.folders.length) {
      this.results = [];
      this.note('Add a folder to search first.');
      return;
    }
    if (!this.index.size) await this.indexAll();

    const bad = this.kind === 'dna'
      ? cleaned.replace(/[ACGTURYSWKMBDHVN]/g, '')
      : cleaned.replace(/[ACDEFGHIKLMNPQRSTVWY*X]/g, '');
    if (bad) {
      this.results = [];
      this.note(`Not a ${this.kind === 'dna' ? 'DNA' : 'protein'} sequence: `
        + `${[...new Set(bad)].slice(0, 5).map((c) => `"${c}"`).join(', ')}`);
      return;
    }

    this.busy = true;
    this.push(true);

    const targets = [];
    for (const [file, entry] of this.index) {
      targets.push({ file, name: path.basename(file), sequence: entry.bases });
    }

    const started = Date.now();
    const hits = seqSearch.searchCorpus(targets, cleaned, {
      kind: this.kind,
      exact: this.exact,
      minIdentity: this.minIdentity
    });

    this.results = hits.map((h) => ({
      file: h.file,
      name: h.name,
      start: h.start,
      end: h.end,
      strand: h.strand,
      frame: h.frame,
      length: h.length,
      identity: h.identity,
      score: h.score
    }));
    this.busy = false;
    const ms = Date.now() - started;
    this.note(`${hits.length} hit${hits.length === 1 ? '' : 's'} in ${targets.length} `
      + `sequence${targets.length === 1 ? '' : 's'} · ${ms} ms`);
  }

  /** Open the file a hit came from, with the hit selected. */
  async open(msg) {
    if (!msg || !msg.file) return;
    const range = { start: Number(msg.start), end: Number(msg.end), strand: Number(msg.strand) || 1 };
    await vscode.commands.executeCommand('oven.revealRange', msg.file, range);
  }

  html(webview) {
    const media = (name) => webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', name))
    );
    const nonce = String(Date.now());
    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="${media('seqSearchView.css')}" />
  </head>
  <body>
    <div class="oveseq-root">
      <div id="setup"></div>
      <div id="results"></div>
    </div>
    <script nonce="${nonce}" src="${media('seqSearchView.js')}"></script>
  </body>
</html>`;
  }
}

SeqSearchPanel.FOLDERS_KEY = 'oven.seqSearch.folders';

module.exports = { SeqSearchPanel, EXTENSIONS };
