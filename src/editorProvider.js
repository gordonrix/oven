/* Custom editor provider: parses a plasmid file, hosts OVE, saves it back. */
'use strict';

const path = require('path');
const vscode = require('vscode');

const {
  genbankToJson, fastaToJson, snapgeneToJson,
  jsonToSnapgene, jsonToGenbank, jsonToFasta
} = require('../media/bioparser2.umd.js');

const config = require('./config');
const inventory = require('./inventory');
const shared = require('../media/cartShared.js');
const { buildEditorHtml } = require('./editorHtml');

const SEARCH_COLS_KEY = 'oven.searchColumnWidths';
const SEARCH_SHOWN_KEY = 'oven.searchColumns';
/*
 * The Filter Cut Sites selection. globalState rather than workspaceState: which
 * enzymes someone works with follows them between projects, the same reasoning
 * as the cart.
 */
const CUT_SITES_KEY = 'oven.cutSiteFilter';

/**
 * Ask for an inventory file and store it in user settings.
 *
 * Shared by the in-overlay "Choose file…" button and the
 * oven.pickInventoryFile command, so both paths behave identically.
 */
async function pickInventoryFile() {
  const picked = await vscode.window.showOpenDialog({
    title: 'Choose a primer inventory',
    openLabel: 'Use this inventory',
    canSelectMany: false,
    filters: { 'Primer inventory': ['xlsx', 'xlsm', 'csv', 'tsv', 'txt'] }
  });
  if (!picked || !picked.length) return null;

  const file = picked[0].fsPath;
  await vscode.workspace.getConfiguration('oven')
    .update('inventoryPath', file, vscode.ConfigurationTarget.Global);
  inventory.invalidate();

  const inv = inventory.load();
  if (inv.status === 'ok') {
    vscode.window.showInformationMessage(
      `Primer inventory set: ${inv.rowCount} primers from ${path.basename(file)}.`);
  } else {
    vscode.window.showWarningMessage(`Primer inventory: ${inv.message || inv.status}`);
  }
  return file;
}

class DNAViewerProvider {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {import('./cartStore').CartStore} cart
   */
  constructor(context, cart, cartPanel, alignPanel, seqSearchPanel) {
    this.context = context;
    this.cart = cart;
    this.cartPanel = cartPanel;
    this.alignPanel = alignPanel;
    this.seqSearchPanel = seqSearchPanel;
  }

  async openCustomDocument(uri) {
    return { uri, dispose: () => {} };
  }

  mediaUri(webview, name) {
    return webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', name)));
  }

