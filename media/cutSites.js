/*
 * Remembers the Filter Cut Sites selection across sessions.
 *
 * OVE keeps the choice in redux at `restrictionEnzymes` -- the list of enzymes
 * and categories in the filter, plus the and/or flag beside it -- and resets it
 * to "Single cutters" on every mount. Someone who works with one set of enzymes
 * re-picks them on every file, which is what this removes.
 *
 * Restoring is a plain `updateEditor`: the slice is replaced wholesale, exactly
 * as `readOnly` is, and that is done in the boot script so the filter is right
 * before the first render rather than flickering through the default.
 *
 * Noticing a change is the awkward half. The editor handle exposes only
 * `getState` -- no store, no subscribe -- so there is nothing to listen to.
 * Polling on a timer would work but runs forever for a setting that changes a
 * handful of times a day, so instead this reads the state shortly after any
 * interaction that could plausibly have changed it, and posts only when the
 * value actually differs from what was last saved.
 */
(function () {
  'use strict';

  /* Long enough for redux to have settled after the click that caused it. */
  const SETTLE_MS = 350;

  let vscode = null;
  let editor = null;
  let lastSaved = null;   // JSON of the last value handed to the host
  let timer = null;

  /** The filter, or null if the editor has not got that far yet. */
  function current() {
    if (!editor || !editor.getState) return null;
    const state = editor.getState();
    return (state && state.restrictionEnzymes) || null;
  }

  function checkNow() {
    const value = current();
    if (!value) return;
    const json = JSON.stringify(value);
    if (json === lastSaved) return;
    lastSaved = json;
    vscode.postMessage({ type: 'cutsites/save', filter: value });
  }

  function scheduleCheck() {
    clearTimeout(timer);
    timer = setTimeout(checkNow, SETTLE_MS);
  }

  /**
   * @param {object} api    the vscode webview api
   * @param {object} ed     the OVE editor handle
   * @param {object} [saved] the filter restored by the host, already applied in
   *   the boot script -- passed here only so the first check does not re-post it
   */
  function init(api, ed, saved) {
    vscode = api;
    editor = ed;
    // Seed from whatever is in the editor now, so restoring a saved filter --
    // or simply mounting with the default -- is not immediately posted back.
    lastSaved = JSON.stringify(saved || current());

    // Capture phase, on the document: the filter lives in a Blueprint popover
    // that is torn down as soon as it closes, so binding to it directly would
    // mean re-binding every time it opens.
    for (const type of ['click', 'keyup', 'change']) {
      document.addEventListener(type, scheduleCheck, true);
    }
  }

  window.OveCutSites = { init, checkNow, current };
})();
