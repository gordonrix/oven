/*
 * Primer search, rendered as a native OVE panel.
 *
 * It started as a modal overlay, which covered the very sequence you were
 * trying to look at. OVE turns out to accept a `panelMap` prop that is merged
 * over its built-in one, so "Primer Search" can be a real tab sitting beside
 * Sequence Map in OVE's own split layout -- resizable, reorderable, and with
 * the sequence still visible while you scan the results.
 *
 * A panel has to be a React component, and the UMD bundle does not export
 * React. It does not need to: a React element is a plain object tagged with
 * Symbol.for('react.element'), and that symbol comes from the global registry,
 * so one can be hand-built. The component returns a single such element -- a
 * div with a stable ref -- and everything inside it is ordinary DOM.
 *
 * Matching runs in the extension host, where the inventory file lives; this
 * module owns the panel, the scope, and the attach.
 */
(function () {
  'use strict';

  const PANEL_ID = 'primerSearch';
  const PANEL_NAME = 'Primer Search';
  const REACT_ELEMENT = Symbol.for('react.element');

  let vscodeApi = null;
  let editor = null;
  let root = null; // the DOM node OVE handed us for the panel body

  let state = {
    loading: false,
    ran: false,
    hits: [],
    inventory: { status: 'disabled' },
    scoped: false,
    tookMs: 0,
    truncated: false
  };
  let fullLengthOnly = false;
  let filterText = '';

  // Pos, Str, Name, Anneal, Tm, Tail, Alias, action
  const COLUMN_DEFAULTS = [56, 26, 56, 48, 46, 46, 130, 62];
  const MIN_COLUMN = 24;
  let columnWidths = COLUMN_DEFAULTS.slice();

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
    const sel = seqState().selectionLayer || {};
    return typeof sel.start === 'number' && sel.start > -1 && sel.end > -1
      ? { start: sel.start, end: sel.end }
      : null;
  }

  /* ---------------------------------------------------- the OVE panel -- */

  /**
   * Minimal React.createElement. Only ever used for the one wrapper element;
   * everything below it is plain DOM built in mount().
   */
  function reactElement(type, props) {
    return {
      $$typeof: REACT_ELEMENT,
      type,
      key: null,
      ref: (props && props.ref) || null,
      props: Object.assign({}, props),
      _owner: null,
      _store: {}
    };
  }

  // Defined once, on purpose: an inline arrow would be a new ref on every
  // render, and React would tear the DOM down and rebuild it each time.
  const panelRef = (node) => {
    if (!node) return; // unmounting
    root = node;
    root.className = 'ovesearch-root';
    render();
  };

  function SearchPanelComponent() {
    return reactElement('div', { className: 'ovesearch-mount', ref: panelRef });
  }

  const panelMap = { [PANEL_ID]: { comp: SearchPanelComponent } };

  /**
   * Make sure the panel is on screen and focused, putting it beside the
   * sequence rather than on top of it.
   */
  function showPanel() {
    const st = seqState();
    const groups = (st.panelsShown || []).map((g) => (g || []).map((p) => Object.assign({}, p)));

    for (const group of groups) {
      const mine = group.find((p) => p.id === PANEL_ID);
      if (mine) {
        group.forEach((p) => { p.active = p.id === PANEL_ID; });
        editor.updateEditor({ panelsShown: groups });
        return;
      }
    }

    const panel = { id: PANEL_ID, name: PANEL_NAME, active: true };
    if (groups.length <= 1) {
      // Split the view so the sequence stays visible next to the results.
      groups.push([panel]);
    } else {
      const target = groups[groups.length - 1];
      target.forEach((p) => { p.active = false; });
      target.push(panel);
    }
    editor.updateEditor({ panelsShown: groups });
  }

  /**
   * Take the panel back off screen.
   *
   * OVE has no close affordance on a panel it did not put there, so this
   * removes it from `panelsShown` -- and drops the group with it if it was the
   * only thing in it, which un-splits the view rather than leaving an empty
   * half beside the sequence.
   */
  function hidePanel() {
    const groups = (seqState().panelsShown || [])
      .map((g) => (g || []).filter((p) => p.id !== PANEL_ID).map((p) => Object.assign({}, p)))
      .filter((g) => g.length);

    // Something has to stay active in each group, or the group renders blank.
    for (const group of groups) {
      if (!group.some((p) => p.active)) group[0].active = true;
    }
    editor.updateEditor({ panelsShown: groups });
  }

  /* --------------------------------------------------------- searching -- */

  function run(scoped) {
    const sd = seqState().sequenceData || {};
    const sequence = sd.sequence || '';
    if (!sequence) { toast('warning', 'No sequence to search'); return; }

    const selection = scoped ? currentSelection() : null;
    state.loading = true;
    state.ran = true;
    render();
    post({ type: 'search/run', sequence, circular: Boolean(sd.circular), selection });
  }

  function open(opts) {
    const o = opts || {};
    showPanel();
    // Let OVE lay the panel out before the first paint of results.
    setTimeout(() => run(o.scoped !== false && Boolean(currentSelection())), 0);
  }

  /* ---------------------------------------------------------- attaching -- */

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
     * REPLACES sequenceData wholesale and tidyUpSequenceData coerces the
     * missing keys to empty -- verified to leave a 0 bp "Untitled Sequence"
     * with no features. The primers map is replaced even on the partial path,
     * so the existing primers must be spread in by hand.
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

  /**
   * Select and scroll to a hit's footprint so it is visible in the map.
   *
   * The className rides through to the rendered layer div, which is what gives
   * the hit a strand indicator -- a selection alone carries no strand.
   */
  function reveal(hit) {
    editor.updateEditor({
      selectionLayer: {
        start: hit.start,
        end: hit.end,
        forceUpdate: hit.threePrime,
        className: hit.strand === 1 ? 'ove-strand-fwd' : 'ove-strand-rev'
      },
      caretPosition: -1
    });
  }

  /* ---------------------------------------------------------- rendering -- */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  /* ------------------------------------------------- column resizing -- */

  /**
   * Widths drive a single CSS variable on the root, so a drag restyles the
   * whole table without re-rendering a row -- which is what keeps it smooth.
   */
  function applyWidths() {
    if (root) root.style.setProperty('--ovesearch-cols', columnWidths.map((w) => `${w}px`).join(' '));
  }

  function persistWidths() {
    post({ type: 'search/setColumnWidths', widths: columnWidths });
  }

  function makeGrip(colIndex) {
    const grip = el('div', 'ovesearch-grip');
    grip.title = 'Drag to resize · double-click to reset all columns';

    grip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation(); // the header must not treat this as a row click
      const startX = e.clientX;
      const startWidth = columnWidths[colIndex];

      const onMove = (ev) => {
        columnWidths[colIndex] = Math.max(MIN_COLUMN, Math.round(startWidth + ev.clientX - startX));
        applyWidths();
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('ovesearch-resizing');
        persistWidths();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.body.classList.add('ovesearch-resizing');
    });

    grip.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      columnWidths = COLUMN_DEFAULTS.slice();
      applyWidths();
      persistWidths();
    });

    return grip;
  }

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
    if (!root) return;
    root.textContent = '';

    root.appendChild(buildControls());
    const count = el('div', 'ovesearch-count');
    root.appendChild(count);
    const list = el('div', 'ovesearch-list');
    root.appendChild(list);
    renderList(list, count);
  }

  function buildControls() {
    const controls = el('div', 'ovesearch-controls');
    const sel = currentSelection();

    const scope = el('div', 'ovesearch-scope');
    const tab = (label, scoped, disabled) => {
      const b = el('button', 'ovesearch-tab' + (state.ran && state.scoped === scoped ? ' is-active' : ''), label);
      b.disabled = Boolean(disabled) || state.loading;
      b.addEventListener('click', () => run(scoped));
      return b;
    };
    scope.appendChild(tab(sel ? `Selection ${sel.start + 1}..${sel.end + 1}` : 'Selection', true, !sel));
    scope.appendChild(tab('Whole plasmid', false, false));
    controls.appendChild(scope);

    const close = el('button', 'ovesearch-close', '\u00d7');
    close.title = 'Close primer search';
    close.addEventListener('click', hidePanel);
    controls.appendChild(close);

    const check = el('label', 'ovesearch-check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = fullLengthOnly;
    cb.addEventListener('change', () => { fullLengthOnly = cb.checked; render(); });
    check.appendChild(cb);
    check.appendChild(el('span', null, '100% match'));
    check.title = 'Hide primers whose 5′ tail is not present in this template';
    controls.appendChild(check);

    const filter = el('input', 'ovesearch-filter');
    filter.type = 'search';
    filter.placeholder = 'Filter…';
    filter.value = filterText;
    filter.addEventListener('input', () => {
      filterText = filter.value;
      const list = root.querySelector('.ovesearch-list');
      const count = root.querySelector('.ovesearch-count');
      if (list && count) renderList(list, count);
    });
    controls.appendChild(filter);

    return controls;
  }

  function renderList(list, countEl) {
    list.textContent = '';
    const inv = state.inventory || { status: 'disabled' };

    if (state.loading) {
      countEl.textContent = 'Searching…';
      return;
    }

    if (!state.ran) {
      countEl.textContent = '';
      list.appendChild(el('div', 'ovesearch-empty',
        'Choose a scope above to find inventory primers that bind this plasmid.'));
      return;
    }

    if (inv.status === 'disabled') {
      countEl.textContent = '';
      const box = el('div', 'ovesearch-empty');
      box.appendChild(el('div', 'ovesearch-strong', 'No primer inventory configured.'));
      box.appendChild(el('div', 'ovesearch-dim',
        'Point the extension at a spreadsheet of primers you already own (.xlsx or .csv) to search it.'));
      const pick = el('button', 'ovesearch-cta', 'Choose file…');
      pick.addEventListener('click', () => post({ type: 'search/pickInventory' }));
      box.appendChild(pick);
      list.appendChild(box);
      return;
    }
    if (inv.status !== 'ok') {
      countEl.textContent = '';
      const box = el('div', 'ovesearch-empty ovesearch-error');
      box.appendChild(el('div', 'ovesearch-strong', 'The primer inventory could not be read.'));
      if (inv.message) box.appendChild(el('div', 'ovesearch-dim', inv.message));
      const pick = el('button', 'ovesearch-cta', 'Choose a different file…');
      pick.addEventListener('click', () => post({ type: 'search/pickInventory' }));
      box.appendChild(pick);
      list.appendChild(box);
      return;
    }

    const hits = visibleHits();
    const bits = [`${hits.length}${hits.length === state.hits.length ? '' : ' of ' + state.hits.length} hit${state.hits.length === 1 ? '' : 's'}`];
    bits.push(state.scoped ? 'in selection' : 'whole plasmid');
    bits.push(`${inv.rowCount} searched · ${state.tookMs} ms`);
    if (state.truncated) bits.push('capped');
    countEl.textContent = bits.join(' · ');

    if (!state.hits.length) {
      const box = el('div', 'ovesearch-empty');
      box.appendChild(el('div', null, state.scoped
        ? 'No inventory primer binds inside the selection.'
        : 'No inventory primer binds this plasmid.'));
      if (state.scoped) {
        const wide = el('button', 'ovesearch-cta', 'Search the whole plasmid');
        wide.addEventListener('click', () => run(false));
        box.appendChild(wide);
      }
      list.appendChild(box);
      return;
    }
    if (!hits.length) {
      list.appendChild(el('div', 'ovesearch-empty', 'Everything is filtered out by the options above.'));
      return;
    }

    const attached = attachedKeys();

    const header = el('div', 'ovesearch-row ovesearch-header');
    ['Pos', 'Str', 'Name', 'Anneal', 'Tm', 'Tail', 'Alias', ''].forEach((h, i) => {
      const cell = el('div', 'ovesearch-c' + i, h);
      cell.appendChild(makeGrip(i));
      header.appendChild(cell);
    });
    list.appendChild(header);
    applyWidths();

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

      row.appendChild(el('div', 'ovesearch-c3', `${hit.anneal}`));
      row.appendChild(el('div', 'ovesearch-c4', hit.tm === null ? '—' : String(hit.tm)));
      row.appendChild(el('div', 'ovesearch-c5' + (hit.overhang ? ' has-tail' : ''),
        hit.overhang ? `+${hit.overhang}` : '—'));
      row.appendChild(el('div', 'ovesearch-c6', hit.alias || ''));

      const actions = el('div', 'ovesearch-c7');
      const btn = el('button', 'ovesearch-attach', isAttached ? '✓' : 'Attach');
      btn.disabled = isAttached;
      btn.title = isAttached
        ? 'A primer already covers this footprint'
        : 'Add a primer_bind annotation over the annealing region';
      btn.addEventListener('click', (e) => { e.stopPropagation(); attach(hit); });
      actions.appendChild(btn);
      row.appendChild(actions);

      row.title = 'Click to select and scroll to this binding site';
      row.addEventListener('click', () => reveal(hit));
      list.appendChild(row);
    }
  }

  /* -------------------------------------------------------- integration -- */

  /*
   * The scope is decided from the live selection rather than from which menu
   * was opened. Right-clicking a feature with a selection active should still
   * search the selection, and right-clicking anywhere with nothing selected
   * should search the plasmid -- keying it off the menu instead got this wrong
   * both ways.
   */
  function withSearch(items, opts, props) {
    const scoped = Boolean(currentSelection());
    const out = [...items, '--', {
      text: scoped ? 'Search primers in selection' : 'Search primers in plasmid',
      className: 'ove-search-menu-item',
      onClick: () => open({ scoped })
    },
    // Only ever appends on a translation, and only when the click can be tied
    // to one residue -- it returns nothing otherwise.
    ...(window.OveAminoAcid ? window.OveAminoAcid.menuItems(opts, props) : [])];
    // backgroundRightClicked hangs the originating event off the array itself;
    // a rebuilt array loses the menu's anchor without this.
    out._event = items._event;
    return out;
  }

  /*
   * Every right-click surface, so the entry is never missing depending on what
   * happens to sit under the cursor -- a translation or ORF lying over the
   * sequence would otherwise swallow it.
   */
  const rightClickOverrides = {};
  for (const key of [
    'selectionLayerRightClicked', 'backgroundRightClicked', 'featureRightClicked',
    'primerRightClicked', 'partRightClicked', 'translationRightClicked',
    'orfRightClicked', 'cutsiteRightClicked', 'warningRightClicked',
    'searchLayerRightClicked', 'deletionLayerRightClicked', 'replacementLayerRightClicked'
  ]) {
    rightClickOverrides[key] = withSearch;
  }

  function init(api, ove) {
    vscodeApi = api;
    editor = ove;
    window.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.type === 'search/results') {
        state = {
          loading: false,
          ran: true,
          hits: msg.hits || [],
          inventory: msg.inventory || { status: 'disabled' },
          scoped: Boolean(msg.scoped),
          tookMs: msg.tookMs || 0,
          truncated: Boolean(msg.truncated)
        };
        if (msg.fullLengthOnly) fullLengthOnly = true;
        if (Array.isArray(msg.columnWidths) && msg.columnWidths.length === COLUMN_DEFAULTS.length) {
          columnWidths = msg.columnWidths.map((w) => Math.max(MIN_COLUMN, Number(w) || MIN_COLUMN));
        }
        render();
      } else if (msg.type === 'search/inventoryChanged') {
        run(state.scoped);
      }
    });
  }

  window.OveSearch = { init, open, showPanel, hidePanel, panelMap, rightClickOverrides, attach, PANEL_ID };
})();