  async resolveCustomEditor(document, webviewPanel) {
    const webview = webviewPanel.webview;

    /*
     * Track the open editors, so a Sequence Search hit can select its range in
     * one that is already up rather than reopening the file. Keyed by path
     * because that is all the panel knows about a hit.
     */
    DNAViewerProvider.live.set(document.uri.fsPath, webviewPanel);
    webviewPanel.onDidDispose(() => {
      if (DNAViewerProvider.live.get(document.uri.fsPath) === webviewPanel) {
        DNAViewerProvider.live.delete(document.uri.fsPath);
      }
    });
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))]
    };

    const ext = path.extname(document.uri.fsPath.toLowerCase().trim());
    const sourceName = path.parse(path.basename(document.uri.fsPath)).name.trim();

    let parsed;
    let snapgeneRawBlocks = null; // preserved so a .dna roundtrip stays lossless

    if (ext === '.gb' || ext === '.gbk') {
      const doc = await vscode.workspace.openTextDocument(document.uri);
      parsed = genbankToJson(doc.getText())[0].parsedSequence;
    } else if (ext === '.fa' || ext === '.fasta') {
      const doc = await vscode.workspace.openTextDocument(document.uri);
      parsed = fastaToJson(doc.getText())[0].parsedSequence;
    } else if (ext === '.ab1') {
      /*
       * A trace file, opened to be looked at rather than edited.
       *
       * The reader is the aligner's, so a trace opens here exactly as it would
       * as an alignment track -- same quality-smoothed, per-base chromatogram.
       * It is required here rather than at the top of the file: everything in
       * this tree ends up importing alignTracks, and a top-level require pulls
       * the parser bundle into every test that loads this module.
       *
       * chromatogramData rides on sequenceData, which is where the editor looks
       * for it and what it keeps in step when the sequence is edited.
       */
      const { parseFile } = require('./alignTracks');
      const buffer = await vscode.workspace.fs.readFile(document.uri);
      const tracks = await parseFile(Buffer.from(buffer), path.basename(document.uri.fsPath));
      if (!tracks.length) throw new Error('No sequence found in this trace file.');
      parsed = Object.assign({}, tracks[0].sequenceData, {
        name: tracks[0].name,
        sequence: tracks[0].sequence,
        circular: false,
        chromatogramData: tracks[0].chromatogramData || undefined
      });
    } else if (ext === '.dna') {
      const buffer = await vscode.workspace.fs.readFile(document.uri);
      const out = await snapgeneToJson(buffer, { fileName: sourceName });
      parsed = out[0].parsedSequence;
      snapgeneRawBlocks = parsed._snapgeneRawBlocks || null;
      delete parsed._snapgeneRawBlocks; // large binary blobs must not cross into the webview
    }

    /*
     * An origin-spanning join() arrives described twice -- as a wrapped
     * start/end and as a locations array holding the same two halves -- and
     * OVE draws both, so the feature appears doubled and offset in every row.
     * Drop the redundant half before it reaches the editor. Only saved back to
     * disk through jsonToGenbank, which re-derives the join from start/end.
     */
    if (parsed) shared.dropRedundantWrapLocations(parsed);

    function toFileBytes(newJsonData) {
      // Undo the display-only strip above, so what lands on disk is spelled
      // exactly the way the parser found it -- join(4113..4130,1..17), not the
      // non-standard "4113..17" the writer falls back to without locations.
      shared.restoreWrapLocations(newJsonData);
      if (ext === '.dna') {
        return jsonToSnapgene(Object.assign({}, newJsonData, { _snapgeneRawBlocks: snapgeneRawBlocks }));
      }
      if (ext === '.gb' || ext === '.gbk') return Buffer.from(jsonToGenbank(newJsonData));
      if (ext === '.fa' || ext === '.fasta') return Buffer.from(jsonToFasta(newJsonData));
      // .ab1 falls through deliberately: no writer exists, and the editor is
      // read-only for one, so nothing should be asking.
      return null;
    }

    // Same hidden-webview caveat as the sidebar: postMessage to a webview that
    // is not currently visible is dropped, so a badge updated while this tab
    // was in the background would be stale on return. Defer instead.
    let pendingCartPush = false;
    const pushCartState = () => {
      if (!webviewPanel.visible) {
        pendingCartPush = true;
        return;
      }
      pendingCartPush = false;
      webview.postMessage({
        type: 'cart/state',
        count: this.cart.items().length,
        inCart: this.cart.keys()
      });
    };

    /*
     * Fold the editor's sequence/circular split into one group.
     *
     * Sent just before a side panel opens beside this editor: that panel takes
     * half the window, and halving an already-split editor leaves each pane at a
     * quarter. The webview does the folding, since panelsShown is its state.
     */
    const collapsePanels = () => webview.postMessage({ type: 'panels/collapse' });

    webview.onDidReceiveMessage(async (message) => {
      if (!message) return;

      if (message.type === 'save') {
        try {
          await vscode.workspace.fs.writeFile(document.uri, toFileBytes(message.data));
          vscode.window.showInformationMessage(`Saved: ${path.basename(document.uri.fsPath)}`);
        } catch (e) {
          vscode.window.showErrorMessage(`Save failed: ${e.message}`);
        }
        return;
      }

      if (message.type === 'cart/openPanel') {
        collapsePanels();
        this.cartPanel.show();
        return;
      }

      if (message.type === 'cart/requestState') {
        pushCartState();
        return;
      }

      if (message.type === 'cart/showPanel') {
        collapsePanels();
        this.cartPanel.show();
        return;
      }

      if (message.type === 'seqsearch/open') {
        collapsePanels();
        if (this.seqSearchPanel) this.seqSearchPanel.show();
        return;
      }

      if (message.type === 'editor/ready') {
        const waiting = DNAViewerProvider.pendingReveal.get(document.uri.fsPath);
        if (waiting) {
          DNAViewerProvider.pendingReveal.delete(document.uri.fsPath);
          webview.postMessage({ type: 'select/range', range: waiting });
        }
        return;
      }

      if (message.type === 'align/open') {
        collapsePanels();
        // The plasmid on screen becomes the reference. Its sequence comes from
        // our own parse rather than the editor's state, so an unsaved base edit
        // cannot silently become the thing everything is measured against.
        this.alignPanel.show({
          name: (parsed && parsed.name) || sourceName,
          sequence: (parsed && parsed.sequence) || '',
          circular: Boolean(parsed && parsed.circular),
          sequenceData: parsed,
          path: document.uri.fsPath
        });
        return;
      }

      if (message.type === 'search/run') {
        // The webview supplies the sequence rather than the host reusing its
        // open-time parse, so a search can never run against a stale template.
        const res = inventory.searchSequence(message.sequence, message.circular, {
          minAnneal: config.searchMinAnneal(),
          maxHits: config.searchMaxHits(),
          selection: message.selection || null
        });
        webview.postMessage({
          type: 'search/results',
          scoped: Boolean(message.selection),
          selection: message.selection || null,
          fullLengthOnly: config.searchFullLengthOnly(),
          columnWidths: this.context.globalState.get(SEARCH_COLS_KEY, null),
          columns: this.context.globalState.get(SEARCH_SHOWN_KEY, null),
          hits: res.hits,
          inventory: res.inventory,
          tookMs: res.tookMs,
          scanned: res.scanned,
          skipped: res.skipped,
          truncated: res.truncated
        });
        return;
      }

      // Column widths live in globalState so a layout the user has tuned
      // survives closing the file, rather than resetting on every open.
      if (message.type === 'search/setColumnWidths') {
        await this.context.globalState.update(SEARCH_COLS_KEY, message.widths || null);
        return;
      }

      // Which columns are shown, kept beside their widths. null means "no
      // preference", which is not the same as "none": it lets the default keep
      // depending on the inventory file.
      if (message.type === 'search/setColumns') {
        await this.context.globalState.update(SEARCH_SHOWN_KEY, message.columns || null);
        return;
      }

      if (message.type === 'cutsites/save') {
        await this.context.globalState.update(CUT_SITES_KEY, message.filter || null);
        return;
      }

      if (message.type === 'search/pickInventory') {
        await pickInventoryFile();
        webview.postMessage({ type: 'search/inventoryChanged', inventory: inventory.load().status });
        return;
      }

      if (message.type === 'cart/add') {
        try {
          const entries = (message.items || []).map((it) => Object.assign({}, it, {
            sourcePath: document.uri.fsPath,
            sourceName,
            origin: message.origin || 'existing'
          }));
          const res = await this.cart.add(entries, config.maxItems());
          webview.postMessage({
            type: 'cart/ack',
            added: res.added,
            duplicates: res.duplicates,
            error: res.refused
              ? `Cart is full (${res.limit} primers). Raise oven.maxItems or clear some entries.`
              : null
          });
          pushCartState();
        } catch (e) {
          webview.postMessage({ type: 'cart/ack', added: 0, duplicates: 0, error: e.message });
        }
      }
    });

    // Keep the button badge in step when the cart changes from the sidebar.
    const sub = this.cart.onDidChange(() => pushCartState());
    const visSub = webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.visible && pendingCartPush) pushCartState();
    });
    webviewPanel.onDidDispose(() => {
      sub.dispose();
      visSub.dispose();
    });

    webview.html = buildEditorHtml({
      styleUri: this.mediaUri(webview, 'ove.css'),
      cartCssUri: this.mediaUri(webview, 'cartPicker.css'),
      searchCssUri: this.mediaUri(webview, 'primerSearch.css'),
      strandCssUri: this.mediaUri(webview, 'strandBar.css'),
      scriptUri: this.mediaUri(webview, 'index.umd.js'),
      sharedUri: this.mediaUri(webview, 'cartShared.js'),
      panelLayoutUri: this.mediaUri(webview, 'panelLayout.js'),
      pickerUri: this.mediaUri(webview, 'cartPicker.js'),
      searchUri: this.mediaUri(webview, 'primerSearch.js'),
      strandUri: this.mediaUri(webview, 'strandBar.js'),
      toolBtnsUri: this.mediaUri(webview, 'toolButtons.js'),
      cutSitesUri: this.mediaUri(webview, 'cutSites.js'),
      codonUsageUri: this.mediaUri(webview, 'codonUsage.js'),
      codonEditUri: this.mediaUri(webview, 'codonEdit.js'),
      aminoAcidUri: this.mediaUri(webview, 'aminoAcid.js'),
      aminoAcidCssUri: this.mediaUri(webview, 'aminoAcid.css'),
      newPrimerUri: this.mediaUri(webview, 'newPrimer.js'),
      newPrimerCssUri: this.mediaUri(webview, 'newPrimer.css'),
      newPrimerHotkey: config.newPrimerHotkey(),
      searchPrimersHotkey: config.searchPrimersHotkey(),
      alignHotkey: config.alignHotkey(),
      cartHotkey: config.cartHotkey(),
      rowViewCssUri: this.mediaUri(webview, 'rowView.css'),
      cutSiteFilter: this.context.globalState.get(CUT_SITES_KEY, null),
      sequenceJson: JSON.stringify(parsed || { sequence: '' }),
      viewType: DNAViewerProvider.takeViewType(document.uri.fsPath),
      // Which map the editor opens on: a linear sequence drawn as a circle with
      // a gap is a confusing way to meet it.
      circular: Boolean(parsed && parsed.circular),
      /*
       * A trace is always read-only. There is no .ab1 writer and there should
       * not be one: it is the instrument's record of a run, not a document.
       */
      readOnly: config.readOnly() || ext === '.ab1',
      // Or a trace file opens with its trace switched off.
      showChromatogram: ext === '.ab1',
      disableBpEditing: !config.allowSequenceEditing(),
      autoAddCreatedPrimers: config.autoAddCreatedPrimers(),
      showSelectionStats: config.showSelectionStatsByDefault()
    });
  }
}

