/*
 * The Sequence Search panel's webview.
 *
 * Built the same way as media/alignView.js -- plain DOM, one render from one
 * state object pushed by the host -- so the two panels stay recognisable as
 * siblings. The host is src/seqSearchPanel.js.
 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const post = (type, extra) => vscode.postMessage(Object.assign({ type }, extra || {}));

  let state = {
    folders: [], results: [], status: '', error: '', busy: false,
    query: '', kind: 'dna', exact: true, minIdentity: 0.9
  };

  // Held here rather than read back from the host on every keystroke: the host
  // only hears about them when Search is pressed.
  let draft = { query: '', kind: 'dna', exact: true, minIdentity: 0.9 };

  /*
   * Sort and filter are the panel's own business -- the host sends one ranked
   * list and never hears about either, so neither costs a round trip or a
   * re-search.
   *
   * `key: null` means the order the host sent, which is the ranking by score:
   * identity and length together. That is the right answer most of the time,
   * so clicking a column cycles ascending, descending, then back to it, the
   * way the primer search table does.
   */
  let sort = { key: null, dir: 1 };
  let filterText = '';

  const COLUMNS = [
    { key: 'name', label: () => 'Name', value: (h) => (h.name || '').toLowerCase() },
    { key: 'pos', label: () => 'Pos', value: (h) => h.start },
    { key: 'ident', label: () => '% ID', value: (h) => h.identity },
    {
      key: 'len',
      // A search is all one kind, so the unit belongs in the header rather than
      // repeated down every row.
      label: () => (anyFrame() ? 'Length aa' : 'Length bp'),
      value: (h) => h.length
    },
    {
      key: 'frame',
      label: () => (anyFrame() ? 'Frame' : 'Str'),
      // For a protein hit the frame carries the strand in its sign, so the one
      // column sorts sensibly either way.
      value: (h) => (h.frame || h.strand)
    }
  ];

  const anyFrame = () => state.results.some((h) => h.frame);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  /* ------------------------------------------------------------- folders -- */

  /**
   * Folders accept a drop; files do not.
   *
   * Same shape as the aligner's drop zone, including the Shift caveat: without
   * preventDefault on dragover the workbench takes the drop and opens what you
   * dropped in an editor instead of handing it over. The host does the deciding
   * -- it is the only side that can stat a path -- so anything dropped goes
   * over and comes back refused if it was a file.
   */
  function wireDropZone(zone) {
    const over = (on) => (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.toggle('is-over', on);
    };
    zone.addEventListener('dragenter', over(true));
    zone.addEventListener('dragover', over(true));
    zone.addEventListener('dragleave', over(false));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('is-over');
      const list = (e.dataTransfer && e.dataTransfer.getData('text/uri-list')) || '';
      const uris = list.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
      if (uris.length) post('seqsearch/addUris', { uris });
      else setStatus('Nothing usable in that drop — try Browse instead.');
    });
  }

  function folderChip(folder) {
    const chip = el('div', 'oveseq-folder');

    const name = el('span', 'oveseq-foldername', folder.path.split('/').filter(Boolean).pop() || folder.path);
    name.title = folder.path;
    chip.appendChild(name);

    // Lighter than the file count on purpose: it qualifies the folder rather
    // than telling you anything about it.
    if (folder.subfolders) chip.appendChild(el('span', 'oveseq-foldersub', 'and subfolders'));

    if (folder.files) {
      chip.appendChild(el('span', 'oveseq-foldercount',
        `${folder.files} file${folder.files === 1 ? '' : 's'}`));
    }

    const sub = el('label', 'oveseq-foldertick');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = Boolean(folder.subfolders);
    box.title = 'Search subfolders too';
    box.addEventListener('change', () =>
      post('seqsearch/setSubfolders', { path: folder.path, subfolders: box.checked }));
    sub.appendChild(box);
    chip.appendChild(sub);

    const shut = el('button', 'oveseq-x', '×');
    shut.title = 'Stop searching this folder';
    shut.addEventListener('click', () => post('seqsearch/removeFolder', { path: folder.path }));
    chip.appendChild(shut);

    return chip;
  }

  /* ----------------------------------------------------------- rendering -- */

  function setStatus(text, bad) {
    const node = document.querySelector('.oveseq-status');
    if (!node) return;
    node.textContent = text || '';
    node.classList.toggle('is-error', Boolean(bad));
  }

  function renderSetup() {
    const setup = document.getElementById('setup');
    setup.textContent = '';

    /* --- folders ---------------------------------------------------------- */

    const zone = el('div', 'oveseq-drop');
    zone.appendChild(el('div', null, 'Drop a folder of .gb / .gbk maps here'));
    const browse = el('button', 'oveseq-btn secondary', 'Browse…');
    browse.addEventListener('click', () => post('seqsearch/browse'));
    zone.appendChild(browse);
    zone.appendChild(el('div', 'oveseq-drophint',
      'Hold ⇧ Shift while dragging from Finder. Folders only — a file is refused.'));
    wireDropZone(zone);
    setup.appendChild(zone);

    if (state.folders.length) {
      const list = el('div', 'oveseq-folders');
      for (const folder of state.folders) list.appendChild(folderChip(folder));
      setup.appendChild(list);
    }

    /* --- the query -------------------------------------------------------- */

    const box = el('textarea', 'oveseq-query');
    box.placeholder = 'Paste a DNA or protein sequence';
    box.value = draft.query;
    box.addEventListener('input', () => { draft.query = box.value; });
    box.addEventListener('keydown', (e) => {
      // Enter searches; Shift+Enter is a newline, since a pasted sequence may
      // arrive wrapped.
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runSearch(); }
    });
    setup.appendChild(box);

    const controls = el('div', 'oveseq-controls');

    controls.appendChild(radioPair('kind', [
      ['dna', 'Nucleotide'],
      ['protein', 'Amino acid']
    ], draft.kind, (v) => { draft.kind = v; pickRadio('kind', v); }));

    controls.appendChild(radioPair('mode', [
      ['exact', 'Exact'],
      ['fuzzy', 'Fuzzy']
    ], draft.exact ? 'exact' : 'fuzzy', (v) => { draft.exact = v === 'exact'; syncMode(); }));

    /*
     * The threshold belongs to Fuzzy, so under Exact it is not there at all.
     * It was greyed out instead, which read as a control you ought to be able
     * to use and could not -- the question it raises is "why can I not type
     * here", which is a worse question than "where is the threshold".
     */
    const ident = el('label', 'oveseq-ident' + (draft.exact ? ' is-hidden' : ''));
    ident.appendChild(el('span', null, 'min identity'));
    const pct = el('input');
    pct.type = 'number';
    pct.min = '50';
    pct.max = '100';
    pct.step = '1';
    pct.value = String(Math.round(draft.minIdentity * 100));
    pct.title = 'Percent identity a fuzzy hit must reach';
    // Clamped on the way out rather than per keystroke, so typing "7" on the
    // way to "75" is not snapped up to the minimum under the caret.
    pct.addEventListener('change', () => {
      const v = Math.min(100, Math.max(50, Number(pct.value) || 90));
      draft.minIdentity = v / 100;
      pct.value = String(v);
    });
    ident.appendChild(pct);
    ident.appendChild(el('span', null, '%'));
    controls.appendChild(ident);

    const go = el('button', 'oveseq-btn oveseq-go', state.busy ? 'Searching…' : 'Search');
    go.disabled = state.busy;
    go.addEventListener('click', runSearch);
    controls.appendChild(go);

    setup.appendChild(controls);
    setup.appendChild(el('div', 'oveseq-status' + (state.error ? ' is-error' : ''), state.status || ''));
  }

  function radioPair(group, options, selected, onPick) {
    const wrap = el('div', 'oveseq-radios');
    wrap.dataset.group = group;
    for (const [value, label] of options) {
      const item = el('label', 'oveseq-radio' + (value === selected ? ' is-on' : ''));
      item.dataset.value = value;
      const input = el('input');
      input.type = 'radio';
      input.name = group;
      input.checked = value === selected;
      input.addEventListener('change', () => onPick(value));
      item.appendChild(input);
      item.appendChild(el('span', null, label));
      wrap.appendChild(item);
    }
    return wrap;
  }

  /**
   * Move a radio pair without rebuilding the strip.
   *
   * renderSetup() throws away and rebuilds every control, which takes the caret
   * with it -- fine for a click on a radio, fatal for a click into the identity
   * box that has to select Fuzzy on the way in.
   */
  function pickRadio(group, value) {
    const wrap = document.querySelector(`.oveseq-radios[data-group="${group}"]`);
    if (!wrap) return;
    for (const item of wrap.querySelectorAll('.oveseq-radio')) {
      const on = item.dataset.value === value;
      item.classList.toggle('is-on', on);
      const input = item.querySelector('input');
      if (input) input.checked = on;
    }
  }

  /** Exact takes the threshold away with it; Fuzzy brings it back as it was. */
  function syncMode() {
    pickRadio('mode', draft.exact ? 'exact' : 'fuzzy');
    const wrap = document.querySelector('.oveseq-ident');
    if (wrap) wrap.classList.toggle('is-hidden', draft.exact);
  }

  function runSearch() {
    post('seqsearch/run', {
      query: draft.query,
      kind: draft.kind,
      exact: draft.exact,
      minIdentity: draft.minIdentity
    });
  }

  /** Filtered and sorted, in that order -- filtering never changes the ranking. */
  function visibleHits() {
    let hits = state.results;

    const q = filterText.trim().toLowerCase();
    if (q) {
      // The path as well as the name: folders are often the experiment, so
      // narrowing to one is a thing worth being able to type.
      hits = hits.filter((h) => `${h.name} ${h.file}`.toLowerCase().includes(q));
    }

    if (sort.key) {
      const col = COLUMNS.find((c) => c.key === sort.key);
      if (col) {
        hits = hits.slice().sort((a, b) => {
          const av = col.value(a);
          const bv = col.value(b);
          if (av === bv) return 0;
          const numeric = typeof av === 'number' && typeof bv === 'number';
          return (numeric ? av - bv : String(av).localeCompare(String(bv))) * sort.dir;
        });
      }
    }
    return hits;
  }

  function cycleSort(col) {
    if (sort.key !== col.key) sort = { key: col.key, dir: 1 };
    else if (sort.dir === 1) sort = { key: col.key, dir: -1 };
    else sort = { key: null, dir: 1 };      // back to the ranking
    renderRows();
  }

  function headerRow() {
    const row = el('div', 'oveseq-row oveseq-header');
    for (const col of COLUMNS) {
      const sorted = sort.key === col.key;
      const cell = el('div',
        `oveseq-cell oveseq-k-${col.key} is-sortable` + (sorted ? ' is-sorted' : ''),
        col.label());
      cell.title = sorted && sort.dir === -1
        ? 'Click to sort by rank again'
        : 'Click to sort by this column';
      cell.addEventListener('click', () => cycleSort(col));
      if (sorted) cell.appendChild(el('span', 'oveseq-sortmark', sort.dir === 1 ? ' ▲' : ' ▼'));
      row.appendChild(cell);
    }
    return row;
  }

  function hitRow(hit) {
    const row = el('div', 'oveseq-row oveseq-hit');
    row.title = `${hit.file}\nclick to open and select this range`;

    row.appendChild(el('div', 'oveseq-cell oveseq-k-name', hit.name));

    // 1-based and inclusive, the way the editor's own readouts count.
    row.appendChild(el('div', 'oveseq-cell oveseq-k-pos', `${hit.start + 1}..${hit.end + 1}`));

    const pct = el('div', 'oveseq-cell oveseq-k-ident',
      `${(hit.identity * 100).toFixed(hit.identity === 1 ? 0 : 1)}%`);
    // A perfect hit is the thing you are usually looking for, so it is not grey.
    if (hit.identity === 1) pct.classList.add('is-exact');
    row.appendChild(pct);

    row.appendChild(el('div', 'oveseq-cell oveseq-k-len', String(hit.length)));

    // The frame is what makes a protein hit's coordinates make sense; for a
    // nucleotide hit the strand is all there is to say.
    const rev = hit.frame ? hit.frame < 0 : hit.strand === -1;
    const frame = el('div', `oveseq-cell oveseq-k-frame ${rev ? 'rev' : 'fwd'}`,
      hit.frame ? `${hit.frame > 0 ? '+' : '\u2212'}${Math.abs(hit.frame)}` : (rev ? '\u2212' : '+'));
    frame.title = hit.frame ? `Reading frame ${hit.frame}` : (rev ? 'Reverse strand' : 'Forward strand');
    row.appendChild(frame);

    row.addEventListener('click', () => post('seqsearch/open', {
      file: hit.file, start: hit.start, end: hit.end, strand: hit.strand
    }));
    return row;
  }

  /** Just the table, so typing in the filter box does not rebuild the box. */
  function renderRows() {
    const body = document.querySelector('.oveseq-body');
    const head = document.querySelector('.oveseq-table');
    const count = document.querySelector('.oveseq-count');
    if (!body || !head) return;

    const hits = visibleHits();
    body.textContent = '';
    for (const hit of hits) body.appendChild(hitRow(hit));

    const old = head.querySelector('.oveseq-header');
    if (old) head.replaceChild(headerRow(), old);

    if (count) {
      const total = state.results.length;
      count.textContent = hits.length === total
        ? `${total} hit${total === 1 ? '' : 's'}`
        : `${hits.length} of ${total} hits`;
    }
  }

  function renderResults() {
    const host = document.getElementById('results');
    host.textContent = '';
    if (!state.results.length) return;

    /*
     * The filter sits above the table and outside anything renderRows touches,
     * so the caret survives every keystroke without the focus bookkeeping the
     * primer search table needs.
     */
    const bar = el('div', 'oveseq-resultsbar');
    const filter = el('input', 'oveseq-filter');
    filter.type = 'search';
    filter.placeholder = 'Filter…';
    filter.value = filterText;
    filter.addEventListener('input', () => { filterText = filter.value; renderRows(); });
    bar.appendChild(filter);
    bar.appendChild(el('div', 'oveseq-count', ''));
    host.appendChild(bar);

    const table = el('div', 'oveseq-table');
    table.appendChild(headerRow());
    table.appendChild(el('div', 'oveseq-body'));
    host.appendChild(table);

    renderRows();
  }

  function render() {
    renderSetup();
    renderResults();
  }

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type !== 'seqsearch/state') return;
    state = msg.state || state;
    // The host owns these once a search has run, so a reopened panel comes back
    // with what was asked rather than an empty box.
    if (state.query && !draft.query) draft.query = state.query;
    render();
  });

  render();
  post('seqsearch/ready');

  window.OveSeqSearch = { render, get state() { return state; } };
})();
