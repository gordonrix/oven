'use strict';

const path = require('path');
const vscode = require('vscode');

const config = require('./src/config');
const { CartStore } = require('./src/cartStore');
const { CartPanel } = require('./src/cartPanel');
const { DNAViewerProvider, pickInventoryFile } = require('./src/editorProvider');
const { AlignPanels } = require('./src/alignPanel');
const mafft = require('./src/mafft');
const { buildDemoHtml } = require('./src/editorHtml');

function activate(context) {
  const cart = new CartStore(context);
  const cartPanel = new CartPanel(context, cart);
  const alignPanel = new AlignPanels(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'oveCart.editor',
      new DNAViewerProvider(context, cart, cartPanel, alignPanel),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('oveCart.showEditor', () => {
      const panel = vscode.window.createWebviewPanel(
        'oveCart.demo',
        'Open Vector Editor',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
        }
      );
      const media = (name) =>
        panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', name)));
      panel.webview.html = buildDemoHtml({
        styleUri: media('ove.css'),
        scriptUri: media('index.umd.js'),
        viewType: config.viewType()
      });
    }),

    vscode.commands.registerCommand('oveCart.show', () => cartPanel.show()),
    vscode.commands.registerCommand('oveCart.copyTsv', () => cartPanel.copy([], 'tsv')),
    vscode.commands.registerCommand('oveCart.copySequences', () => cartPanel.copy([], 'seqs')),
    vscode.commands.registerCommand('oveCart.exportCsv', () => cartPanel.exportCsv([])),
    vscode.commands.registerCommand('oveCart.newSession', () => cartPanel.newSession()),
    vscode.commands.registerCommand('oveCart.manageSessions', () => cartPanel.manageSessions()),
    vscode.commands.registerCommand('oveCart.refreshInventory', () => cartPanel.refreshInventory()),
    vscode.commands.registerCommand('oveCart.pickInventoryFile', () => pickInventoryFile()),
    vscode.commands.registerCommand('oveCart.clear', () => cartPanel.clearCart()),
    vscode.commands.registerCommand('oveCart.align', () => alignPanel.show()),
    // Explorer context menu. Takes the whole multi-selection when there is
    // one; `uri` alone is what a right-click on an unselected file gives.
    vscode.commands.registerCommand('oveCart.addToAlignment', (uri, uris) =>
      alignPanel.addFiles(uris && uris.length ? uris : (uri ? [uri] : []))),
    vscode.commands.registerCommand('oveCart.checkMafft', async () => {
      mafft.invalidate();
      const found = await mafft.get(config.mafftPath());
      if (found.ok) {
        vscode.window.showInformationMessage(
          `MAFFT ${found.version} — ${found.path}` +
          (found.viaSetting ? ' (from oveCart.mafftPath)' : ''));
        return;
      }
      const action = await vscode.window.showWarningMessage(
        found.message, 'Locate MAFFT…', 'Open settings');
      if (action === 'Locate MAFFT…') await alignPanel.locateMafft();
      else if (action === 'Open settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'oveCart.mafftPath');
      }
    })
  );
}

function deactivate() {}

exports.activate = activate;
exports.deactivate = deactivate;
