/*
 * Keeps VS Code told about unsaved changes in the editor.
 *
 * OVE tracks them itself: every edit gives the sequence a new stateTrackingId,
 * and the id of the last saved state is kept as lastSavedId. This watches the
 * editor's store and, whenever the sequence changes away from what was saved,
 * posts it to the host. The host keeps it as what a save would write, and the
 * first one after each save is what puts the dirty mark on the tab and makes
 * closing ask about saving.
 *
 * And the other way: when VS Code saves -- its menu, Save All, the prompt on
 * closing -- or reverts, the host says so here, and OVE's own idea of what is
 * saved is brought into line, so its File > Save greys out as it does after
 * one of its own saves.
 */
(function () {
  'use strict';

  /** Changed since it was opened, and since it was last saved. */
  const isDirty = (st) => Boolean(st && st.sequenceData &&
    st.sequenceData.stateTrackingId !== 'initialLoadId' &&
    st.sequenceData.stateTrackingId !== st.lastSavedId);

  function init(vscode, editor) {
    if (!editor || !editor.subscribe) return;
    let last = (editor.getState() || {}).sequenceData;
    // Set while the host's own updates are applied, so they are not echoed
    // back to it as edits.
    let quiet = false;

    editor.subscribe(() => {
      const st = editor.getState();
      // Selection, scrolling and the rest leave the sequence object alone; only
      // an edit replaces it, so the identity check is all the filtering needed.
      if (!st || st.sequenceData === last) return;
      last = st.sequenceData;
      if (quiet || !isDirty(st)) return;
      vscode.postMessage({ type: 'doc/changed', data: st.sequenceData });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.type === 'doc/saved') {
        quiet = true;
        editor.updateEditor({ lastSavedId: msg.id });
        last = editor.getState().sequenceData;
        quiet = false;
      } else if (msg.type === 'doc/revert' && msg.data) {
        quiet = true;
        editor.updateEditor({ sequenceData: msg.data });
        // What was just loaded is, by definition, what is saved.
        editor.updateEditor({ lastSavedId: editor.getState().sequenceData.stateTrackingId });
        last = editor.getState().sequenceData;
        quiet = false;
      }
    });
  }

  window.OveDocSync = { init, isDirty };
})();
