'use strict';

const path = require('path');
const vscode = require('vscode');

const config = require('./src/config');
const { CartStore } = require('./src/cartStore');
const { CartPanel } = require('./src/cartPanel');
const { DNAViewerProvider, pickInventoryFile } = require('./src/editorProvider');
const { AlignPanels } = require('./src/alignPanel');
const { AlignmentEditorProvider } = require('./src/alignEditor');
const { SeqSearchPanel } = require('./src/seqSearchPanel');
const mafft = require('./src/mafft');
const { buildDemoHtml } = require('./src/editorHtml');

function activate(context) {
  const cart = new CartStore(context);
  const cartPanel = new CartPanel(context, cart);
  const alignPanel = new AlignPanels(context);
  const seqSearchPanel = new SeqSearchPanel(context);

  /*
   * Open a map with a range selected, for a Sequence Search hit.
   *
   * A command rather than a direct call: the panel has no handle on the editor,
   * and an editor that is already open has to be told rather than reopened. The
   * provider keeps the live webviews and does the deciding.
   */
  context.subscriptions.push(
    vscode.commands.registerCommand('oven.revealRange', async (file, range) => {
      await DNAViewerProvider.revealRange(file, range);
    })
  );

  /*
   * retainContextWhenHidden is not a performance tweak here -- do not drop it.
   *
   * Without it VS Code tears the webview down when the tab is hidden and calls
   * resolveCustomEditor again on return, which rebuilds the editor from the file
   * on disk: unsaved base edits are lost, along with the selection, the zoom and
   * any open panel. Upstream shipped without it, and documented the result as a
   * known issue.
   *
   * It belongs on the provider registration rather than in resolveCustomEditor,
   * which is why it is here and not beside the other webview options.
   */
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'oven.editor',
      new DNAViewerProvider(context, cart, cartPanel, alignPanel, seqSearchPanel),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  /*
   * Saved alignments. Same reasoning as above for retainContextWhenHidden: an
   * alignment is expensive to build and holds a selection and a zoom, and
   * rebuilding it on every tab switch would throw all of that away.
   */
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'oven.alignment',
      new AlignmentEditorProvider(context, alignPanel),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('oven.showEditor', () => {
      const panel = vscode.window.createWebviewPanel(
        'oven.demo',
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

    vscode.commands.registerCommand('oven.sequenceSearch', () => seqSearchPanel.show()),
    vscode.commands.registerCommand('oven.show', () => cartPanel.show()),
    vscode.commands.registerCommand('oven.copyTsv', () => cartPanel.copy([], 'tsv')),
    vscode.commands.registerCommand('oven.copySequences', () => cartPanel.copy([], 'seqs')),
    vscode.commands.registerCommand('oven.exportCsv', () => cartPanel.exportCsv([])),
    vscode.commands.registerCommand('oven.newSession', () => cartPanel.newSession()),
    vscode.commands.registerCommand('oven.manageSessions', () => cartPanel.manageSessions()),
    vscode.commands.registerCommand('oven.refreshInventory', () => cartPanel.refreshInventory()),
    vscode.commands.registerCommand('oven.pickInventoryFile', () => pickInventoryFile()),
    vscode.commands.registerCommand('oven.clear', () => cartPanel.clearCart()),
    vscode.commands.registerCommand('oven.align', () => alignPanel.show()),
    // Explorer context menu. Takes the whole multi-selection when there is
    // one; `uri` alone is what a right-click on an unselected file gives.
    vscode.commands.registerCommand('oven.addToAlignment', (uri, uris) =>
      alignPanel.addFiles(uris && uris.length ? uris : (uri ? [uri] : []))),
    vscode.commands.registerCommand('oven.checkMafft', async () => {
      mafft.invalidate();
      const found = await mafft.get(config.mafftPath());
      if (found.ok) {
        vscode.window.showInformationMessage(
          `MAFFT ${found.version} — ${found.path}` +
          (found.viaSetting ? ' (from oven.mafftPath)' : ''));
        return;
      }
      const action = await vscode.window.showWarningMessage(
        found.message, 'Locate MAFFT…', 'Open settings');
      if (action === 'Locate MAFFT…') await alignPanel.locateMafft();
      else if (action === 'Open settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'oven.mafftPath');
      }
    })
  );
}

function deactivate() {}

exports.activate = activate;
exports.deactivate = deactivate;
