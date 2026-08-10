'use strict';

const path = require('path');
const vscode = require('vscode');

const config = require('./src/config');
const { CartStore } = require('./src/cartStore');
const { CartViewProvider } = require('./src/cartView');
const { DNAViewerProvider } = require('./src/editorProvider');
const { buildDemoHtml } = require('./src/editorHtml');

function activate(context) {
  const cart = new CartStore(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'oveCart.editor',
      new DNAViewerProvider(context, cart),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  const cartView = new CartViewProvider(context, cart);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('oveCart.cartView', cartView, {
      webviewOptions: { retainContextWhenHidden: true }
    })
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

    vscode.commands.registerCommand('oveCart.exportCsv', () => cartView.exportCsv()),
    vscode.commands.registerCommand('oveCart.refreshInventory', () => cartView.refreshInventory()),
    vscode.commands.registerCommand('oveCart.clear', () => cartView.clearCart())
  );
}

function deactivate() {}

exports.activate = activate;
exports.deactivate = deactivate;
