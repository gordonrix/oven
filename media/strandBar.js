/*
 * Publishes where each row's sequence letters sit, so the strand-indicator bar
 * can be drawn hugging them.
 *
 * The bar itself is pure CSS (strandBar.css). It cannot be positioned with a
 * constant: a selection/search layer is `height: 100%` of its whole row --
 * label band, both strands of letters, and the annotation tracks -- so "just
 * above the letters" is an offset, not an edge.
 *
 * Nor can one row be measured and the answer reused. The label band above the
 * letters is sized to whatever labels that row happens to need, so the letters
 * sit at a different offset in every row (measured: 0, 75, 45, 0, 15, ... in a
 * single view). So each `.veRowItem` gets its own pair of properties, which
 * the layers inside it inherit:
 *
 *   --ovestrand-top     top offset for a forward-strand bar
 *   --ovestrand-bottom  top offset for a reverse-strand bar
 *
 * Both are in the layer's coordinate space, which is the row's shifted up by
 * LAYER_OFFSET.
 */
(function () {
  'use strict';

  const BAR_HEIGHT = 6;   // 3X, where X is the 2px caret width
  const LAYER_OFFSET = 2; // layers sit at top:-2px relative to the row
  // Pulls the bar 1px towards the letters, so it reads as belonging to that
  // strand rather than floating between the two.
  const NUDGE = 1;

  // Marks a row whose letters have been found and measured. The bar is drawn
  // only on these: an unmeasured row would otherwise take the CSS fallbacks and
  // put the bar at the very top and bottom of the whole row, which looks like a
  // deliberate but wrong answer rather than like nothing.
  const MEASURED = 'ove-strand-measured';

  let host = null;      // the stable ancestor we watch
  let rowView = null;   // the row view as of the last measure; React replaces it
  let mutations = null;
  let resizes = null;
  let queued = false;

  function measureRow(row) {
    const seq = row.querySelector('.veRowItemSequenceContainer');
    // Protein and oligo views have no letters container, and a row mid-render
    // has one with no height. Either way there is nothing to hug.
    if (!seq || !seq.offsetHeight) { row.classList.remove(MEASURED); return; }
    const top = seq.offsetTop;
    row.style.setProperty('--ovestrand-top', `${top + LAYER_OFFSET - BAR_HEIGHT + NUDGE}px`);
    row.style.setProperty('--ovestrand-bottom', `${top + seq.offsetHeight + LAYER_OFFSET - NUDGE}px`);
    row.classList.add(MEASURED);
  }

  /*
   * The row view is re-resolved every time rather than remembered.
   *
   * React unmounts and remounts it whenever the panel layout changes -- turning
   * to the circular map and back, or a side panel folding the split. The old
   * node is then detached, and an observer watching it never fires again: the
   * new rows are never measured, every bar falls back to the block edge, and
   * the only way out was to reload the file.
   */
  function measure() {
    const found = document.querySelector('.veRowView');
    if (!found) return false;
    if (found !== rowView) {
      rowView = found;
      if (resizes) { resizes.disconnect(); resizes.observe(rowView); }
    }
    const rows = rowView.querySelectorAll('.veRowItem');
    if (!rows.length) return false;
    rows.forEach(measureRow);
    return true;
  }

  /** Coalesce the burst of mutations a single React re-render produces. */
  function schedule() {
    if (queued) return;
    queued = true;
    // attach, not measure: the first attach may have landed on document.body
    // because the editor's container did not exist yet, and this is where it
    // gets upgraded to the real one. attach() is a querySelector and an
    // identity check when nothing has moved.
    requestAnimationFrame(() => { queued = false; attach(); });
  }

  function attach() {
    /*
     * Watch the editor's own container, not the row view: the container is made
     * once by createVectorEditor and survives every layout change, so an
     * observer on it still fires when the row view is swapped underneath.
     */
    const found = document.querySelector('.ove-created-div') || document.body;
    if (found !== host) {
      host = found;
      if (mutations) mutations.disconnect();
      if (resizes) resizes.disconnect();
      /*
       * childList only, deliberately. Rows are recycled as you scroll and
       * rebuilt when a track is toggled, which is a childList change; watching
       * attributes as well would see our own style.setProperty and loop.
       */
      mutations = new MutationObserver(schedule);
      mutations.observe(host, { childList: true, subtree: true });
      // A row can grow without its children changing -- a wider pane reflows
      // labels onto fewer lines -- so watch the geometry too. measure() moves
      // this to whichever row view is current.
      resizes = new ResizeObserver(schedule);
    }
    return measure();
  }

  /*
   * Attach once. The observer does the waiting from there.
   *
   * This used to poll every 300ms until a row view turned up, and nothing
   * stopped it when one never did -- a protein or oligo view, or a sequence
   * opened on a map tab with the Sequence Map never shown. The timer then ran
   * for the life of the tab, in every such tab, doing a document-wide
   * querySelector three times a second forever.
   *
   * It was never needed: attach() installs the observer on the first call --
   * on document.body if the editor's container is not up yet -- and a row view
   * mounting is a childList change underneath it. The observer fires, schedule
   * runs attach again, and that is the same wake-up the poll was there to
   * provide.
   */
  function refresh() {
    attach();
  }

  window.OveStrandBar = { init: refresh, refresh, measure };
})();
