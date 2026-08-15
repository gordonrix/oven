/*
 * Makes OVE's own status-bar melting-temp item report the Tm your primer
 * design pipeline uses.
 *
 * OVE already has "Melting Temp of Selection" and "Percent GC Content of
 * Selection" items (View menu, both off by default). The Tm it shows is not
 * the one gibson_planner.py designs against though -- OVE calculates at 500 nM
 * primer with no Mg correction, and defaults to Breslauer rather than
 * SantaLucia. So rather than add a competing readout, this turns those items
 * on and substitutes the number in the existing one.
 *
 * The substitution only ever rewrites the value of an existing text node.
 * Replacing React-owned child *structure* invites reconciliation errors;
 * overwriting a text node's nodeValue is exactly what React itself does on an
 * update, so the worst case is that React writes its number back and the
 * observer immediately puts ours in again.
 */
(function () {
  'use strict';

  // Nearest-neighbour Tm is a primer model. Past this the number is
  // arithmetically fine and biologically meaningless, so say so instead.
  const MAX_TM_BP = 100;
  const POLL_MS = 400;
  const TM_ITEM = '[data-test="veStatusBar-selection-tm"]';

  let editor = null;
  let useDesignTm = true;

  /* OVE's own key, so its radio and its persistence are the single source. */
  const TM_TYPE_KEY = 'tmType';
  const SEEDED_KEY = 'oveCart.tmTypeSeeded';
  let observer = null;

  const S = () => window.CartShared;

  /*
   * OVE keeps the melting-temp toggle in localStorage, not in a prop, so the
   * only way to have it on by default is to seed the key before OVE first
   * reads it -- which is why this runs at script load, ahead of
   * createVectorEditor. Only when unset, so a later View-menu toggle sticks.
   */
  function seedShowMeltingTemp() {
    try {
      if (localStorage.getItem('showMeltingTemp') === null) {
        localStorage.setItem('showMeltingTemp', 'true'); // JSON, per use-local-storage-state
      }
    } catch (e) {
      /* storage unavailable; the item just stays off */
    }
  }
  seedShowMeltingTemp();

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
    return bases ? bases : null;
  }

  /**
   * The text node holding OVE's number, so only its value is touched.
   *
   * Must walk descendants, not direct children: Blueprint's Button wraps its
   * children in a span, so the number is a grandchild of the <button>.
   */
  function valueNode(item) {
    const host = item.querySelector('button') || item;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let n = walker.nextNode();
    while (n) {
      const t = n.nodeValue.trim();
      if (t && (/^-?[\d.]+$/.test(t) || t.startsWith('—'))) return n;
      n = walker.nextNode();
    }
    return null;
  }

  /*
   * Which Tm the status bar should show.
   *
   * OVE's Tm has a popover with a "Choose Tm Type" radio -- Breslauer or
   * SantaLucia -- and persists the choice in localStorage under `tmType`. This
   * module used to rewrite the number on every render regardless, so the radio
   * changed the underlying value and nothing on screen ever moved: it looked
   * broken because it effectively was.
   *
   * The two now line up honestly. Our figure IS SantaLucia -- NEB Q5, with the
   * Mg2+ and primer concentrations the design pipeline uses -- so it stands in
   * for that option, and Breslauer is left to OVE. The radio therefore moves
   * the number both ways, and because OVE stores the choice itself it survives
   * reloads and sessions with no bookkeeping here.
   */
  const TM_SANTALUCIA = 'neb_tm';

  function tmType() {
    try {
      return String(localStorage.getItem(TM_TYPE_KEY) || '').replace(/^"|"$/g, '');
    } catch (e) {
      return '';   // storage blocked
    }
  }

  /*
   * Point the radio at SantaLucia the first time, so the design Tm is what you
   * get out of the box -- the setting that turns this on says as much.
   *
   * Seeded once and remembered, because OVE writes `tmType: "default"` eagerly
   * on first render: "a value is present" cannot distinguish an untouched
   * editor from someone who deliberately chose Breslauer, so without a marker
   * of our own this would overwrite that choice on every open.
   */
  function seedTmType() {
    try {
      if (localStorage.getItem(SEEDED_KEY)) return;
      localStorage.setItem(SEEDED_KEY, '1');
      if (tmType() === 'default') localStorage.setItem(TM_TYPE_KEY, TM_SANTALUCIA);
    } catch (e) { /* storage blocked -- the radio still works, ours is not default */ }
  }

  function apply() {
    if (!useDesignTm || !editor || tmType() !== TM_SANTALUCIA) return;
    const item = document.querySelector(TM_ITEM);
    if (!item) return;

    const bases = selection();
    const n = bases ? bases.length : 0;

    let text;
    if (!bases) {
      text = '— '; // OVE shows a bare 0 with nothing selected, which reads as a real value
    } else if (n > MAX_TM_BP) {
      text = `— (>${MAX_TM_BP} bp) `;
    } else if (n < S().MIN_TM_BP) {
      // Below this the nearest-neighbour model returns nonsense, and used to
      // put a negative temperature in the status bar.
      text = `— (<${S().MIN_TM_BP} bp) `;
    } else {
      const tm = S().tmNebQ5(bases);
      text = tm === null ? '— ' : `${tm.toFixed(1)} `;
    }

    const node = valueNode(item);
    if (node && node.nodeValue !== text) node.nodeValue = text;

    const host = item.querySelector('button') || item;
    const tip = !bases ? 'Select a region to see its melting temperature.'
      : n > MAX_TM_BP
      ? `Nearest-neighbour Tm is a primer model; over ${MAX_TM_BP} bp it is not meaningful.`
      : n < S().MIN_TM_BP
      ? `Nearest-neighbour Tm is a two-state duplex model; under ${S().MIN_TM_BP} bp it breaks down.`
      : 'NEB Q5 nearest-neighbour Tm (SantaLucia 1998), 50 mM Na⁺, 1.5 mM Mg²⁺, 200 nM primer '
        + '— the same calculation gibson_planner.py designs against.';
    if (host.title !== tip) host.title = tip;
  }

  function init(ove, opts) {
    editor = ove;
    const o = opts || {};
    if (o.useDesignTm === false) useDesignTm = false;
    if (!useDesignTm) return;

    seedTmType();
    apply();

    // React rewrites the number on every selection change; re-apply after it.
    observer = new MutationObserver(() => apply());
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // Belt and braces for selections set via updateEditor, which OVE's own
    // onSelectionOrCaretChanged never sees.
    setInterval(apply, POLL_MS);
  }

  window.OveSelectionTm = { init, refresh: apply };
})();
