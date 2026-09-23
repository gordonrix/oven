/*
 * A saved alignment, opened as an editor tab.
 *
 * resolveCustomEditor is handed the same WebviewPanel type we create ourselves
 * for the Align button, so there is no second alignment panel here -- the one
 * in alignPanel.js takes the webview over and restores the file into it. The
 * tab is therefore live rather than a picture of an alignment: reads can be
 * added to it, it can be realigned, and it can be saved again.
 *
 * Read-only in VS Code's sense, which is about the document: OVEN writes the
 * file through Save in the panel rather than through the editor's dirty state,
 * since what is on screen is built from several files and only one of them is
 * this one.
 */
'use strict';

class AlignmentEditorProvider {
  constructor(context, alignPanels) {
    this.context = context;
    this.alignPanels = alignPanels;
  }

  async openCustomDocument(uri) {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(document, webviewPanel) {
    const panel = this.alignPanels.adopt(webviewPanel, document.uri);
    try {
      await panel.restore(document.uri);
    } catch (e) {
      /*
       * A file that is not an alignment at all -- someone else's Stockholm with
       * no rows, or something that only shares the extension. Said in the panel
       * as well as in a notification, because the panel is what is on screen.
       */
      const message = e && e.message ? e.message : String(e);
      panel.fail(`Could not open this alignment: ${message}`);
    }
  }
}

module.exports = { AlignmentEditorProvider };
