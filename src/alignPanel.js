/*
 * The Alignment panel.
 *
 * One webview panel per reference sequence, opened from the Align button in a
 * plasmid editor and handed out by `AlignPanels`. Keying on the reference is
 * what lets two references be compared side by side, and it stops Align on a
 * new plasmid from landing in a window still holding the last one's reads.
 *
 * The panel is modelled on cartPanel.js -- including its two hard-won habits: register the
 * message handler *before* assigning html, because assigning html runs the
 * client script synchronously and it asks for state immediately; and treat
 * postMessage to a hidden webview as discarded, so defer while hidden and flush
 * on the next view-state change.
 *
 * Parsing and aligning both happen here rather than in the webview: MAFFT is a
 * child process, and doing the work on the host keeps the panel responsive and
 * the logic testable without a browser.
 */
'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const config = require('./config');
const mafft = require('./mafft');
const { align, mutatedCodons } = require('./align');
const { buildStockholm, readAlignment, rebuild } = require('./alignFile');
const {
  parseFile, trimByQuality, followAlignment, followAlignmentAnnotations, SEQUENCE_EXTENSIONS
} = require('./alignTracks');

/* What a saved alignment is written as. Stockholm; see alignFile.js. */
const ALIGNMENT_EXTENSION = 'sto';

class AlignPanel {
  constructor(context, opts) {
    this.context = context;
    this.panel = null;
    this.pending = false;
    this.reference = null;
    this.reads = [];
    this.alignment = null;
    /*
     * The aligner's own output, kept because the view payload cannot be turned
     * back into it: saving needs the rows and each read's strand, rotation and
     * coverage, and those are consumed rather than carried by toViewPayload.
     */
    this.result = null;
    this.aligned = [];
    this.file = null;      // where this alignment was saved to, or opened from
    this.adopted = false;  // hosted by a custom editor rather than our own panel
    this.status = '';
    this.error = '';
    this.busy = false;
    this.nextId = 1;
    this.mafft = null; // {ok, path, version, message} once checked
    this.onDispose = (opts && opts.onDispose) || null;
  }

  /**
   * Look for MAFFT and remember what we found.
   *
   * Done when the panel opens rather than when Align is pressed: finding out
   * that the one dependency is missing after choosing files and waiting is a
   * waste of the user's time, and the fix may need a window reload.
   */
  async checkMafft() {
    this.mafft = await mafft.get(config.mafftPath());
    this.push(true);
    return this.mafft;
  }

  /** Ask for the binary and write it to settings. */
  async locateMafft() {
    const picked = await vscode.window.showOpenDialog({
      title: 'Locate the MAFFT executable',
      openLabel: 'Use this MAFFT',
      canSelectMany: false
    });
    if (!picked || !picked.length) return;

    const chosen = picked[0].fsPath;
    const res = await mafft.probe(chosen);
    if (!res.ok) {
      return this.fail(`That file ${res.reason}. MAFFT is usually at ` +
        '/opt/homebrew/bin/mafft, or <conda>/envs/<name>/bin/mafft.');
    }
    await vscode.workspace.getConfiguration('oven')
      .update('mafftPath', chosen, vscode.ConfigurationTarget.Global);
    mafft.invalidate();
    await this.checkMafft();
    this.note(`Using MAFFT ${res.version} at ${chosen}.`);
  }

