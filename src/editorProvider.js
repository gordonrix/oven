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
const { buildEditorHtml } = require('./editorHtml');

const SEARCH_COLS_KEY = 'oveCart.searchColumnWidths';

/**
 * Ask for an inventory file and store it in user settings.
 *
 * Shared by the in-overlay "Choose file…" button and the
 * oveCart.pickInventoryFile command, so both paths behave identically.
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
  await vscode.workspace.getConfiguration('oveCart')
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
  constructor(context, cart, cartPanel) {
    this.context = context;
    this.cart = cart;
    this.cartPanel = cartPanel;
  }

  async openCustomDocument(uri) {
    return { uri, dispose: () => {} };
  }

  mediaUri(webview, name) {
    return webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', name)));
  }

  async resolveCustomEditor(document, webviewPanel) {
    const webview = webviewPanel.webview;
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
    } else if (ext === '.dna') {
      const buffer = await vscode.workspace.fs.readFile(document.uri);
      const out = await snapgeneToJson(buffer, { fileName: sourceName });
      parsed = out[0].parsedSequence;
      snapgeneRawBlocks = parsed._snapgeneRawBlocks || null;
      delete parsed._snapgeneRawBlocks; // large binary blobs must not cross into the webview
    }

    function toFileBytes(newJsonData) {
      if (ext === '.dna') {
        return jsonToSnapgene(Object.assign({}, newJsonData, { _snapgeneRawBlocks: snapgeneRawBlocks }));
      }
      if (ext === '.gb' || ext === '.gbk') return Buffer.from(jsonToGenbank(newJsonData));
      if (ext === '.fa' || ext === '.fasta') return Buffer.from(jsonToFasta(newJsonData));
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

      if (message.type === 'cart/requestState') {
        pushCartState();
        return;
      }

      if (message.type === 'cart/showPanel') {
        this.cartPanel.show();
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
              ? `Cart is full (${res.limit} primers). Raise oveCart.maxItems or clear some entries.`
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
      pickerUri: this.mediaUri(webview, 'cartPicker.js'),
      searchUri: this.mediaUri(webview, 'primerSearch.js'),
      selTmUri: this.mediaUri(webview, 'selectionTm.js'),
      strandUri: this.mediaUri(webview, 'strandBar.js'),
      sequenceJson: JSON.stringify(parsed || { sequence: '' }),
      viewType: config.viewType(),
      readOnly: config.readOnly(),
      disableBpEditing: !config.allowSequenceEditing(),
      autoAddCreatedPrimers: config.autoAddCreatedPrimers(),
      showSelectionStats: config.showSelectionStatsByDefault(),
      useDesignTm: config.useDesignTmCalculation()
    });
  }
}

module.exports = { DNAViewerProvider, pickInventoryFile };
