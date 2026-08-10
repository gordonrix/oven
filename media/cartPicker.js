/*
 * The "Cart" button's overlay, running inside the OVE webview.
 *
 * Plain DOM on purpose. The obvious alternative, OVE's
 * additionalTopRightToolbarButtons prop, needs React elements and the UMD
 * bundle does not export React. The extension's existing Save button already
 * establishes the pattern of injecting a fixed-position control over the
 * editor, and unlike OVE's menu internals it cannot break under a bundle
 * upgrade.
 */
(function () {
  'use strict';

  let vscodeApi = null;
  let editor = null;
  let inCart = new Set();
  let overlay = null;

  const S = () => window.CartShared;

  function state() {
    try {
      return editor.getState() || {};
    } catch (e) {
      console.error('primer cart: could not read editor state', e);
      return {};
    }
  }

  function post(msg) {
    if (vscodeApi) vscodeApi.postMessage(msg);
  }

  function toast(kind, text) {
    if (window.toastr && window.toastr[kind]) window.toastr[kind](text);
  }

  function setCount(n) {
    const btn = document.getElementById('ove-cart-button');
    if (btn) btn.textContent = n ? `Cart (${n})` : 'Cart';
  }

  /** Every primer in the open file, plus the live selection if there is one. */
  function collectRows() {
    const st = state();
    const sd = st.sequenceData || {};
    const sequence = sd.sequence || '';
    const circular = Boolean(sd.circular);
    const rows = [];

    const sel = st.selectionLayer || {};
    if (typeof sel.start === 'number' && sel.start > -1 && typeof sel.end === 'number' && sel.end > -1) {
      const bases = S().deriveBases(sequence, sel.start, sel.end, 1, circular);
      if (bases) {
        rows.push({
          kind: 'selection',
          name: '',
          sequence: bases,
          start: sel.start,
          end: sel.end,
          strand: 1,
          circularWrap: S().wrapsOrigin(sel.start, sel.end, circular)
        });
      }
    }

    // primers arrive from the parser as an id-keyed object, not an array
    const primers = sd.primers || {};
    for (const key of Object.keys(primers)) {
      const p = primers[key];
      if (!p) continue;
      const strand = p.strand === -1 || p.forward === false ? -1 : 1;
      const bases = p.bases || S().deriveBases(sequence, p.start, p.end, strand, circular);
      if (!bases) continue;
      rows.push({
        kind: 'primer',
        name: p.name || 'unnamed primer',
        sequence: bases.toUpperCase(),
        start: p.start,
        end: p.end,
        strand,
        circularWrap: S().wrapsOrigin(p.start, p.end, circular),
        notes: p.notes
      });
    }
    return rows;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function close() {
    if (overlay) overlay.remove();
    overlay = null;
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  function openPicker() {
    close();
    const rows = collectRows();

    overlay = el('div', 'ovecart-backdrop');
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });

    const panel = el('div', 'ovecart-panel');
    const head = el('div', 'ovecart-head');
    head.appendChild(el('span', 'ovecart-title', 'Add primers to cart'));
    const closeBtn = el('button', 'ovecart-x', '×');
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', close);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    if (!rows.length) {
      panel.appendChild(el('div', 'ovecart-empty',
        'No primers in this file, and nothing selected. Select a region, or use Create → New Primer.'));
    }

    const filter = el('input', 'ovecart-filter');
    filter.type = 'search';
    filter.placeholder = 'Filter by name or sequence…';
    if (rows.length) panel.appendChild(filter);

    const list = el('div', 'ovecart-list');
    const checkboxes = [];

    rows.forEach((row, i) => {
      const already = inCart.has(S().normalizeSeqKey(row.sequence));
      const item = el('label', 'ovecart-row' + (already ? ' is-carted' : ''));

      const cb = el('input');
      cb.type = 'checkbox';
      cb.disabled = already;
      cb.checked = already;
      cb.dataset.index = String(i);
      checkboxes.push(cb);
      item.appendChild(cb);

      const body = el('div', 'ovecart-body');
      const line1 = el('div', 'ovecart-line1');

      if (row.kind === 'selection') {
        const nameInput = el('input', 'ovecart-name');
        nameInput.type = 'text';
        nameInput.placeholder = 'name this selection…';
        nameInput.addEventListener('input', () => { row.name = nameInput.value; });
        nameInput.addEventListener('click', (e) => e.preventDefault());
        line1.appendChild(el('span', 'ovecart-tag', 'selection'));
        line1.appendChild(nameInput);
      } else {
        line1.appendChild(el('span', 'ovecart-name-text', row.name));
      }
      if (already) line1.appendChild(el('span', 'ovecart-badge', 'in cart'));
      body.appendChild(line1);

      const seqSpan = el('div', 'ovecart-seq',
        row.sequence.length > 60 ? row.sequence.slice(0, 57) + '…' : row.sequence);
      seqSpan.title = row.sequence;
      body.appendChild(seqSpan);

      const meta = `${row.sequence.length} bp · ${row.strand === -1 ? 'reverse' : 'forward'}` +
        (typeof row.start === 'number' ? ` · ${row.start + 1}..${row.end + 1}` : '') +
        (row.circularWrap ? ' (wraps origin)' : '');
      body.appendChild(el('div', 'ovecart-meta', meta));

      item.appendChild(body);
      list.appendChild(item);
    });
    panel.appendChild(list);

    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      [...list.children].forEach((node, i) => {
        const r = rows[i];
        const hit = !q || r.name.toLowerCase().includes(q) || r.sequence.toLowerCase().includes(q);
        node.style.display = hit ? '' : 'none';
      });
    });

    const foot = el('div', 'ovecart-foot');
    const selectAll = el('button', 'ovecart-secondary', 'Select all primers');
    selectAll.addEventListener('click', () => {
      checkboxes.forEach((cb, i) => {
        if (!cb.disabled && rows[i].kind === 'primer' && list.children[i].style.display !== 'none') cb.checked = true;
      });
    });
    foot.appendChild(selectAll);

    const spacer = el('div', 'ovecart-spacer');
    foot.appendChild(spacer);

    const cancel = el('button', 'ovecart-secondary', 'Cancel');
    cancel.addEventListener('click', close);
    foot.appendChild(cancel);

    const add = el('button', 'ovecart-primary', 'Add to cart');
    add.addEventListener('click', () => {
      const picked = checkboxes
        .map((cb, i) => (cb.checked && !cb.disabled ? rows[i] : null))
        .filter(Boolean)
        .map((r) => ({
          name: r.name && r.name.trim() ? r.name.trim() : defaultName(r),
          sequence: r.sequence,
          start: r.start,
          end: r.end,
          strand: r.strand,
          circularWrap: r.circularWrap,
          notes: r.notes
        }));
      if (!picked.length) {
        toast('info', 'Nothing selected');
        return;
      }
      post({ type: 'cart/add', origin: 'picker', items: picked });
      close();
    });
    foot.appendChild(add);
    panel.appendChild(foot);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    if (rows.length) filter.focus();
  }

  function defaultName(row) {
    const sd = state().sequenceData || {};
    const base = sd.name || 'sequence';
    return row.kind === 'selection'
      ? `${base} ${row.start + 1}-${row.end + 1}`
      : 'unnamed primer';
  }

  /** Called from beforeAnnotationCreate the moment a primer is designed. */
  function addCreated(info) {
    const ann = info.annotation || {};
    const sd = state().sequenceData || {};
    const strand = ann.strand === -1 || ann.forward === false ? -1 : 1;
    const sequence = (info.bases ||
      S().deriveBases(sd.sequence || '', ann.start, ann.end, strand, Boolean(sd.circular)) || '').toUpperCase();
    if (!sequence) return;

    post({
      type: 'cart/add',
      origin: 'created',
      items: [{
        name: ann.name || 'new primer',
        sequence,
        start: ann.start,
        end: ann.end,
        strand,
        circularWrap: S().wrapsOrigin(ann.start, ann.end, Boolean(sd.circular)),
        notes: ann.notes
      }]
    });
  }

  function init(api, ove) {
    vscodeApi = api;
    editor = ove;
    window.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.type === 'cart/state') {
        inCart = new Set(msg.inCart || []);
        setCount(msg.count || 0);
      } else if (msg.type === 'cart/ack') {
        if (msg.error) toast('error', msg.error);
        else if (msg.added) {
          toast('success', `Added ${msg.added} primer${msg.added === 1 ? '' : 's'} to cart` +
            (msg.duplicates ? ` (${msg.duplicates} already there)` : ''));
        } else if (msg.duplicates) {
          toast('info', 'Already in cart');
        }
      }
    });
    post({ type: 'cart/requestState' });
  }

  window.OveCart = { init, openPicker, addCreated };
})();
