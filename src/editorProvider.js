/* Custom editor provider: parses a plasmid file, hosts OVE, saves it back. */
'use strict';

const path = require('path');
const vscode = require('vscode');

const {
  genbankToJson, fastaToJson, snapgeneToJson,
  jsonToSnapgene, jsonToGenbank, jsonToFasta
} = require('../media/bioparser2.umd.js');

const config = require('./config');
const { buildEditorHtml } = require('./editorHtml');

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
      scriptUri: this.mediaUri(webview, 'index.umd.js'),
      sharedUri: this.mediaUri(webview, 'cartShared.js'),
      pickerUri: this.mediaUri(webview, 'cartPicker.js'),
      sequenceJson: JSON.stringify(parsed || { sequence: '' }),
      viewType: config.viewType(),
      readOnly: config.readOnly(),
      disableBpEditing: !config.allowSequenceEditing(),
      autoAddCreatedPrimers: config.autoAddCreatedPrimers()
    });
  }
}

module.exports = { DNAViewerProvider };
