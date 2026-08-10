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

/*
 * The buttons used to be individually `position: fixed` with hand-tuned right
 * offsets, which does not survive a third button -- especially since the cart
 * button's label grows to "Add to Cart (12)" at runtime. One fixed flex row
 * instead, so widths take care of themselves.
 */
const BASE_STYLE = `
      html, body { width: 100%; height: 100%; }
      .ove-created-div { height: 100%; background-color: white; }
      .ove-toolbtns {
        position: fixed;
        top: 10px;
        right: 35px;
        z-index: 20000;
        display: flex;
        gap: 8px;
      }
      .ove-toolbtns button {
        padding: 10px;
        color: white;
        border-radius: 4px;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
        font-size: 16px;
        font-weight: 600;
        border: none;
        cursor: pointer;
        white-space: nowrap;
      }
      .ove-toolbtns button:hover { box-shadow: 0 4px 8px rgba(0,0,0,.2); }
      .ove-toolbtns button:disabled { background-color: gray; cursor: not-allowed; opacity: .6; }
      .save-button { background-color: #0078d4; }
      .save-button:hover { background-color: #005a9e; }
      .ove-cart-btn { background-color: #37903b; }
      .ove-cart-btn:hover { background-color: #2a6f2d; }
      .ove-search-btn { background-color: #7050b3; }
      .ove-search-btn:hover { background-color: #5b3f96; }
      /* Sits above OVE's own status bar, which is not extensible. */
      .ove-seltm {
        position: fixed;
        bottom: 30px;
        right: 12px;
        z-index: 20000;
        padding: 3px 10px;
        border-radius: 10px;
        background: rgba(24, 32, 38, .86);
        color: #fff;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        letter-spacing: .01em;
        pointer-events: auto;
        user-select: none;
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
        ${withCart ? `rightClickOverrides: window.OveSearch.rightClickOverrides,
        panelMap: window.OveSearch.panelMap,
        onSelectionOrCaretChanged: function () { window.OveSelectionTm.refresh(); },` : ''}
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
  const { styleUri, scriptUri, cartCssUri, searchCssUri, sharedUri, pickerUri, searchUri,
    selTmUri, sequenceJson, viewType, readOnly, disableBpEditing, autoAddCreatedPrimers } = opts;

  return `<!DOCTYPE html>
<html>
  <head>
    <link rel="stylesheet" href="${styleUri}" />
    <link rel="stylesheet" href="${cartCssUri}" />
    <link rel="stylesheet" href="${searchCssUri}" />
    <style>${BASE_STYLE}</style>
  </head>
  <body>
    <script>
      const vscode = acquireVsCodeApi();
      function postSave() {
        vscode.postMessage({ type: "save", data: editor.getState()["sequenceData"] });
      }
    </script>
    <div class="ove-toolbtns">
      <button id="ove-search-button" class="ove-search-btn"
              onclick="window.OveSearch.open({scoped:true})">Primer Search</button>
      <button id="ove-cart-button" class="ove-cart-btn"
              onclick="window.OveCart.openPicker()">Add to Cart</button>
      <button id="save-button" class="save-button" onclick="postSave()">Save</button>
    </div>
    <div id="ove-seltm" class="ove-seltm" hidden></div>
    <script src="${scriptUri}"></script>
    <script src="${sharedUri}"></script>
    <script src="${pickerUri}"></script>
    <script src="${searchUri}"></script>
    <script src="${selTmUri}"></script>
    <script>
${bootScript({ sequenceJson, viewType, readOnly, disableBpEditing, autoAddCreatedPrimers, withCart: true })}
      window.OveCart.init(vscode, editor);
      window.OveSearch.init(vscode, editor);
      window.OveSelectionTm.init(editor);
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
