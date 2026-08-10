/* The Primer Cart sidebar: a webview view listing everything in the cart. */
'use strict';

const crypto = require('crypto');
const path = require('path');
const vscode = require('vscode');

const config = require('./config');
const formats = require('./formats');
const inventory = require('./inventory');

class CartViewProvider {
  constructor(context, cart) {
    this.context = context;
    this.cart = cart;
    this.view = null;
    this.pending = false;

    context.subscriptions.push(cart.onDidChange(() => this.push()));
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('oveCart.inventoryPath') ||
            e.affectsConfiguration('oveCart.inventorySheet') ||
            e.affectsConfiguration('oveCart.inventoryNameColumn') ||
            e.affectsConfiguration('oveCart.inventorySequenceColumn')) {
          inventory.invalidate();
          this.push();
        }
      })
    );
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))]
    };

    // The message handler must be registered BEFORE webview.html is assigned.
    // Assigning html runs the panel script synchronously, and it posts
    // cart/ready straight away; with no listener attached yet that message is
    // dropped and the panel never gets its initial state.
    webview.onDidReceiveMessage(async (msg) => {
      if (!msg) return;
      switch (msg.type) {
        case 'cart/ready': this.push(); break;
        case 'cart/remove': await this.remove(msg.ids || []); break;
        case 'cart/clear': await this.clearCart(); break;
        case 'cart/copyTsv': await this.copy(msg.ids, 'tsv'); break;
        case 'cart/copySeqs': await this.copy(msg.ids, 'seqs'); break;
        case 'cart/exportCsv': await this.exportCsv(msg.ids); break;
        case 'cart/rename': await this.cart.rename(msg.id, msg.name); break;
        case 'cart/note': await this.cart.setNote(msg.id, msg.note); break;
        case 'cart/openSource': await this.openSource(msg.id); break;
        case 'cart/refreshInventory': this.refreshInventory(); break;
        case 'cart/openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', 'oveCart.inventoryPath');
          break;
        default: break;
      }
    });

    // A hidden webview view silently discards postMessage -- retainContextWhenHidden
    // preserves its DOM but does not queue messages. Without this, every cart
    // change made while the panel was collapsed was lost, and reopening the
    // panel showed a stale snapshot rather than the real cart.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.pending) this.push();
    });

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = null;
    });

    webview.html = this.html(webview);
  }

  /** Current cart plus inventory annotations, pushed to the view wholesale. */
  push() {
    if (!this.view) return;
    if (!this.view.visible) {
      this.pending = true; // deliver when the panel comes back into view
      return;
    }
    this.pending = false;
    const { items, inventory: inv } = inventory.annotate(this.cart.items());
    this.view.webview.postMessage({ type: 'cart/state', items, inventory: inv });
  }

  /** Resolve an id list to items; an empty selection means "everything". */
  resolve(ids) {
    const { items } = inventory.annotate(this.cart.items());
    if (!ids || !ids.length) return items;
    const want = new Set(ids);
    return items.filter((it) => want.has(it.id));
  }

  async copy(ids, kind) {
    const items = this.resolve(ids);
    if (!items.length) {
      vscode.window.showInformationMessage('Primer cart is empty.');
      return;
    }
    const text = kind === 'seqs'
      ? formats.toSequenceList(items, config.sequenceCopyIncludesName())
      : formats.toTsv(items);
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(
      `Copied ${items.length} primer${items.length === 1 ? '' : 's'} to the clipboard.`
    );
  }

  async exportCsv(ids) {
    const items = this.resolve(ids);
    if (!items.length) {
      vscode.window.showInformationMessage('Primer cart is empty.');
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const target = await vscode.window.showSaveDialog({
      saveLabel: 'Export primer cart',
      filters: { 'CSV file': ['csv'] },
      defaultUri: vscode.Uri.file(path.join(defaultDir(), `primer-cart-${stamp}.csv`))
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(formats.toCsv(items), 'utf8'));
    vscode.window.showInformationMessage(`Exported ${items.length} primers to ${path.basename(target.fsPath)}.`);
  }

  async remove(ids) {
    if (!ids.length) return;
    const answer = await vscode.window.showWarningMessage(
      `Remove ${ids.length} primer${ids.length === 1 ? '' : 's'} from the cart?`,
      { modal: true },
      'Remove'
    );
    if (answer !== 'Remove') return;
    await this.cart.remove(ids);
  }

  async clearCart() {
    const n = this.cart.items().length;
    if (!n) return;
    const answer = await vscode.window.showWarningMessage(
      `Clear all ${n} primers from the cart?`,
      { modal: true },
      'Clear'
    );
    if (answer !== 'Clear') return;
    await this.cart.clear();
  }

  async openSource(id) {
    const item = this.cart.items().find((it) => it.id === id);
    if (!item || !item.sourcePath) return;
    try {
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(item.sourcePath), 'oveCart.editor');
    } catch (e) {
      vscode.window.showErrorMessage(`Could not open ${item.sourcePath}: ${e.message}`);
    }
  }

  refreshInventory() {
    inventory.invalidate();
    this.push();
    const inv = inventory.load();
    if (inv.status === 'ok') {
      vscode.window.showInformationMessage(`Primer inventory reloaded: ${inv.rowCount} primers.`);
    } else if (inv.status !== 'disabled') {
      vscode.window.showWarningMessage(`Primer inventory: ${inv.message}`);
    }
  }

  html(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (name) =>
      webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', name)));

    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none';
      style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};" />
    <link rel="stylesheet" href="${uri('cart.css')}" />
  </head>
  <body>
    <div id="banner" class="banner" hidden></div>
    <div id="toolbar" class="toolbar">
      <input id="filter" class="filter" type="search" placeholder="Filter…" />
      <div class="btnrow">
        <button id="copyTsv" class="primary">Copy TSV</button>
        <button id="copySeqs">Copy sequences</button>
        <button id="exportCsv">Export CSV…</button>
        <button id="remove" class="danger">Remove</button>
      </div>
    </div>
    <div id="summary" class="summary"></div>
    <div id="list" class="list"></div>
    <script nonce="${nonce}" src="${uri('cartPanel.js')}"></script>
  </body>
</html>`;
  }
}

function defaultDir() {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return folder ? folder.uri.fsPath : require('os').homedir();
}

module.exports = { CartViewProvider };
