/*
 * Panel-group layout for the OVE editor.
 *
 * Open Vector Editor lays its panels out as an array of groups: one group per
 * column on screen, each holding the panels shown there as tabs. Rearranging
 * that array is the only way to change the split.
 *
 * This file is BOTH require()d from src/ (so it can be tested) and
 * <script src>-included into the webview, so it must stay dependency-free and
 * must never require('vscode').
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.OvenPanels = api;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Fold every group into one, so the editor occupies a single column.
   *
   * Used when a side panel -- Align, the primer cart -- opens beside the
   * editor. That panel takes half the window, and halving an editor that is
   * already split leaves the sequence and the circular map at a quarter each.
   *
   * Order is preserved and nothing is dropped: the panels follow in the order
   * their groups appeared, and the one that was active stays active. Where more
   * than one group had an active panel -- the normal case, since every group
   * shows something -- the first wins, which is the leftmost, which is the one
   * you were looking at.
   *
   * @param {Array<Array<object>>} groups value of panelsShown
   * @returns {Array<Array<object>>|null} the single-group layout, or null when
   *   there was nothing to do, so the caller can skip a pointless update.
   */
  function merge(groups) {
    if (!Array.isArray(groups) || groups.length < 2) return null;

    const merged = [];
    let active = null;
    for (const group of groups) {
      if (!Array.isArray(group)) continue;
      for (const panel of group) {
        if (!panel || !panel.id) continue;
        if (panel.active && active === null) active = panel.id;
        merged.push(Object.assign({}, panel, { active: false }));
      }
    }
    if (!merged.length) return null;

    const keep = merged.find((p) => p.id === active) || merged[0];
    keep.active = true;
    return [merged];
  }

  return { merge };
}));
