'use strict';

const path = require('path');
const vscode = require('vscode');

const config = require('./src/config');
const { CartStore } = require('./src/cartStore');
const { CartPanel } = require('./src/cartPanel');
const { DNAViewerProvider, pickInventoryFile } = require('./src/editorProvider');
const { AlignPanel } = require('./src/alignPanel');
const { buildDemoHtml } = require('./src/editorHtml');

function activate(context) {
  const cart = new CartStore(context);
  const cartPanel = new CartPanel(context, cart);
  const alignPanel = new AlignPanel(context);

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
    vscode.commands.registerCommand('oveCart.align', () => alignPanel.show())
  );
}

function deactivate() {}

exports.activate = activate;
exports.deactivate = deactivate;
