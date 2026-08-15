/*
 * The Primer Cart panel.
 *
 * Deliberately NOT an activity-bar view. The cart is something you open when
 * you are ready to look at or order a batch, not a permanent fixture, and an
 * always-present sidebar icon turned out to be both intrusive and easy to miss
 * -- people reach for the Cart button in the editor instead. So this is a
 * singleton webview panel opened on demand, from that button or the palette.
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const vscode = require('vscode');

const config = require('./config');
const formats = require('./formats');
const inventory = require('./inventory');

class CartPanel {
  constructor(context, cart) {
    this.context = context;
    this.cart = cart;
    this.panel = null;
    this.pending = false;

    context.subscriptions.push(cart.onDidChange(() => this.push()));
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (['inventoryPath', 'inventorySheet', 'inventoryNameColumn', 'inventorySequenceColumn']
          .some((k) => e.affectsConfiguration(`oveCart.${k}`))) {
          inventory.invalidate();
          this.push();
        }
      })
    );
  }

  /** Create the panel, or reveal it if it already exists. */
  show(column) {
    if (this.panel) {
      this.panel.reveal(column || this.panel.viewColumn, true);
      this.push(true);
      return this.panel;
    }

    const panel = vscode.window.createWebviewPanel(
      'oveCart.panel',
      'Primer Cart',
      { viewColumn: column || vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))]
      }
    );
    this.panel = panel;
    panel.iconPath = vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'cart.svg'));
    this.log(`panel opened, cart has ${this.cart.items().length} item(s)`);

    // Register the handler before the html: assigning html runs the panel
    // script synchronously and it asks for state immediately.
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (!msg) return;
      switch (msg.type) {
        // The panel just told us it is alive and waiting, so answer regardless
        // of what the visibility flag currently says.
        case 'cart/ready': this.push(true); break;
        case 'cart/remove': await this.remove(msg.ids || []); break;
        case 'cart/clear': await this.clearCart(); break;
        case 'cart/copyTsv': await this.copy(msg.ids, 'tsv'); break;
        case 'cart/copySeqs': await this.copy(msg.ids, 'seqs'); break;
        case 'cart/exportCsv': await this.exportCsv(msg.ids); break;
        case 'cart/rename': await this.cart.rename(msg.id, msg.name); break;
        case 'cart/note': await this.cart.setNote(msg.id, msg.note); break;
        case 'cart/openSource': await this.openSource(msg.id); break;
        case 'cart/refreshInventory': this.refreshInventory(); break;
        case 'cart/newSession': await this.newSession(); break;
        case 'cart/manageSessions': await this.manageSessions(); break;
        case 'cart/openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', 'oveCart.inventoryPath');
          break;
        default: break;
      }
    });

    panel.onDidChangeViewState(() => {
      if (panel.visible && this.pending) this.push();
    });

    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = null;
      this.log('panel closed');
    });

    panel.webview.html = this.html(panel.webview);
    return panel;
  }

  /**
   * Send the whole cart. postMessage to a hidden webview is discarded, so
   * defer while hidden and flush on the next view-state change; `force`
   * bypasses that for the panel's own state request.
   */
  push(force) {
    if (!this.panel) return;
    if (!force && !this.panel.visible) {
      this.pending = true;
      return;
    }
    this.pending = false;
    const { items, inventory: inv } = inventory.annotate(this.cart.items());
    const sessions = this.cart.sessions().map((s) => ({ id: s.id, name: s.name, count: s.items.length }));
    this.log(`push: ${items.length} item(s), inventory=${inv.status}, forced=${Boolean(force)}`);
    this.panel.webview.postMessage({
      type: 'cart/state', items, inventory: inv, sessions, activeId: this.cart.activeSessionId()
    });
  }

  log(message) {
    if (!this.output) this.output = vscode.window.createOutputChannel('Primer Cart');
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
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

  /*
   * No confirmation. Taking a primer out of the cart destroys nothing -- the
   * primer is still on the sequence, and can be added again from the same file
   * -- so a modal for it is friction without a payoff. Clearing a whole session
   * still asks, since that is not one click to undo.
   */
  async remove(ids) {
    if (!ids.length) return;
    await this.cart.remove(ids);
  }

  async clearCart() {
    const n = this.cart.items().length;
    if (!n) return;
    const answer = await vscode.window.showWarningMessage(
      `Clear all ${n} primers from this session?`,
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
      await vscode.commands.executeCommand(
        'vscode.openWith', vscode.Uri.file(item.sourcePath), 'oveCart.editor', vscode.ViewColumn.One
      );
    } catch (e) {
      vscode.window.showErrorMessage(`Could not open ${item.sourcePath}: ${e.message}`);
    }
  }

  /** Park the current cart and start an empty one. Nothing is deleted. */
  async newSession() {
    const current = this.cart.activeSession();
    const n = current.items.length;
    const name = await vscode.window.showInputBox({
      title: 'New primer cart session',
      prompt: `"${current.name}" (${n} primer${n === 1 ? '' : 's'}) is kept and can be reopened from the session list.`,
      value: new Date().toISOString().slice(0, 10),
      placeHolder: 'e.g. 2026-08-10 backbone swaps'
    });
    if (name === undefined) return;
    const session = await this.cart.newSession(name.trim() || undefined);
    vscode.window.showInformationMessage(`Started primer cart session "${session.name}".`);
  }

  /** Switch, rename or delete a session via quick picks. */
  async manageSessions() {
    const sessions = this.cart.sessions();
    const activeId = this.cart.activeSessionId();
    const picked = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: `${s.id === activeId ? '$(check) ' : ''}${s.name}`,
        description: `${s.items.length} primer${s.items.length === 1 ? '' : 's'}`,
        detail: s.id === activeId ? 'Active session' : `Created ${String(s.createdAt).slice(0, 10)}`,
        id: s.id
      })),
      { title: 'Primer cart sessions', placeHolder: 'Pick a session' }
    );
    if (!picked) return;

    const action = await vscode.window.showQuickPick(
      [
        { label: '$(arrow-right) Switch to this session', value: 'switch' },
        { label: '$(edit) Rename', value: 'rename' },
        { label: '$(trash) Delete', value: 'delete' }
      ],
      { title: picked.label.replace('$(check) ', ''), placeHolder: 'What would you like to do?' }
    );
    if (!action) return;

    const session = sessions.find((s) => s.id === picked.id);
    if (action.value === 'switch') {
      await this.cart.switchSession(picked.id);
    } else if (action.value === 'rename') {
      const name = await vscode.window.showInputBox({ title: 'Rename session', value: session.name });
      if (name !== undefined) await this.cart.renameSession(picked.id, name);
    } else if (action.value === 'delete') {
      const ok = await vscode.window.showWarningMessage(
        `Delete session "${session.name}" and its ${session.items.length} primer(s)?`,
        { modal: true },
        'Delete'
      );
      if (ok === 'Delete') await this.cart.deleteSession(picked.id);
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
    <div id="sessionbar" class="sessionbar">
      <button id="sessionName" class="sessionbtn" title="Switch, rename or delete a session">Cart</button>
      <button id="newSession" class="sessionnew" title="Park this cart and start an empty one">+ New session</button>
    </div>
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
    <label id="selectAllBar" class="selectall" hidden>
      <input id="selectAll" type="checkbox" />
      <span id="selectAllLabel">Select all</span>
    </label>
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

module.exports = { CartPanel };
