/* Builds the HTML for the OVE webviews (the custom editor and the demo command). */
'use strict';

/**
 * Which OVE panels to show, per the oveCart.viewType setting.
 * Returned as a JS literal because it goes straight into the inline script.
 */
function panelsShown(viewTypeConfig) {
  if (viewTypeConfig === 'split') {
    return `[
            [ { id: "circular", name: "Circular Map", active: true } ],
            [
              { id: "sequence", name: "Sequence Map", active: true },
              { id: "properties", name: "Properties", active: false }
            ]
          ]`;
  }

  return `[
            [
              { id: "sequence", name: "Sequence Map", active: ${viewTypeConfig === 'sequence'} },
              { id: "circular", name: "Circular Map", active: ${viewTypeConfig === 'circular'} },
              { id: "properties", name: "Properties", active: false }
            ]
          ]`;
}

const BASE_STYLE = `
      html, body { width: 100%; height: 100%; }
      .ove-created-div { height: 100%; background-color: white; }
      .ove-cart-btn, .save-button {
        display: inline-block;
        padding: 10px;
        background-color: #0078d4;
        color: white;
        text-decoration: none;
        border-radius: 4px;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
        font-size: 16px;
        font-weight: 600;
        box-shadow: none;
        border: none;
        cursor: pointer;
        position: fixed;
        top: 10px;
        z-index: 20000;
      }
      .save-button { right: 35px; }
      .ove-cart-btn { right: 115px; background-color: #37903b; }
      .save-button:hover { background-color: #005a9e; box-shadow: 0 4px 8px rgba(0,0,0,.2); }
      .ove-cart-btn:hover { background-color: #2a6f2d; box-shadow: 0 4px 8px rgba(0,0,0,.2); }
      .save-button:disabled, .ove-cart-btn:disabled {
        background-color: gray; cursor: not-allowed; opacity: .6;
      }`;

/**
 * The inline script that boots OVE.
 *
 * Two OVE settings are passed through two different channels, which is not
 * obvious and is easy to get wrong:
 *
 *   readOnly          -> updateEditor payload. It is a redux reducer whose
 *                        default is true; passing it as a createVectorEditor
 *                        prop is silently ignored. This is what was hiding
 *                        every item in the Create menu.
 *   disableBpEditing  -> createVectorEditor prop. It is a React prop only and
 *                        never reaches redux.
 *
 * Both verified against the bundled OVE build; swapping them re-breaks the
 * Create menu or silently unlocks base editing.
 */
function bootScript({ sequenceJson, viewType, readOnly, disableBpEditing, autoAddCreatedPrimers, withCart }) {
  return `
      const editor = window.createVectorEditor("createDomNodeForMe", {
        withPreviewMode: false,
        editorName: "VectorEditor",
        showMenuBar: true,
        showReadOnly: true,
        disableSetReadOnly: false,
        disableBpEditing: ${Boolean(disableBpEditing)},
        beforeAnnotationCreate: function (info) {
          try {
            if (${Boolean(withCart && autoAddCreatedPrimers)} && info &&
                info.annotationTypePlural === "primers" && !info.isEdit) {
              window.OveCart && window.OveCart.addCreated(info);
            }
          } catch (e) {
            console.error("primer cart: auto-add failed", e);
          }
          return true; // only an exact false would abort the annotation
        }
      });
      window.__oveEditor = editor;

      editor.updateEditor({
        sequenceData: ${sequenceJson},
        panelsShown: ${panelsShown(viewType)},
        readOnly: ${Boolean(readOnly)}
      });`;
}

/** HTML for a file-backed custom editor tab. */
function buildEditorHtml(opts) {
  const { styleUri, scriptUri, cartCssUri, sharedUri, pickerUri, sequenceJson,
    viewType, readOnly, disableBpEditing, autoAddCreatedPrimers } = opts;

  return `<!DOCTYPE html>
<html>
  <head>
    <link rel="stylesheet" href="${styleUri}" />
    <link rel="stylesheet" href="${cartCssUri}" />
    <style>${BASE_STYLE}</style>
  </head>
  <body>
    <script>
      const vscode = acquireVsCodeApi();
      function postSave() {
        vscode.postMessage({ type: "save", data: editor.getState()["sequenceData"] });
      }
    </script>
    <button id="save-button" class="save-button" onclick="postSave()">Save</button>
    <button id="ove-cart-button" class="ove-cart-btn" onclick="window.OveCart.openPicker()">Cart</button>
    <script src="${scriptUri}"></script>
    <script src="${sharedUri}"></script>
    <script src="${pickerUri}"></script>
    <script>
${bootScript({ sequenceJson, viewType, readOnly, disableBpEditing, autoAddCreatedPrimers, withCart: true })}
      window.OveCart.init(vscode, editor);
    </script>
  </body>
</html>`;
}

/** HTML for the scratch editor opened by the oveCart.showEditor command. */
function buildDemoHtml(opts) {
  const { styleUri, scriptUri, viewType } = opts;
  return `<!DOCTYPE html>
<html>
  <head>
    <link rel="stylesheet" href="${styleUri}" />
    <style>${BASE_STYLE}</style>
  </head>
  <body>
    <script src="${scriptUri}"></script>
    <script>
${bootScript({
    sequenceJson: JSON.stringify({ circular: true, sequence: 'AAGG' }),
    viewType,
    readOnly: false,
    disableBpEditing: false,
    autoAddCreatedPrimers: false,
    withCart: false
  })}
    </script>
  </body>
</html>`;
}

module.exports = { buildEditorHtml, buildDemoHtml, panelsShown };
