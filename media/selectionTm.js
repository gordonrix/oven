/*
 * Length, GC and Tm for the current selection, shown in OVE's own status bar
 * alongside "Selecting N bps" and "Length".
 *
 * OVE does have a built-in melting-temp item (View -> Melting Temp of
 * Selection), but it calculates at 500 nM primer with no Mg correction, so its
 * number does not match the pipeline these primers are designed against. This
 * one uses the same NEB Q5 nearest-neighbour calculation as gibson_planner.py,
 * so the figure here is the figure the design tooling used.
 *
 * There is no prop for adding a status-bar item, so the node is appended to
 * the bar's DOM and re-appended if React ever drops it.
 */
(function () {
  'use strict';

  // Nearest-neighbour Tm is a primer model. Past this the number is
  // arithmetically fine and biologically meaningless, so say so instead.
  const MAX_TM_BP = 100;
  const POLL_MS = 400;

  let editor = null;
  let node = null;
  let observer = null;
  let lastKey = null;

  const S = () => window.CartShared;

  function state() {
    try {
      return editor.getState() || {};
    } catch (e) {
      return {};
    }
  }

  function selection() {
    const st = state();
    const sel = st.selectionLayer || {};
    if (!(typeof sel.start === 'number' && sel.start > -1 && sel.end > -1)) return null;
    const sd = st.sequenceData || {};
    const bases = S().deriveBases(sd.sequence || '', sel.start, sel.end, 1, Boolean(sd.circular));
    return bases ? { bases, start: sel.start, end: sel.end } : null;
  }

  /** Append our item to the status bar, next to the built-in ones. */
  function mount() {
    const anchor = document.querySelector('.veStatusBarItem');
    if (!anchor || !anchor.parentNode) return false;
    const bar = anchor.parentNode;

    if (!node) {
      node = document.createElement('div');
      node.className = 'veStatusBarItem ove-seltm';
      node.setAttribute('data-test', 'veStatusBar-oveCart-tm');
    }
    if (node.parentNode !== bar) bar.appendChild(node);

    // React owns this container; if a re-render ever removes our node, put it
    // back rather than silently losing the readout.
    if (!observer) {
      observer = new MutationObserver(() => {
        if (node && node.parentNode !== bar && bar.isConnected) bar.appendChild(node);
      });
      observer.observe(bar, { childList: true });
    }
    return true;
  }

  function refresh() {
    if (!mount()) return;

    const sel = selection();
    if (!sel) {
      lastKey = null;
      node.style.display = 'none';
      node.textContent = '';
      return;
    }

    const key = `${sel.start}|${sel.end}|${sel.bases.length}`;
    if (key === lastKey && node.style.display !== 'none') return;
    lastKey = key;

    const n = sel.bases.length;
    const gc = S().gcFraction(sel.bases);
    const bits = [];
    if (gc !== null) bits.push(`${Math.round(gc * 100)}% GC`);

    if (n > MAX_TM_BP) {
      bits.push(`Tm — (>${MAX_TM_BP} bp)`);
    } else {
      const tm = S().tmNebQ5(sel.bases);
      bits.push(tm === null ? 'Tm —' : `Tm ${tm.toFixed(1)} °C`);
    }

    node.style.display = '';
    node.textContent = bits.join(' · ');
    node.title = n > MAX_TM_BP
      ? `Nearest-neighbour Tm is a primer model; over ${MAX_TM_BP} bp it is not meaningful.`
      : 'NEB Q5 nearest-neighbour Tm (SantaLucia 1998), 50 mM Na⁺, 1.5 mM Mg²⁺, 200 nM primer '
        + '— the same calculation gibson_planner.py designs against.';
  }

  function init(ove) {
    editor = ove;
    refresh();

    /*
     * onSelectionOrCaretChanged only fires for OVE's own selectionLayerUpdate
     * and caretPositionUpdate actions -- it does not see a selection set via
     * updateEditor, which is how the search panel reveals a hit. Polling for a
     * changed range covers every path, and the key guard makes a quiet tick
     * essentially free. It also handles the status bar not existing yet on the
     * first call.
     */
    setInterval(refresh, POLL_MS);
  }

  window.OveSelectionTm = { init, refresh };
})();
