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
    ], draft.kind, (v) => { draft.kind = v; renderSetup(); }));

    controls.appendChild(radioPair('mode', [
      ['exact', 'Exact'],
      ['fuzzy', 'Fuzzy']
    ], draft.exact ? 'exact' : 'fuzzy', (v) => { draft.exact = v === 'exact'; renderSetup(); }));

    // Only meaningful under Fuzzy, so it is disabled rather than hidden -- a
    // control that vanishes is harder to find again than one greyed out.
    const ident = el('label', 'oveseq-ident' + (draft.exact ? ' is-off' : ''));
    ident.appendChild(el('span', null, 'min identity'));
    const pct = el('input');
    pct.type = 'number';
    pct.min = '50';
    pct.max = '100';
    pct.step = '1';
    pct.value = String(Math.round(draft.minIdentity * 100));
    pct.disabled = draft.exact;
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
    for (const [value, label] of options) {
      const item = el('label', 'oveseq-radio' + (value === selected ? ' is-on' : ''));
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

  function runSearch() {
    post('seqsearch/run', {
      query: draft.query,
      kind: draft.kind,
      exact: draft.exact,
      minIdentity: draft.minIdentity
    });
  }

  function renderResults() {
    const host = document.getElementById('results');
    host.textContent = '';
    if (!state.results.length) return;

    const list = el('div', 'oveseq-hits');
    for (const hit of state.results) {
      const row = el('div', 'oveseq-hit');
      row.title = `${hit.file}\nclick to open and select this range`;

      row.appendChild(el('span', 'oveseq-hitname', hit.name));

      // 1-based and inclusive, the way the editor's own readouts count.
      row.appendChild(el('span', 'oveseq-hitpos', `${hit.start + 1}..${hit.end + 1}`));

      const pct = el('span', 'oveseq-hitid', `${(hit.identity * 100).toFixed(hit.identity === 1 ? 0 : 1)}%`);
      if (hit.identity === 1) pct.classList.add('is-exact');
      row.appendChild(pct);

      row.appendChild(el('span', 'oveseq-hitlen',
        hit.frame ? `${hit.length} aa` : `${hit.length} bp`));

      // The frame is what makes a protein hit's coordinates make sense.
      if (hit.frame) {
        row.appendChild(el('span', 'oveseq-hitframe',
          `frame ${hit.frame > 0 ? '+' : ''}${hit.frame}`));
      } else if (hit.strand === -1) {
        row.appendChild(el('span', 'oveseq-hitframe', 'reverse'));
      }

      row.addEventListener('click', () => post('seqsearch/open', {
        file: hit.file, start: hit.start, end: hit.end, strand: hit.strand
      }));
      list.appendChild(row);
    }
    host.appendChild(list);
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
