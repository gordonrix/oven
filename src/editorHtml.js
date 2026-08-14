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
 * The buttons sit in one fixed flex row, sized and styled to match OVE's own
 * menu bar (14px Arial, 5px/10px padding, 30px tall) rather than shouting over
 * it. They used to be 16px bold pills 41px tall, which took enough width to
 * cover the toolbar icons as soon as the editor was made narrow. Squared
 * corners and desaturated fills keep them legible as actions without competing
 * with the sequence.
 *
 * top: 5px lines them up with File/Edit/View, so they occupy the menu row --
 * which is empty on the right -- instead of the icon row underneath it.
 */
const BASE_STYLE = `
      html, body { width: 100%; height: 100%; }
      .ove-created-div { height: 100%; background-color: white; }
      .ove-toolbtns {
        position: fixed;
        top: 5px;
        right: 16px;
        z-index: 20000;
        display: flex;
        gap: 3px;
      }
      .ove-toolbtns button {
        height: 30px;
        padding: 5px 10px;
        color: white;
        border: none;
        border-radius: 0;
        font-family: Arial, sans-serif;
        font-size: 14px;
        font-weight: 400;
        cursor: pointer;
        white-space: nowrap;
      }
      .ove-toolbtns button:hover { filter: brightness(1.12); }
      .ove-toolbtns button:disabled { background-color: #9aa5ad; cursor: not-allowed; opacity: .6; }
      .save-button { background-color: #3d7ea6; }
      .ove-cart-btn { background-color: #4f8452; }
      .ove-search-btn { background-color: #6f5f96; }
      .ove-align-btn { background-color: #a07338; }
`;

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
function bootScript({ sequenceJson, viewType, readOnly, disableBpEditing, autoAddCreatedPrimers,
  showSelectionStats, withCart }) {
  return `
      const editor = window.createVectorEditor("createDomNodeForMe", {
        withPreviewMode: false,
        editorName: "VectorEditor",
        showMenuBar: true,
        showReadOnly: true,
        disableSetReadOnly: false,
        disableBpEditing: ${Boolean(disableBpEditing)},
        showGCContentByDefault: ${Boolean(showSelectionStats)},
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
  const { styleUri, scriptUri, cartCssUri, searchCssUri, strandCssUri, sharedUri, pickerUri,
    searchUri, selTmUri, strandUri, sequenceJson, viewType, readOnly, disableBpEditing,
    autoAddCreatedPrimers, showSelectionStats, useDesignTm } = opts;

  return `<!DOCTYPE html>
<html>
  <head>
    <link rel="stylesheet" href="${styleUri}" />
    <link rel="stylesheet" href="${cartCssUri}" />
    <link rel="stylesheet" href="${searchCssUri}" />
    <link rel="stylesheet" href="${strandCssUri}" />
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
      <button id="ove-align-button" class="ove-align-btn"
              onclick="vscode.postMessage({type:'align/open'})">Align</button>
      <button id="ove-search-button" class="ove-search-btn"
              onclick="window.OveSearch.open({scoped:true})">Primer Search</button>
      <button id="ove-cart-button" class="ove-cart-btn"
              onclick="window.OveCart.openPicker()">Add to Cart</button>
      <button id="save-button" class="save-button" onclick="postSave()">Save</button>
    </div>
    <script src="${scriptUri}"></script>
    <script src="${sharedUri}"></script>
    <script src="${pickerUri}"></script>
    <script src="${searchUri}"></script>
    <script src="${selTmUri}"></script>
    <script src="${strandUri}"></script>
    <script>
${bootScript({ sequenceJson, viewType, readOnly, disableBpEditing, autoAddCreatedPrimers, showSelectionStats, withCart: true })}
      window.OveCart.init(vscode, editor);
      window.OveSearch.init(vscode, editor);
      window.OveSelectionTm.init(editor, { useDesignTm: ${Boolean(useDesignTm)} });
      window.OveStrandBar.init();
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
    showSelectionStats: false,
    withCart: false
  })}
    </script>
  </body>
</html>`;
}

module.exports = { buildEditorHtml, buildDemoHtml, panelsShown };