  /** Open the panel, optionally adopting a plasmid as the reference. */
  async show(reference, column) {
    if (reference) this.setReference(reference);

    if (this.panel) {
      this.panel.reveal(column || this.panel.viewColumn, false);
      this.push(true);
      return this.panel;
    }

    return this.wire(vscode.window.createWebviewPanel(
      'oven.alignment',
      panelTitle(this.reference),
      /*
       * Beside, so the panel opens in its own group next to the plasmid rather
       * than as another tab on top of it.
       *
       * This was Active for one release. Splitting on its own leaves the editor
       * at half width, and since sequences open split themselves each of the
       * sequence and circular panes ends up at a quarter of the window. The fix
       * is not to stop splitting: it is to collapse the editor's own split when
       * a side panel opens, which the host asks for with panels/collapse.
       */
      { viewColumn: column || vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))]
      }
    ));
  }

  /**
   * Take over a webview panel and start driving it.
   *
   * Called with one we made ourselves, and with one VS Code made for a custom
   * editor -- resolveCustomEditor hands out the same WebviewPanel type, so a
   * saved alignment can open as a tab of its own with nothing here duplicated.
   */
  wire(panel) {
    this.panel = panel;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))]
    };

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (!msg) return;
      try {
        switch (msg.type) {
          case 'align/ready': this.push(true); this.checkMafft(); break;
          case 'align/locateMafft': await this.locateMafft(); break;
          case 'align/recheckMafft':
            mafft.invalidate();
            await this.checkMafft();
            this.note(this.mafft.ok
              ? `Found MAFFT ${this.mafft.version}.`
              : 'Still cannot find MAFFT.');
            break;
          case 'align/openSettings':
            vscode.commands.executeCommand('workbench.action.openSettings', 'oven.mafftPath');
            break;
          case 'align/browse': await this.browse(); break;
          case 'align/addUris': await this.addUris(msg.uris || []); break;
          case 'align/addBytes': await this.addBytes(msg.files || []); break;
          case 'align/addSequence': await this.addSequence(msg.name, msg.sequence); break;
          case 'align/pickReference': await this.pickReference(); break;
          case 'align/remove': this.remove(msg.id); break;
          case 'align/run': await this.run(); break;
          case 'align/save': await this.save(); break;
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
      if (this.onDispose) this.onDispose();
    });

    panel.webview.html = this.html(panel.webview);
    return panel;
  }

  setReference(ref) {
    // Pressing Align again on the same plasmid must not throw away the results
    // already on screen -- only a genuinely different reference invalidates them.
    if (this.reference && sameReference(this.reference, ref)) return;
    this.reference = ref;
    // The old alignment was against a different sequence, so it is now a lie.
    this.forget();
    this.reads.forEach((r) => { delete r.mismatches; });
    // A custom editor's tab is named after its file, which is the truth about
    // what is open; renaming it to the reference would hide that.
    if (this.panel && !this.adopted) this.panel.title = panelTitle(ref);
  }

  /* ------------------------------------------------------------ messaging -- */

  push(force) {
    if (!this.panel) return;
    if (!force && !this.panel.visible) {
      this.pending = true;
      return;
    }
    this.pending = false;
    this.panel.webview.postMessage({
      type: 'align/state',
      state: {
        reference: this.reference && {
          name: this.reference.name,
          length: this.reference.sequence.length,
          circular: Boolean(this.reference.circular)
        },
        reads: this.reads.map((r) => ({
          id: r.id, name: r.name, path: r.path, length: r.sequence ? r.sequence.length : 0,
          error: r.error || null,
          mismatches: r.mismatches, substitutions: r.substitutions, gaps: r.gaps,
          identity: r.identity, strand: r.strand, rotation: r.rotation,
          /*
           * Both drive the verdict shown in the panel. `compared` is how many
           * reference positions the read actually spoke to, which is what
           * separates a full match from a perfect window; `anchored` catches a
           * read that is a different sequence rather than a near miss.
           */
          compared: r.compared,
          anchored: r.anchored
        })),
        alignment: this.alignment,
        mafft: this.mafft && {
          ok: this.mafft.ok,
          path: this.mafft.path || null,
          version: this.mafft.version || null,
          message: this.mafft.message || null
        },
        status: this.status,
        error: this.error,
        busy: this.busy,
        // Only a completed alignment can be written out, and only the aligner's
        // own output is enough to write it -- see this.result.
        canSave: Boolean(this.result),
        file: this.file ? path.basename(this.file.fsPath) : null
      }
    });
  }

  /**
   * Drop the alignment and everything derived from it.
   *
   * Always together: `alignment` is what is drawn and `result` is what would be
   * saved, so leaving one behind would offer to write a file describing reads
   * that are no longer on screen. `file` stays -- it is where this alignment
   * came from, and saving again should still default there.
   */
  forget() {
    this.alignment = null;
    this.result = null;
    this.aligned = [];
  }

  fail(message) {
    this.busy = false;
    this.status = message;
    this.error = message;
    this.push(true);
    vscode.window.showErrorMessage(message);
  }

  note(message) {
    this.status = message;
    this.error = '';
    this.push(true);
  }

  /* --------------------------------------------------------- adding reads -- */

  async browse() {
    const picked = await vscode.window.showOpenDialog({
      title: 'Choose sequencing reads to align',
      openLabel: 'Add reads',
      canSelectMany: true,
      filters: { 'Sequence files': SEQUENCE_EXTENSIONS }
    });
    if (!picked || !picked.length) return;
    await this.addUris(picked.map((u) => u.toString()));
  }

  async pickReference() {
    const picked = await vscode.window.showOpenDialog({
      title: 'Choose a reference sequence',
      openLabel: 'Use as reference',
      canSelectMany: false,
      filters: { 'Sequence files': ['gb', 'gbk', 'fa', 'fasta', 'dna'] }
    });
    if (!picked || !picked.length) return;

    const uri = picked[0];
    const bytes = await vscode.workspace.fs.readFile(uri);
    const tracks = await parseFile(Buffer.from(bytes), path.basename(uri.fsPath));
    if (!tracks.length) return this.fail(`No sequence found in ${path.basename(uri.fsPath)}.`);

    this.setReference(Object.assign({ path: uri.fsPath }, tracks[0]));
    this.note(`Reference set to ${tracks[0].name}.`);
  }

  async addUris(uris) {
    const added = [];
    for (const raw of uris) {
      let uri;
      try {
        uri = raw.startsWith('file:') ? vscode.Uri.parse(raw) : vscode.Uri.file(raw);
      } catch {
        continue;
      }
      const name = path.basename(uri.fsPath);
      if (this.reads.some((r) => r.path === uri.fsPath)) continue;
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        added.push(...await this.ingest(Buffer.from(bytes), name, uri.fsPath));
      } catch (e) {
        // One bad file must not lose the rest of the batch.
        this.reads.push({ id: this.nextId++, name, path: uri.fsPath, error: shortError(e) });
      }
    }
    this.afterAdd(added.length);
  }

  async addBytes(files) {
    const added = [];
    for (const f of files) {
      if (this.reads.some((r) => !r.path && r.name === f.name)) continue;
      try {
        added.push(...await this.ingest(Buffer.from(f.base64, 'base64'), f.name, null));
      } catch (e) {
        this.reads.push({ id: this.nextId++, name: f.name, error: shortError(e) });
      }
    }
    this.afterAdd(added.length);
  }

  /*
   * A sequence typed or pasted into the panel rather than read from a file.
   *
   * Wrapped as FASTA and put through ingest, so it lands as the same kind of
   * entry a dropped file produces -- there is no second notion of a read to
   * keep in step with the first.
   */
  async addSequence(name, sequence) {
    /*
     * Whitespace and digits go: sequence is pasted out of all sorts of places
     * and often arrives in numbered blocks. Anything left that is not a base is
     * an error rather than something to strip silently, since quietly dropping
     * characters would change what is being aligned.
     */
    const bases = String(sequence || '').replace(/[\s\d]/g, '').toUpperCase();
    if (!bases) throw new Error('Enter a DNA sequence to add.');

    const bad = [...new Set(bases.replace(/[ACGTURYSWKMBDHVN]/g, ''))];
    if (bad.length) {
      throw new Error(`That is not DNA: ${bad.slice(0, 6).map((c) => `"${c}"`).join(', ')}`);
    }

    // sequence1, sequence2... counting only the ones added this way, and
    // skipping any number already taken so two adds never collide.
    let label = String(name || '').trim();
    if (!label) {
      let n = 1;
      while (this.reads.some((r) => r.name === `sequence${n}`)) n++;
      label = `sequence${n}`;
    }

    await this.ingest(Buffer.from(`>${label}\n${bases}\n`, 'utf8'), `${label}.fasta`, null);
    this.afterAdd(1);
  }

  /** Parse one file into read entries, trimming trace ends as configured. */
  async ingest(buffer, fileName, filePath) {
    const parsed = await parseFile(buffer, fileName);
    if (!parsed.length) throw new Error('no sequence found');

    const minQuality = config.alignTrimQuality();
    return parsed.map((track, record) => {
      const entry = Object.assign(
        /*
         * `record` and `trimQuality` are only ever read when saving, and both
         * have to be recorded here rather than worked out later: which record
         * of a multi-record FASTA this is cannot be recovered from the read,
         * and the trim threshold is whatever the setting said at the time,
         * which is not necessarily what it says now.
         */
        { id: this.nextId++, path: filePath, raw: track, record, trimQuality: minQuality },
        trimByQuality(track, minQuality)
      );
      this.reads.push(entry);
      return entry;
    });
  }

  /*
   * Reads are kept sorted by name so the chips and the alignment tracks are
   * always in the same order, and that order is the one the filenames imply --
   * numeric-aware, so read 2 comes before read 10.
   */
  sortReads() {
    this.reads.sort((a, b) =>
      String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }));
  }

  afterAdd(count) {
    this.sortReads();
    const max = config.alignMaxReads();
    let dropped = 0;
    if (this.reads.length > max) {
      dropped = this.reads.length - max;
      this.reads = this.reads.slice(0, max);
    }
    this.forget(); // the read set changed
    if (dropped) this.note(`Added ${count}; ignored ${dropped} over the ${max}-read limit.`);
    else if (count) this.note(`Added ${count} read${count === 1 ? '' : 's'}. Press Align.`);
    else this.push(true);
  }

  remove(id) {
    this.reads = this.reads.filter((r) => r.id !== id);
    this.forget();
    this.note(this.reads.length ? '' : 'All reads removed.');
  }

  /* ---------------------------------------------------------------- align -- */

  async run() {
    const usable = this.reads.filter((r) => !r.error && r.sequence);
    if (!this.reference) return this.fail('Choose a reference first.');
    if (!usable.length) return this.fail('Add at least one readable sequence.');

    this.busy = true;
    this.note(`Aligning ${usable.length} read${usable.length === 1 ? '' : 's'}…`);

    const started = Date.now();
    // Use the binary we actually verified, which may be somewhere PATH cannot
    // reach -- a conda environment, typically.
    const found = this.mafft && this.mafft.ok ? this.mafft : await this.checkMafft();
    if (!found.ok) {
      this.busy = false;
      return this.fail(found.message);
    }

    const result = await align(
      this.reference,
      usable.map((r) => ({ name: r.name, sequence: r.sequence })),
      { mafftPath: found.path, mafftArgs: config.mafftArgs() }
    );

    // Carry each read's own numbers back onto its chip.
    result.tracks.forEach((t, i) => Object.assign(usable[i], {
      mismatches: t.mismatches, substitutions: t.substitutions, gaps: t.gaps,
      identity: t.identity, strand: t.strand, rotation: t.rotation,
      compared: t.compared, anchored: t.anchored
    }));

    this.result = result;
    this.aligned = usable;
    this.alignment = this.toViewPayload(result, usable);
    this.busy = false;
    this.note(`Aligned ${usable.length} read${usable.length === 1 ? '' : 's'} in ${Date.now() - started} ms.`);
  }

  /* --------------------------------------------------------- saving -- */

  /**
   * The folders this alignment's sequences came from.
   *
   * Offered instead of a save dialog because they are where the file belongs:
   * an alignment is about a particular reference and a particular run of reads,
   * and those already live somewhere. Deduplicated, since reads usually share
   * one folder, and labelled with what came from each so two folders with the
   * same name are still told apart.
   */
  saveFolders() {
    const seen = new Map();
    const add = (file, what) => {
      if (!file) return;
      const dir = path.dirname(file);
      if (!seen.has(dir)) seen.set(dir, { dir, reference: false, reads: 0 });
      const entry = seen.get(dir);
      if (what === 'reference') entry.reference = true;
      else if (what === 'read') entry.reads++;
    };

    // Where it already is comes first: saving again is usually updating.
    if (this.file) add(this.file.fsPath, 'alignment');
    add(this.reference && this.reference.path, 'reference');
    for (const read of this.aligned) add(read.path, 'read');

    return [...seen.values()].map((entry) => {
      const parts = [];
      if (entry.reference) parts.push('reference');
      if (entry.reads) parts.push(`${entry.reads} read${entry.reads === 1 ? '' : 's'}`);
      if (this.file && path.dirname(this.file.fsPath) === entry.dir) parts.push('this alignment');
      return { dir: entry.dir, detail: parts.join(' · ') };
    });
  }

  /** Ask where to write, starting from the folders the sequences came from. */
  async chooseTarget() {
    const home = os.homedir();
    const short = (dir) => (dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir);

    const folders = this.saveFolders();
    const items = folders.map((f) => ({
      label: path.basename(f.dir) || f.dir,
      description: short(f.dir),
      detail: f.detail,
      dir: f.dir
    }));
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: 'Choose another folder…', dir: null });

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Save this alignment where?',
      matchOnDescription: true
    });
    if (!picked) return null;

    const suggested = this.file
      ? path.basename(this.file.fsPath)
      : `${today()}_alignment.${ALIGNMENT_EXTENSION}`;

    if (!picked.dir) {
      const chosen = await vscode.window.showSaveDialog({
        title: 'Save alignment',
        saveLabel: 'Save alignment',
        defaultUri: vscode.Uri.file(path.join(folders.length ? folders[0].dir : home, suggested)),
        filters: { 'Stockholm alignment': [ALIGNMENT_EXTENSION, 'stk'] }
      });
      // The dialog does its own overwrite confirmation.
      return chosen || null;
    }

    const name = await vscode.window.showInputBox({
      title: 'Name for the alignment file',
      value: suggested,
      // The extension is the interesting part to change, so leave it selectable
      // but put the cursor on the stem.
      valueSelection: [0, suggested.length - (ALIGNMENT_EXTENSION.length + 1)],
      validateInput: (v) => {
        const trimmed = String(v || '').trim();
        if (!trimmed) return 'Give the file a name.';
        if (/[\\/]/.test(trimmed)) return 'The folder is already chosen; this is just the file name.';
        return null;
      }
    });
    if (name === undefined) return null;

    let file = name.trim();
    if (!/\.(sto|stk|stockholm)$/i.test(file)) file += `.${ALIGNMENT_EXTENSION}`;
    const target = vscode.Uri.file(path.join(picked.dir, file));

    // Overwriting the file this alignment already is needs no confirming; any
    // other existing file does.
    if (!this.file || this.file.fsPath !== target.fsPath) {
      let exists = true;
      try {
        await vscode.workspace.fs.stat(target);
      } catch {
        exists = false;
      }
      if (exists) {
        const go = await vscode.window.showWarningMessage(
          `${file} already exists in ${path.basename(picked.dir)}.`,
          { modal: true }, 'Replace');
        if (go !== 'Replace') return null;
      }
    }
    return target;
  }

  /**
   * Write the alignment out.
   *
   * Both an absolute path and one relative to the file itself are recorded for
   * every sequence. The relative one is tried first on reopening, so moving or
   * copying a whole experiment folder -- which is what Dropbox does to a folder
   * shared with someone else -- keeps the alignment whole.
   */
  toFileText(target) {
    const dir = path.dirname(target.fsPath);
    const relative = (file) => {
      if (!file) return null;
      const rel = path.relative(dir, file);
      // A relative path that climbs out to the root and back down is longer
      // than the absolute one and no more portable, so it is not worth writing.
      return rel && !path.isAbsolute(rel) && rel.length < file.length ? rel : null;
    };

    return buildStockholm({
      reference: {
        name: this.reference.name,
        path: this.reference.path || null,
        rel: relative(this.reference.path),
        row: this.result.msa.reference,
        circular: Boolean(this.reference.circular)
      },
      reads: this.result.tracks.map((track, i) => {
        const read = this.aligned[i] || {};
        return {
          name: track.name,
          path: read.path || null,
          rel: relative(read.path),
          row: this.result.msa.rows[i].sequence,
          strand: track.strand,
          rotation: track.rotation,
          folded: track.crossesOrigin,
          anchored: track.anchored,
          covered: track.covered,
          deleted: track.deleted,
          readIndex: track.readIndex,
          trim: read.trimQuality || 0,
          record: read.record || 0
        };
      }),
      meta: {
        tool: `OVEN ${this.context.extension ? this.context.extension.packageJSON.version : ''}`.trim(),
        created: new Date().toISOString(),
        type: (this.alignment && this.alignment.alignmentType) || 'Sanger sequencing',
        mafftArgs: config.mafftArgs()
      }
    });
  }

  async save() {
    if (!this.result || !this.alignment) {
      return this.fail('There is no alignment to save yet — press Align first.');
    }
    const target = await this.chooseTarget();
    if (!target) return;

    await vscode.workspace.fs.writeFile(target, Buffer.from(this.toFileText(target), 'utf8'));
    this.file = target;
    this.note(`Saved ${path.basename(target.fsPath)}.`);
  }

  /* -------------------------------------------------------- reopening -- */

  /**
   * Read one sequence back off disk.
   *
   * The relative path is tried before the absolute one, so a folder that has
   * moved still resolves; the absolute path is the fallback for a file that
   * lives outside the tree the alignment was saved in. Whichever works is
   * written back onto the entry, so the panel goes on pointing at where the
   * file actually is.
   */
  async loadSource(entry, dir, trim) {
    const candidates = [entry.rel ? path.resolve(dir, entry.rel) : null, entry.path]
      .filter(Boolean);
    for (const candidate of candidates) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(candidate));
        const parsed = await parseFile(Buffer.from(bytes), path.basename(candidate));
        const track = parsed[entry.record || 0] || parsed[0];
        if (!track) continue;
        entry.path = candidate;
        // Trimmed exactly as it was when the alignment was made, whatever the
        // setting says now -- otherwise the bases would no longer match the row
        // and a file that has not changed would be reported as changed.
        return Object.assign({}, trim ? trimByQuality(track, trim) : track, { raw: track });
      } catch {
        // Try the next candidate; a source that cannot be read is reported by
        // rebuild(), which knows what was lost with it.
      }
    }
    return null;
  }

  /** Open a saved alignment: the rows from the file, everything else from the sources. */
  async restore(uri) {
    this.file = uri;
    this.note('Opening the alignment…');

    const bytes = await vscode.workspace.fs.readFile(uri);
    const spec = readAlignment(Buffer.from(bytes).toString('utf8'));
    const dir = path.dirname(uri.fsPath);

    const reference = await this.loadSource(spec.reference, dir, 0);
    const reads = [];
    for (const read of spec.reads) reads.push(await this.loadSource(read, dir, read.trim));

    const restored = rebuild(spec, { reference, reads });
    this.reference = restored.reference;
    this.reads = restored.reads.map((read, i) => {
      const track = restored.tracks[i];
      return Object.assign({ id: this.nextId++ }, read, {
        record: spec.reads[i].record,
        trimQuality: spec.reads[i].trim,
        mismatches: track.mismatches, substitutions: track.substitutions, gaps: track.gaps,
        identity: track.identity, strand: track.strand, rotation: track.rotation,
        compared: track.compared, anchored: track.anchored
      });
    });
    this.result = restored;
    this.aligned = this.reads;
    this.alignment = this.toViewPayload(restored, this.reads);

    const problems = restored.problems;
    if (!problems.length) {
      this.note(`${spec.reads.length} read${spec.reads.length === 1 ? '' : 's'} ` +
        `against ${this.reference.name}.`);
      return;
    }
    /*
     * Named, not counted. Which file is missing is the thing to act on, and the
     * alignment is still on screen either way -- the rows are in the file, so
     * what is lost is the annotations, the traces and the features, not the
     * alignment.
     */
    const named = problems.slice(0, 2).map((p) => `${p.name} ${p.reason}`).join('; ');
    this.fail(`${named}${problems.length > 2 ? `, and ${problems.length - 2} more` : ''}. ` +
      'Showing the saved sequences; their annotations and traces are unavailable.');
  }

  /**
   * Build what createAlignmentView wants.
   *
   * Two things here are easy to get wrong and invisible when wrong:
   * chromatogramData is a SIBLING of sequenceData on the track, not nested
   * inside it -- nested, the trace silently never draws. And the trace has to
   * be put through the same flip and rotation the aligner applied to the
   * sequence, or the peaks stop lining up with the letters below them.
   */
  toViewPayload(result, usable) {
    const refTrack = {
      sequenceData: Object.assign({}, this.reference.sequenceData, {
        name: this.reference.name,
        sequence: this.reference.sequence
      }),
      /*
       * The name belongs on alignmentData as well as sequenceData. OVE builds
       * the FASTA headers for a copy out of alignmentData.name, so leaving it
       * off produced ">undefined" for every track, and put "Copy Selection of
       * undefined" in the right-click menu.
       */
      alignmentData: { name: this.reference.name, sequence: result.msa.reference }
    };

    const readTracks = result.msa.rows.map((row, i) => {
      const read = usable[i];
      const track = result.tracks[i];
      /*
       * A substitution inside a CDS gets a translation over just that codon, in
       * the read's own coordinates. The viewer works the amino acid out from the
       * read's bases, so what appears is what the mutation actually codes for
       * rather than what the reference said -- which is the question you are
       * asking when you look at a mismatch in a coding region.
       */
      const translations = mutatedCodons(
        track.referenceRow, track.readRow,
        (this.reference.sequenceData && this.reference.sequenceData.features) || [],
        this.reference.sequence.length
      ).map((codon, n) => Object.assign({ id: `mut-${i}-${n}` }, codon));

      /*
       * Where this read actually reached, in the column space the view draws
       * in. Only a read folded across the origin has it: for every other read
       * the covered stretch runs from its first base to its last, which the
       * viewer already works out. Without it, the stretch such a read never
       * reached would be drawn as coverage and the sequence missing from the
       * clone would be drawn as never sequenced -- the wrong way round.
       */
      const toColumns = (ranges) => (ranges || []).map(([from, to]) => {
        const cols = [];
        let at = -1;
        for (let i = 0; i < result.msa.reference.length; i++) {
          if (result.msa.reference[i] !== '-') at++;
          const inside = from <= to ? (at >= from && at <= to) : (at >= from || at <= to);
          if (at >= 0 && inside) cols.push(i);
        }
        return cols;
      }).flatMap((cols) => {
        // A range that wraps the origin comes back as two runs of columns.
        const out = [];
        let start = null, prev = null;
        for (const c of cols) {
          if (start === null) { start = c; } else if (c !== prev + 1) { out.push([start, prev]); start = c; }
          prev = c;
        }
        if (start !== null) out.push([start, prev]);
        return out;
      });

      /*
       * A GenBank read's own features, moved to match the row. An .ab1 has
       * none, so this is empty for a Sanger read and costs nothing.
       *
       * They are the query's annotations, and the viewer draws them under the
       * same tickboxes as the reference's -- Query Annotations in the eye menu
       * turns the whole lot off without needing a second tickbox per kind.
       */
      const queryAnnotations = followAlignmentAnnotations(read.raw && read.raw.sequenceData, {
        strand: track.strand,
        readIndex: track.readIndex,
        length: (track.columnOrderSequence || track.sequence || '').length
      });

      return {
        sequenceData: Object.assign({}, queryAnnotations, {
          name: read.name,
          // Oriented and rotated to match the row -- and, for a read folded
          // across the origin, reordered to match it as well.
          sequence: track.columnOrderSequence || track.sequence,
          circular: false,
          translations,
          // Only a folded read has one: where each of those bases sits in the
          // read as sequenced, so the axis can go on numbering them as read
          // positions rather than counting along the row.
          ovenReadIndex: track.readIndex || undefined
        }),
        alignmentData: { name: read.name, sequence: row.sequence },
        ovenCoverage: track.covered
          ? { covered: toColumns(track.covered), deleted: toColumns(track.deleted) }
          : undefined,
        chromatogramData: followAlignment(read.chromatogramData, track) || undefined
      };
    });

    return {
      alignmentType: 'Sanger sequencing',
      tracks: [refTrack, ...readTracks]
    };
  }

  /* ----------------------------------------------------------------- html -- */

  html(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (name) =>
      webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', name)));

    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="${uri('ove.css')}" />
    <link rel="stylesheet" href="${uri('alignView.css')}" />
  </head>
  <body>
    <div class="ovealign-root">
      <div id="setup" class="ovealign-setup"></div>
      <div id="view" class="ovealign-view"></div>
    </div>
    <script nonce="${nonce}" src="${uri('index.umd.js')}"></script>
    <script nonce="${nonce}" src="${uri('cartShared.js')}"></script>
    <script nonce="${nonce}" src="${uri('alignView.js')}"></script>
  </body>
</html>`;
  }
}

function shortError(e) {
  const m = (e && e.message ? e.message : String(e)).trim();
  return m.length > 90 ? `${m.slice(0, 87)}…` : m;
}

/* --------------------------------------------------------- one per reference -- */

/**
 * Identity of a reference, for deciding which panel it belongs to.
 *
 * The file path when there is one, since two plasmids can share a name; the
 * name otherwise, for a reference picked out of a multi-record file. An
 * empty key is the panel opened from the command palette with nothing loaded.
 */
function referenceKey(ref) {
  if (!ref) return '';
  return ref.path ? `path:${ref.path}` : `name:${ref.name || ''}`;
}

function sameReference(a, b) {
  return Boolean(b) && referenceKey(a) === referenceKey(b);
}

/**
 * Today, as YYYY-MM-DD.
 *
 * Local rather than UTC: the date on an alignment is the day the work was done,
 * and an evening's saving would otherwise be filed under tomorrow.
 */
function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function panelTitle(ref) {
  const name = ref && ref.name;
  return name ? `Alignment · ${name}` : 'Alignment';
}

/** Hands out one AlignPanel per reference, and keeps them off each other's state. */
class AlignPanels {
  constructor(context) {
    this.context = context;
    this.byKey = new Map();

    // A path change can turn a broken setup into a working one, so re-check
    // rather than leaving a stale banner up -- in every open panel, since they
    // all share the one MAFFT.
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('oven.mafftPath')) return;
        mafft.invalidate();
        for (const panel of this.byKey.values()) panel.checkMafft();
      })
    );
  }

  /** The AlignPanel for this reference, created if there is not one yet. */
  panelFor(reference) {
    const key = referenceKey(reference);
    let panel = this.byKey.get(key);
    if (!panel) {
      panel = new AlignPanel(this.context, { onDispose: () => this.byKey.delete(key) });
      this.byKey.set(key, panel);
    }
    return panel;
  }

  /** The panel for this reference, opening one if it is not already up. */
  show(reference, column) {
    return this.panelFor(reference).show(reference, column);
  }

  /**
   * Drive a saved alignment opened as an editor tab.
   *
   * Keyed by the file rather than by a reference, so opening two saved
   * alignments of the same plasmid gives two tabs, and so pressing Align on a
   * plasmid never lands in a tab that belongs to a file on disk. Registered
   * with the rest all the same: that is what lets the Explorer's Add to
   * Alignment target a saved alignment you are looking at.
   */
  adopt(webviewPanel, uri) {
    const key = `file:${uri.fsPath}`;
    const existing = this.byKey.get(key);
    if (existing) existing.forget();
    const panel = new AlignPanel(this.context, { onDispose: () => this.byKey.delete(key) });
    panel.adopted = true;
    this.byKey.set(key, panel);
    panel.wire(webviewPanel);
    return panel;
  }

  /**
   * Add files to an alignment from outside the webview.
   *
   * This is the route the Explorer's context menu uses, and it exists because
   * dragging cannot be relied on: the workbench puts its own drop overlay over
   * the editor area the moment a drag enters the window over any chrome, and
   * that overlay opens the file in a new tab instead of letting the webview
   * see it. Holding Shift dismisses the overlay, but that is a thing to know
   * rather than a thing that works.
   */
  async addFiles(uris) {
    if (!uris || !uris.length) return;
    const panels = [...this.byKey.values()];

    // The one being looked at wins; then a lone panel; then ask. A panel with
    // no webview yet (disposed and not reopened) is not a candidate.
    let target = panels.find((p) => p.panel && p.panel.active)
      || panels.find((p) => p.panel && p.panel.visible);
    if (!target && panels.length === 1) target = panels[0];
    if (!target && panels.length > 1) {
      const picked = await vscode.window.showQuickPick(
        panels.map((p) => ({ label: panelTitle(p.reference), panel: p })),
        { title: 'Add to which alignment?' });
      if (!picked) return;
      target = picked.panel;
    }
    if (!target) target = this.panelFor(null);

    // Reveal without stealing focus: the point is the reads landing, and the
    // Explorer selection is often still being worked through.
    await target.show(target.reference);
    await target.addUris(uris.map((u) => u.toString()));
  }

  /**
   * Locate MAFFT and tell every open panel about it.
   *
   * Reached from the notification action, which belongs to no panel in
   * particular, so it needs one that exists -- any of them will do the lookup.
   */
  async locateMafft() {
    const panels = [...this.byKey.values()];
    const first = panels[0] || new AlignPanel(this.context);
    await first.locateMafft();
    await Promise.all(panels.slice(1).map((p) => p.checkMafft()));
  }
}

module.exports = { AlignPanel, AlignPanels, referenceKey, panelTitle };
