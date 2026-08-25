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
  const FIND_ROW_MS = 300;

  let rowView = null;
  let mutations = null;
  let resizes = null;
  let seeking = null;
  let queued = false;

  function measureRow(row) {
    const seq = row.querySelector('.veRowItemSequenceContainer');
    // Protein and oligo views have no letters container; the CSS fallbacks apply.
    if (!seq || !seq.offsetHeight) return;
    const top = seq.offsetTop;
    row.style.setProperty('--ovestrand-top', `${top + LAYER_OFFSET - BAR_HEIGHT + NUDGE}px`);
    row.style.setProperty('--ovestrand-bottom', `${top + seq.offsetHeight + LAYER_OFFSET - NUDGE}px`);
  }

  function measure() {
    if (!rowView || !rowView.isConnected) return false;
    const rows = rowView.querySelectorAll('.veRowItem');
    if (!rows.length) return false;
    rows.forEach(measureRow);
    return true;
  }

  /** Coalesce the burst of mutations a single React re-render produces. */
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; measure(); });
  }

  function attach() {
    const found = document.querySelector('.veRowView');
    if (!found) return false;
    if (found !== rowView) {
      rowView = found;
      if (mutations) mutations.disconnect();
      if (resizes) resizes.disconnect();
      /*
       * childList only, deliberately. Rows are recycled as you scroll and
       * rebuilt when a track is toggled, which is a childList change; watching
       * attributes as well would see our own style.setProperty and loop.
       */
      mutations = new MutationObserver(schedule);
      mutations.observe(rowView, { childList: true, subtree: true });
      // A row can grow without its children changing -- a wider pane reflows
      // labels onto fewer lines -- so watch the geometry too.
      resizes = new ResizeObserver(schedule);
      resizes.observe(rowView);
    }
    return measure();
  }

  function refresh() {
    if (attach() || seeking) return;
    // The row view mounts well after the editor does; keep looking, then stop.
    seeking = setInterval(() => {
      if (attach()) { clearInterval(seeking); seeking = null; }
    }, FIND_ROW_MS);
  }

  window.OveStrandBar = { init: refresh, refresh, measure };
})();
