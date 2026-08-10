/*
 * Primer search overlay, running inside the OVE webview.
 *
 * Finds primers from the configured inventory that bind the open plasmid, and
 * attaches a chosen one as a primer_bind annotation.
 *
 * The matching itself happens in the extension host (that is where the
 * inventory file lives); this module owns the UI, the scope, and the attach.
 */
(function () {
  'use strict';

  let vscodeApi = null;
  let editor = null;
  let overlay = null;

  let state = {
    loading: false,
    hits: [],
    inventory: { status: 'disabled' },
    scoped: false,
    selection: null,
    tookMs: 0,
    truncated: false,
    scanned: 0
  };
  let fullLengthOnly = false;
  let filterText = '';
  let wantScoped = true;

  const S = () => window.CartShared;
  const post = (m) => vscodeApi && vscodeApi.postMessage(m);
  const toast = (kind, text) => window.toastr && window.toastr[kind] && window.toastr[kind](text);

  function seqState() {
    try {
      return editor.getState() || {};
    } catch (e) {
      console.error('primer search: could not read editor state', e);
      return {};
    }
  }

  function currentSelection() {
    const sel = (seqState().selectionLayer) || {};
    return typeof sel.start === 'number' && sel.start > -1 && sel.end > -1
      ? { start: sel.start, end: sel.end }
      : null;
  }

  /* ------------------------------------------------------------- search -- */

  function run(scoped) {
    const sd = seqState().sequenceData || {};
    const sequence = sd.sequence || '';
    if (!sequence) { toast('warning', 'No sequence to search'); return; }

    const selection = scoped ? currentSelection() : null;
    wantScoped = Boolean(selection);
    state.loading = true;
    render();
    post({ type: 'search/run', sequence, circular: Boolean(sd.circular), selection });
  }

  function open(opts) {
    const o = opts || {};
    // The cart picker and this overlay share the backdrop chrome; make sure
    // only one is ever mounted.
    document.querySelectorAll('.ovecart-backdrop').forEach((n) => n.remove());
    const sel = currentSelection();
    run(o.scoped !== false && Boolean(sel));
  }

  /* -------------------------------------------------------------- attach -- */

  /** Primers already in the file, keyed by footprint, so hits can be marked. */
  function attachedKeys() {
    const primers = (seqState().sequenceData || {}).primers || {};
    const keys = new Set();
    for (const id of Object.keys(primers)) {
      const p = primers[id];
      const strand = p.strand === -1 || p.forward === false ? -1 : 1;
      keys.add(`${p.start}|${p.end}|${strand}`);
    }
    return keys;
  }

  const hitKey = (h) => `${h.start}|${h.end}|${h.strand}`;

  function attach(hit) {
    const sd = seqState().sequenceData;
    if (!sd) { toast('error', 'Editor not ready'); return; }

    const id = `inv-${hit.name || 'primer'}-${hit.strand === 1 ? 'f' : 'r'}-${hit.threePrime}`
      .replace(/[^A-Za-z0-9_-]/g, '_');

    const note = `Attached from primer inventory · ${hit.anneal} nt anneal` +
      (hit.overhang ? ` · ${hit.overhang} nt 5' tail not present in this template` : ' · full-length match');

    /*
     * justPassingPartialSeqData is not optional. Without it updateEditor
     * REPLACES sequenceData wholesale and tidyUpSequenceData then coerces the
     * missing keys to empty -- verified to leave a 0 bp "Untitled Sequence"
     * with no features. And the primers map is replaced even on the partial
     * path, so the existing primers must be spread in by hand.
     */
    editor.updateEditor({
      justPassingPartialSeqData: true,
      sequenceData: {
        primers: Object.assign({}, sd.primers, {
          [id]: {
            id,
            name: hit.name || 'inventory primer',
            type: 'primer_bind',
            start: hit.start,
            end: hit.end,
            forward: hit.strand === 1,
            bases: String(hit.sequence || '').toUpperCase(),
            notes: { Sequence: [hit.sequence], note: [note] }
          }
        })
      }
    });

    toast('success', `Attached ${hit.name}${hit.overhang ? ` (${hit.overhang} nt tail)` : ''}`);
    render();
  }

  function reveal(hit) {
    // Scrolls the sequence view; caretPosition is what RowView watches.
    editor.updateEditor({ caretPosition: hit.threePrime });
  }

  /* ------------------------------------------------------------ rendering -- */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function close() {
    if (overlay) overlay.remove();
    overlay = null;
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function visibleHits() {
    let hits = state.hits;
    if (fullLengthOnly) hits = hits.filter((h) => h.overhang === 0);
    const q = filterText.trim().toLowerCase();
    if (q) {
      hits = hits.filter((h) =>
        (h.name || '').toLowerCase().includes(q) ||
        (h.alias || '').toLowerCase().includes(q) ||
        (h.sequence || '').toLowerCase().includes(q));
    }
    return hits;
  }

  function render() {
    const scrollTop = overlay ? (overlay.querySelector('.ovesearch-list') || {}).scrollTop : 0;
    close();

    overlay = el('div', 'ovecart-backdrop');
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

    const panel = el('div', 'ovecart-panel ovesearch-panel');

    // --- header
    const head = el('div', 'ovecart-head');
    head.appendChild(el('span', 'ovecart-title', 'Primer search'));
    const x = el('button', 'ovecart-x', '×');
    x.addEventListener('click', close);
    head.appendChild(x);
    panel.appendChild(head);

    // --- controls
    const controls = el('div', 'ovesearch-controls');
    const sel = currentSelection();

    const scopeWrap = el('div', 'ovesearch-scope');
    const mkScope = (label, scoped, disabled) => {
      const b = el('button', 'ovesearch-tab' + (state.scoped === scoped ? ' is-active' : ''), label);
      b.disabled = Boolean(disabled) || state.loading;
      b.addEventListener('click', () => run(scoped));
      return b;
    };
    scopeWrap.appendChild(mkScope(
      sel ? `Selection ${sel.start + 1}..${sel.end + 1}` : 'Selection (none)', true, !sel));
    scopeWrap.appendChild(mkScope('Whole plasmid', false, false));
    controls.appendChild(scopeWrap);

    const fullWrap = el('label', 'ovesearch-check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = fullLengthOnly;
    cb.addEventListener('change', () => { fullLengthOnly = cb.checked; render(); });
    fullWrap.appendChild(cb);
    fullWrap.appendChild(el('span', null, '100% match only'));
    fullWrap.title = 'Hide primers whose 5′ tail is not present in this template';
    controls.appendChild(fullWrap);

    const filter = el('input', 'ovesearch-filter');
    filter.type = 'search';
    filter.placeholder = 'Filter by name, alias or sequence…';
    filter.value = filterText;
    filter.addEventListener('input', () => {
      filterText = filter.value;
      renderList(list, countEl);
    });
    controls.appendChild(filter);
    panel.appendChild(controls);

    const countEl = el('div', 'ovesearch-count');
    panel.appendChild(countEl);

    const list = el('div', 'ovesearch-list');
    panel.appendChild(list);
    renderList(list, countEl);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    if (scrollTop) {
      const l = overlay.querySelector('.ovesearch-list');
      if (l) l.scrollTop = scrollTop;
    }
  }

  function renderList(list, countEl) {
    list.textContent = '';
    const inv = state.inventory || { status: 'disabled' };

    if (state.loading) {
      countEl.textContent = 'Searching…';
      list.appendChild(el('div', 'ovesearch-empty', 'Matching the inventory against this sequence…'));
      return;
    }

    // Inventory not usable: say so and offer the fix, rather than "0 results".
    if (inv.status === 'disabled') {
      countEl.textContent = '';
      const box = el('div', 'ovesearch-empty');
      box.appendChild(el('div', null, 'No primer inventory configured.'));
      box.appendChild(el('div', 'ovesearch-dim',
        'Point the extension at a spreadsheet of primers you already own (.xlsx or .csv) to search it.'));
      const pick = el('button', 'ovecart-primary', 'Choose file…');
      pick.addEventListener('click', () => post({ type: 'search/pickInventory' }));
      box.appendChild(pick);
      list.appendChild(box);
      return;
    }
    if (inv.status !== 'ok') {
      countEl.textContent = '';
      const box = el('div', 'ovesearch-empty ovesearch-error');
      box.appendChild(el('div', null, 'The primer inventory could not be read.'));
      if (inv.message) box.appendChild(el('div', 'ovesearch-dim', inv.message));
      const pick = el('button', 'ovecart-secondary', 'Choose a different file…');
      pick.addEventListener('click', () => post({ type: 'search/pickInventory' }));
      box.appendChild(pick);
      list.appendChild(box);
      return;
    }

    const hits = visibleHits();
    const bits = [`${hits.length}${hits.length === state.hits.length ? '' : ' of ' + state.hits.length} hit${state.hits.length === 1 ? '' : 's'}`];
    bits.push(state.scoped ? 'in selection' : 'in whole plasmid');
    bits.push(`${inv.rowCount} primers searched in ${state.tookMs} ms`);
    if (state.truncated) bits.push('results capped');
    countEl.textContent = bits.join(' · ');

    if (!state.hits.length) {
      const box = el('div', 'ovesearch-empty');
      box.appendChild(el('div', null, state.scoped
        ? 'No inventory primer binds inside the selection.'
        : 'No inventory primer binds this plasmid.'));
      if (state.scoped) {
        const wide = el('button', 'ovecart-secondary', 'Search the whole plasmid instead');
        wide.addEventListener('click', () => run(false));
        box.appendChild(wide);
      }
      list.appendChild(box);
      return;
    }
    if (!hits.length) {
      list.appendChild(el('div', 'ovesearch-empty', 'Every hit is filtered out by the options above.'));
      return;
    }

    const attached = attachedKeys();

    const header = el('div', 'ovesearch-row ovesearch-header');
    ['Pos', 'Str', 'Name', 'Anneal', 'Tm', "5′ tail", 'Alias', ''].forEach((h, i) => {
      header.appendChild(el('div', 'ovesearch-c' + i, h));
    });
    list.appendChild(header);

    for (const hit of hits) {
      const row = el('div', 'ovesearch-row');
      const isAttached = attached.has(hitKey(hit));
      if (isAttached) row.classList.add('is-attached');

      row.appendChild(el('div', 'ovesearch-c0', String(hit.threePrime + 1) + (hit.wraps ? '↩' : '')));
      const strand = el('div', 'ovesearch-c1 ' + (hit.strand === 1 ? 'fwd' : 'rev'), hit.strand === 1 ? '+' : '−');
      strand.title = hit.strand === 1 ? 'forward' : 'reverse';
      row.appendChild(strand);

      const name = el('div', 'ovesearch-c2', hit.name || '(unnamed)');
      name.title = `${hit.sequence}\n\n${hit.description || ''}`.trim();
      row.appendChild(name);

      row.appendChild(el('div', 'ovesearch-c3', `${hit.anneal} nt`));
      row.appendChild(el('div', 'ovesearch-c4', hit.tm === null ? '—' : String(hit.tm)));
      row.appendChild(el('div', 'ovesearch-c5' + (hit.overhang ? ' has-tail' : ''),
        hit.overhang ? `+${hit.overhang}` : '—'));
      row.appendChild(el('div', 'ovesearch-c6', hit.alias || ''));

      const actions = el('div', 'ovesearch-c7');
      const btn = el('button', 'ovesearch-attach', isAttached ? 'Attached' : 'Attach');
      btn.disabled = isAttached;
      btn.title = isAttached
        ? 'A primer already covers this footprint'
        : 'Add a primer_bind annotation over the annealing region';
      btn.addEventListener('click', (e) => { e.stopPropagation(); attach(hit); });
      actions.appendChild(btn);
      row.appendChild(actions);

      row.addEventListener('click', () => reveal(hit));
      list.appendChild(row);
    }
  }

  /* -------------------------------------------------------- integration -- */

  /** Menu entry appended to OVE's right-click menus. Plain object, no React. */
  function searchItem(scoped) {
    return {
      text: scoped ? 'Search primers in selection' : 'Search primers in plasmid',
      className: 'ove-search-menu-item',
      onClick: () => open({ scoped })
    };
  }

  function withSearch(items, scoped) {
    const out = [...items, '--', searchItem(scoped)];
    // backgroundRightClicked hangs the originating event off the array itself;
    // a rebuilt array loses the menu's anchor without this.
    out._event = items._event;
    return out;
  }

  // Stable reference: OVE memoises on identity and warns if it changes.
  const rightClickOverrides = {
    selectionLayerRightClicked: (items) => withSearch(items, true),
    backgroundRightClicked: (items) => withSearch(items, false),
    featureRightClicked: (items) => withSearch(items, true),
    primerRightClicked: (items) => withSearch(items, true),
    partRightClicked: (items) => withSearch(items, true)
  };

  function init(api, ove) {
    vscodeApi = api;
    editor = ove;
    window.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.type === 'search/results') {
        state = {
          loading: false,
          hits: msg.hits || [],
          inventory: msg.inventory || { status: 'disabled' },
          scoped: Boolean(msg.scoped),
          selection: msg.selection || null,
          tookMs: msg.tookMs || 0,
          truncated: Boolean(msg.truncated),
          scanned: msg.scanned || 0
        };
        if (msg.fullLengthOnly && !overlay) fullLengthOnly = true;
        render();
      } else if (msg.type === 'search/inventoryChanged') {
        run(state.scoped);
      }
    });
  }

  window.OveSearch = { init, open, rightClickOverrides, attach };
})();