/*
 * Editors currently on screen, by file path. Static because the reveal command
 * is registered once at activation and has no instance to ask.
 */
DNAViewerProvider.live = new Map();

/**
 * Open a map with a range selected.
 *
 * An editor already showing the file is told to select; otherwise the file is
 * opened and told once its webview reports for duty. Reopening a file that is
 * already open would throw away an unsaved edit, so the two cases are not
 * collapsed into one.
 */
DNAViewerProvider.revealRange = async (file, range) => {
  const open = DNAViewerProvider.live.get(file);
  if (open) {
    open.reveal(open.viewColumn, false);
    open.webview.postMessage({ type: 'select/range', range });
    return;
  }
  DNAViewerProvider.pendingReveal.set(file, range);
  DNAViewerProvider.pendingViewType.set(file, 'sequence');
  try {
    await vscode.commands.executeCommand(
      'vscode.openWith', vscode.Uri.file(file), 'oven.editor', vscode.ViewColumn.One
    );
  } catch (e) {
    DNAViewerProvider.pendingReveal.delete(file);
    DNAViewerProvider.pendingViewType.delete(file);
    vscode.window.showErrorMessage(`Could not open ${file}: ${e.message}`);
  }
};

/*
 * A file opened from a search hit comes up as the sequence alone.
 *
 * You arrived looking at a particular stretch of bases, and the usual split
 * hands half the width to a circular map that cannot show you the hit. The
 * override lasts for that one open -- the oven.viewType setting is what every
 * other way of opening the file still gets.
 */
DNAViewerProvider.pendingViewType = new Map();

DNAViewerProvider.takeViewType = (fsPath) => {
  const forced = DNAViewerProvider.pendingViewType.get(fsPath);
  if (!forced) return config.viewType();
  DNAViewerProvider.pendingViewType.delete(fsPath);
  return forced;
};

/* A range waiting for its editor to finish mounting. */
DNAViewerProvider.pendingReveal = new Map();

module.exports = { DNAViewerProvider, pickInventoryFile };
