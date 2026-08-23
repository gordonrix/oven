/* Builds the HTML for the OVE webviews (the custom editor and the demo command). */
'use strict';

/**
 * Which OVE panels to show, per the oven.viewType setting.
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
 * Save is not among them: OVE's own File > Save, and its mod+s hotkey, are
 * wired up in bootScript instead, which also greys the item out when nothing
 * has changed. A second Save that could not know that was worse than none.
 *
 * The buttons are OVE menu-bar items that happen to be ours: same 14px Arial,
 * same 5px/10px padding in a 30px box, no background, and Blueprint's own text
 * colour and hover wash. They were coloured pills, which read as a separate
 * toolbar bolted on top of the editor rather than as part of it.
 *
 * top: 5px lines them up with File/Edit/View, so they occupy the menu row --
 * which is empty on the right -- instead of the icon row underneath it.
 *
 * `right` is set at runtime, not here: see media/toolButtons.js.
 */
const BASE_STYLE = `
      html, body { width: 100%; height: 100%; }
      .ove-created-div { height: 100%; background-color: white; }
      .ove-toolbtns {
        position: fixed;
        top: 5px;
        right: 16px; /* a starting point; placeToolButtons measures the real one */
        z-index: 20000;
        display: flex;
        gap: 4px; /* matches .tg-menu-bar-item's 2px margin either side */
      }
      .ove-toolbtns button {
        height: 30px;
        padding: 5px 10px;
        color: #182026;
        background: none;
        border: none;
        border-radius: 3px;
        font-family: Arial, sans-serif;
        font-size: 14px;
        font-weight: 400;
        cursor: pointer;
        white-space: nowrap;
      }
      .ove-toolbtns button:hover { background-color: rgba(167, 182, 194, .3); }
      .ove-toolbtns button:active { background-color: rgba(115, 134, 148, .3); }
      .ove-toolbtns button:disabled { color: rgba(92, 112, 128, .6); cursor: not-allowed; }
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
  showSelectionStats, withCart, cutSiteFilter }) {
  return `
      /*
       * "Melting Temp of Selection" has no ...ByDefault prop -- unlike GC
       * content it is read straight from localStorage by useMeltingTemp
       * (index.umd.js:149800), so seeding the key is the only way to turn it
       * on. Written only when unset, so a later toggle in the View menu wins,
       * which is what oven.showSelectionStatsByDefault promises.
       */
      ${showSelectionStats ? `try {
        if (localStorage.getItem("showMeltingTemp") === null) {
          localStorage.setItem("showMeltingTemp", "true");
        }
      } catch (e) { /* storage blocked; the View menu still works */ }` : ''}

      const editor = window.createVectorEditor("createDomNodeForMe", {
        withPreviewMode: false,
        editorName: "VectorEditor",
        showMenuBar: true,
        showReadOnly: true,
        disableSetReadOnly: false,
        disableBpEditing: ${Boolean(disableBpEditing)},
        showGCContentByDefault: ${Boolean(showSelectionStats)},
        ${withCart ? `rightClickOverrides: window.OveSearch.rightClickOverrides,
        // Merged, not replaced: OVE takes a single panelMap, so both of our
        // panels have to arrive in the same object.
        panelMap: Object.assign({}, window.OveSearch.panelMap, window.OveNewPrimer.panelMap),
` : ''}
        /*
         * Lights up OVE's own File > Save and its mod+s hotkey.
         *
         * OVE hides that menu item unless an onSave prop is passed, and
         * upstream never passed one -- which is why saving needed a button of
         * our own bolted to the toolbar. OVE also tracks whether anything has
         * changed (sequenceData.stateTrackingId against lastSavedId), so with
         * this wired the item greys itself out when there is nothing to save.
         *
         * The state is read back from the editor rather than taken from the
         * tidied copy OVE passes in, so the bytes written are exactly what the
         * old Save button wrote. onSuccessfulSave marks the editor clean.
         */
        onSave: function (opts, tidiedData, props, onSuccessfulSave) {
          postSave();
          if (onSuccessfulSave) onSuccessfulSave();
        },
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
        readOnly: ${Boolean(readOnly)}${cutSiteFilter ? `,
        // Restored from globalState. Applied here rather than after mounting so
        // the filter is right on the first render instead of flickering through
        // OVE's "Single cutters" default.
        restrictionEnzymes: ${JSON.stringify(cutSiteFilter)}` : ''}
      });`;
}

/** HTML for a file-backed custom editor tab. */
function buildEditorHtml(opts) {
  const { styleUri, scriptUri, cartCssUri, searchCssUri, strandCssUri, sharedUri, pickerUri,
    searchUri, strandUri, toolBtnsUri, cutSitesUri, codonUsageUri, codonEditUri,
    aminoAcidUri, aminoAcidCssUri, rowViewCssUri, newPrimerUri, newPrimerCssUri,
    sequenceJson, viewType, readOnly,
    disableBpEditing, autoAddCreatedPrimers, showSelectionStats,
    cutSiteFilter, newPrimerHotkey, newPrimerLiveSelection } = opts;

  return `<!DOCTYPE html>
<html>
  <head>
    <link rel="stylesheet" href="${styleUri}" />
    <link rel="stylesheet" href="${cartCssUri}" />
    <link rel="stylesheet" href="${searchCssUri}" />
    <link rel="stylesheet" href="${strandCssUri}" />
    <link rel="stylesheet" href="${aminoAcidCssUri}" />
    <link rel="stylesheet" href="${newPrimerCssUri}" />
    <link rel="stylesheet" href="${rowViewCssUri}" />
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
              onclick="window.OveCart.openCart()">Primer Cart</button>
    </div>
    <!--
      Must precede the bundle: OVE builds its command definitions when the
      script evaluates, and the New Primer hotkey is read from this global at
      that moment. Declaring it there is what shows the shortcut next to the
      menu entry, so it has to be the real one rather than a default.
    -->
    <script>
      window.__ovenNewPrimerHotkey = ${JSON.stringify(newPrimerHotkey || 'mod+shift+k')};
      window.__ovenNewPrimerLiveSelection = ${newPrimerLiveSelection === false ? 'false' : 'true'};
    </script>
    <script src="${scriptUri}"></script>
    <script src="${sharedUri}"></script>
    <script src="${pickerUri}"></script>
    <script src="${searchUri}"></script>
    <script src="${strandUri}"></script>
    <script src="${toolBtnsUri}"></script>
    <script src="${cutSitesUri}"></script>
    <script src="${codonUsageUri}"></script>
    <script src="${codonEditUri}"></script>
    <script src="${aminoAcidUri}"></script>
    <script src="${newPrimerUri}"></script>
    <script>
${bootScript({ sequenceJson, viewType, readOnly, disableBpEditing, autoAddCreatedPrimers, showSelectionStats, withCart: true, cutSiteFilter })}
      window.OveCart.init(vscode, editor);
      window.OveSearch.init(vscode, editor);
      window.OveStrandBar.init();
      window.OveCutSites.init(vscode, editor, ${JSON.stringify(cutSiteFilter || null)});
      window.OveAminoAcid.init(vscode, editor);
      window.OveNewPrimer.init(editor);
    </script>
  </body>
</html>`;
}

/** HTML for the scratch editor opened by the oven.showEditor command. */
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
