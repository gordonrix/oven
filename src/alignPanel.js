/*
 * The Alignment panel.
 *
 * A singleton webview panel opened from the Align button in a plasmid editor,
 * modelled on cartPanel.js -- including its two hard-won habits: register the
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
const path = require('path');
const vscode = require('vscode');

const config = require('./config');
const mafft = require('./mafft');
const { align } = require('./align');
const { parseFile, trimByQuality, followAlignment, SEQUENCE_EXTENSIONS } = require('./alignTracks');

class AlignPanel {
  constructor(context) {
    this.context = context;
    this.panel = null;
    this.pending = false;
    this.reference = null;
    this.reads = [];
    this.alignment = null;
    this.status = '';
    this.error = '';
    this.busy = false;
    this.nextId = 1;
    this.mafft = null; // {ok, path, version, message} once checked

    // A path change can turn a broken setup into a working one, so re-check
    // rather than leaving a stale banner up.
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('oveCart.mafftPath')) {
          mafft.invalidate();
          this.checkMafft();
        }
      })
    );
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
    await vscode.workspace.getConfiguration('oveCart')
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

    const panel = vscode.window.createWebviewPanel(
      'oveCart.alignment',
      'Alignment',
      { viewColumn: column || vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))]
      }
    );
    this.panel = panel;

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
            vscode.commands.executeCommand('workbench.action.openSettings', 'oveCart.mafftPath');
            break;
          case 'align/browse': await this.browse(); break;
          case 'align/addUris': await this.addUris(msg.uris || []); break;
          case 'align/addBytes': await this.addBytes(msg.files || []); break;
          case 'align/pickReference': await this.pickReference(); break;
          case 'align/remove': this.remove(msg.id); break;
          case 'align/run': await this.run(); break;
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
      if (this.panel === panel) this.panel = null;
    });

    panel.webview.html = this.html(panel.webview);
    return panel;
  }

  setReference(ref) {
    this.reference = ref;
    // The old alignment was against a different sequence, so it is now a lie.
    this.alignment = null;
    this.reads.forEach((r) => { delete r.mismatches; });
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
          identity: r.identity, strand: r.strand, rotation: r.rotation
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
        busy: this.busy
      }
    });
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

  /** Parse one file into read entries, trimming trace ends as configured. */
  async ingest(buffer, fileName, filePath) {
    const parsed = await parseFile(buffer, fileName);
    if (!parsed.length) throw new Error('no sequence found');

    const minQuality = config.alignTrimQuality();
    return parsed.map((track) => {
      const entry = Object.assign(
        { id: this.nextId++, path: filePath, raw: track },
        trimByQuality(track, minQuality)
      );
      this.reads.push(entry);
      return entry;
    });
  }

  afterAdd(count) {
    const max = config.alignMaxReads();
    let dropped = 0;
    if (this.reads.length > max) {
      dropped = this.reads.length - max;
      this.reads = this.reads.slice(0, max);
    }
    this.alignment = null; // the read set changed
    if (dropped) this.note(`Added ${count}; ignored ${dropped} over the ${max}-read limit.`);
    else if (count) this.note(`Added ${count} read${count === 1 ? '' : 's'}. Press Align.`);
    else this.push(true);
  }

  remove(id) {
    this.reads = this.reads.filter((r) => r.id !== id);
    this.alignment = null;
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
      identity: t.identity, strand: t.strand, rotation: t.rotation
    }));

    this.alignment = this.toViewPayload(result, usable);
    this.busy = false;
    this.note(`Aligned ${usable.length} read${usable.length === 1 ? '' : 's'} in ${Date.now() - started} ms.`);
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
      alignmentData: { sequence: result.msa.reference }
    };

    const readTracks = result.msa.rows.map((row, i) => {
      const read = usable[i];
      const track = result.tracks[i];
      return {
        sequenceData: {
          name: read.name,
          sequence: track.sequence, // oriented and rotated, matching the row
          circular: false
        },
        alignmentData: { sequence: row.sequence },
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
    <script nonce="${nonce}" src="${uri('alignView.js')}"></script>
  </body>
</html>`;
  }
}

function shortError(e) {
  const m = (e && e.message ? e.message : String(e)).trim();
  return m.length > 90 ? `${m.slice(0, 87)}…` : m;
}

module.exports = { AlignPanel };
