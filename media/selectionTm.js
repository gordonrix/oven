/*
 * A small readout in the bottom corner showing length, GC and Tm for whatever
 * is currently selected, so you can judge a candidate primer by dragging over
 * it rather than creating one first.
 *
 * OVE's own status bar is not extensible -- there is no prop for extra items
 * and its React tree would discard an injected child on the next render -- so
 * this is a fixed-position element of our own, sitting above it.
 */
(function () {
  'use strict';

  // Nearest-neighbour Tm is a primer model. Past roughly this length the
  // number is arithmetically fine and biologically meaningless, so say so
  // rather than print something confidently wrong.
  const MAX_TM_BP = 200;
  const POLL_MS = 400;

  let editor = null;
  let node = null;
  let lastKey = '';

  const S = () => window.CartShared;

  function state() {
    try {
      return editor.getState() || {};
    } catch (e) {
      return {};
    }
  }

  function selectionBases() {
    const st = state();
    const sel = st.selectionLayer || {};
    if (!(typeof sel.start === 'number' && sel.start > -1 && sel.end > -1)) return null;
    const sd = st.sequenceData || {};
    const bases = S().deriveBases(sd.sequence || '', sel.start, sel.end, 1, Boolean(sd.circular));
    return bases ? { bases, start: sel.start, end: sel.end } : null;
  }

  function refresh() {
    if (!node) return;
    const sel = selectionBases();

    // Nothing selected: get out of the way entirely rather than show zeros.
    if (!sel) {
      lastKey = '';
      node.hidden = true;
      node.textContent = '';
      return;
    }

    const key = `${sel.start}|${sel.end}|${sel.bases.length}`;
    if (key === lastKey) return; // same selection, nothing to recompute
    lastKey = key;

    const n = sel.bases.length;
    const gc = S().gcFraction(sel.bases);
    const bits = [`${n} bp`];
    if (gc !== null) bits.push(`${Math.round(gc * 100)}% GC`);

    if (n > MAX_TM_BP) {
      bits.push(`Tm — (>${MAX_TM_BP} bp)`);
    } else {
      const tm = S().tmNebQ5(sel.bases);
      bits.push(tm === null ? 'Tm —' : `Tm ${tm.toFixed(1)} °C`);
    }

    node.hidden = false;
    node.textContent = bits.join('  ·  ');
    node.title = n > MAX_TM_BP
      ? 'Nearest-neighbour Tm is a primer model; it is not meaningful over a region this long.'
      : 'NEB Q5 nearest-neighbour Tm (SantaLucia 1998), 50 mM Na⁺, 1.5 mM Mg²⁺, 200 nM primer';
  }

  function init(ove) {
    editor = ove;
    node = document.getElementById('ove-seltm');
    if (!node) return;
    refresh();

    /*
     * onSelectionOrCaretChanged only fires for OVE's own selectionLayerUpdate
     * and caretPositionUpdate actions -- it does not see a selection set via
     * updateEditor, which is how the search panel reveals a hit. Polling for a
     * changed range covers every path; the guard above makes a no-op tick
     * essentially free.
     */
    setInterval(refresh, POLL_MS);
  }

  window.OveSelectionTm = { init, refresh, onSelectionOrCaretChanged: () => refresh() };
})();
