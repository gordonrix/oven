/*
 * View settings that should stay the way you left them, from one file to the
 * next.
 *
 * Open Vector Editor keeps its View menu choices only for the editor they were
 * made in: every file opened, and every tab VS Code puts back after a restart,
 * starts again from OVE's defaults. For most of them that is the right thing.
 * For some it is not -- Amino Acid Numbers is off by default, so it was off
 * again in every file, however often it was turned on.
 *
 * The settings in CartShared.VIEW_PREFS -- how things are drawn, never what is
 * shown -- are watched in the editor's store. When one changes it is posted to
 * the host, which keeps it in VS Code's global state, beside
 * the cut-site filter, and puts it into the boot payload of every DNA file it
 * opens, so the first render already has it.
 *
 * Not loaded for a protein: OVE's protein view numbers residues itself and
 * turns this off deliberately, and the protein's choice must not overwrite the
 * one made for DNA.
 */
(function () {
  'use strict';

  /*
   * Which settings: CartShared.VIEW_PREFS, shared with the host, which checks
   * what it stores against the same list.
   */
  const lists = () => window.CartShared.VIEW_PREFS;

  function read(editor) {
    const st = editor.getState() || {};
    const visibility = st.annotationVisibility || {};
    const labelVisibility = st.annotationLabelVisibility || {};
    const out = {};
    for (const key of lists().visibility) out[key] = Boolean(visibility[key]);
    out.labels = {};
    for (const key of lists().labels) out.labels[key] = Boolean(labelVisibility[key]);
    return out;
  }

  function init(vscode, editor) {
    if (!editor || !editor.subscribe || !window.CartShared) return;
    let last = JSON.stringify(read(editor));
    editor.subscribe(() => {
      const now = read(editor);
      const json = JSON.stringify(now);
      if (json === last) return;
      last = json;
      vscode.postMessage({ type: 'viewprefs/save', prefs: now });
    });
  }

  window.OveViewPrefs = { init };
})();
