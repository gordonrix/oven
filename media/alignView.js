/*
 * Alignment panel client.
 *
 * Two halves: a setup strip for choosing reads, and OVE's alignment view
 * underneath it. Reads arrive by three routes, which deliver genuinely
 * different things and so cannot share a code path:
 *
 *   Browse...        the host runs the open dialog and reads the files itself
 *   Finder drop      dataTransfer.files -- browser File objects with no path,
 *                    so the bytes are read here and posted as base64
 *   Explorer drop    no files at all; a text/uri-list of file:// URIs, which
 *                    the host reads from disk
 *
 * Browse is the route that cannot fail, so it is what the empty state points
 * at; the drop zone is the convenience on top.
 *
 * Built with createElement rather than innerHTML: names come from filenames and
 * GenBank LOCUS fields, which are not trusted input.
 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const ACCEPT = ['ab1', 'gb', 'gbk', 'fa', 'fasta', 'faa', 'dna'];

  let state = {
    reference: null,
    reads: [],
    status: '',
    error: '',
    busy: false,
    alignment: null,
    canSave: false,   // an alignment has been made, so there is one to write
    file: null        // the name of the file it was saved to or opened from
  };
  let view = null;      // the live createAlignmentView handle

  let renderedId = 0;   // bumped so a stale alignment is never re-shown
  let lastPayload = null;
  let dropOpen = true;  // the picker IS the empty state until there is an alignment
  let readsOpen = true; // the chips are useful until there are twenty of them
  let settingsOpen = false;
  /*
   * The rows of the paste table. Kept here rather than in its inputs for the
   * same reason as the settings draft: the strip is rebuilt on every message
   * from the host. `focus` remembers which cell had the caret, so a rebuild
   * mid-typing puts it back.
   */
  let pasteRows = [{ name: '', sequence: '' }];
  let pasteFocus = null;
  /*
   * What is in the settings form while it is being edited. The whole strip is
   * redrawn on every message from the host, so the form cannot keep its values
   * in its own inputs: they would be reset by any status update arriving
   * mid-edit. Null means "show what is saved".
   */
  let settingsDraft = null;

  /*
   * The rule itself lives in cartShared so it can be unit-tested; this only
   * maps its answer to a colour. The numbers stay in the tooltip: the label
   * answers "is this the construct?", the tooltip answers "how much of it did
   * we see, and how far off is it?".
   */
  const VERDICT_CLASS = {
    match: 'is-clean',              // green
    'partial match': 'is-diff',     // gold
    mismatch: 'is-bad'              // red
  };

  function verdict(read, referenceLength) {
    const shared = window.CartShared;
    if (!isProtein()) {
      const label = shared.alignmentVerdict(read, referenceLength);
      return label ? { label, cls: VERDICT_CLASS[label] } : null;
    }
    /*
     * A protein is held to the same odds as DNA rather than the same length --
     * see MIN_COVERED_AA. And where it differs, how much is the useful answer:
     * two homologues are never identical, so "mismatch" alone would paint every
     * one the same red. Green and gold mean exactly what they mean for DNA.
     */
    const label = shared.alignmentVerdict(read, referenceLength, shared.MIN_COVERED_AA);
    if (!label) return null;
    if (label === 'mismatch' && read.mismatches > 0) {
      return { label: shared.identityLabel(read), cls: VERDICT_CLASS.mismatch };
    }
    return { label, cls: VERDICT_CLASS[label] };
  }

  /* Is the alignment being built of proteins? The reference decides. */
  const isProtein = () => Boolean(state.reference && state.reference.molecule === 'protein');
  const unitOf = (molecule) => (molecule === 'protein' ? 'aa' : 'bp');

  /*
   * The quality-score bars behind a trace are not wanted here: they say little
   * about a good read, whose scores are near-uniform, and they sit between you
   * and the peaks. OVE keeps the toggle in localStorage rather than a prop, so
   * this is the supported way to turn it off -- and it means no patch to the
   * bundle for it.
   *
   * Set once, behind our own marker, so switching it back on from the eye menu
   * sticks instead of being undone every time the panel opens.
   */
  try {
    if (localStorage.getItem('oveAlignQualScoresSeeded') === null) {
      localStorage.setItem('showChromQualScores', 'false'); // JSON, per use-local-storage-state
      localStorage.setItem('oveAlignQualScoresSeeded', '1');
    }
  } catch (e) {
    // A webview with storage blocked still works; the bars just stay on.
  }

  /* ------------------------------------------------ top-bar controls -- */

  /*
   * OVE's alignment view takes `additionalTopEl` / `additionalTopLeftEl`, which
   * put our own controls in its top bar beside the eye and the zoom slider --
   * where they belong, rather than stranded above the view in our own chrome.
   *
   * Those props want React elements, and the bundle does not export React. It
   * does not need to: an element is a plain object tagged with the global
   * Symbol.for('react.element'), so one can be hand-built. Each is a single div
   * with a STABLE ref callback -- an inline arrow would be a new ref every
   * render, and React would tear the node down and rebuild it each time,
   * throwing away the DOM we put inside.
   */
  const REACT_ELEMENT = Symbol.for('react.element');

  function reactEl(type, props) {
    return {
      $$typeof: REACT_ELEMENT, type, key: null,
      ref: (props && props.ref) || null,
      props: Object.assign({}, props), _owner: null, _store: {}
    };
  }

  let topBarRoot = null;

  const topBarRef = (node) => {
    if (!node) return; // unmounting
    topBarRoot = node;
    renderTopControls();
  };

  /*
   * Little inline SVGs rather than unicode glyphs. The text characters that
   * come closest -- a heavy bar, a caret -- render at wildly different sizes
   * across fonts, and the one for "short" was indistinguishable from the minus
   * on OVE's zoom slider sitting right next to it.
   */
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function svgIcon(title, draw) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', 'ovealign-ctlicon');
    svg.setAttribute('aria-hidden', 'true');
    const t = document.createElementNS(SVG_NS, 'title');
    t.textContent = title;
    svg.appendChild(t);
    draw(svg);
    return svg;
  }

  const line = (svg, x1, y1, x2, y2, w) => {
    const l = document.createElementNS(SVG_NS, 'line');
    l.setAttribute('x1', x1); l.setAttribute('y1', y1);
    l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    l.setAttribute('stroke-width', w || 1.6);
    l.setAttribute('stroke-linecap', 'round');
    svg.appendChild(l);
  };

  /** Two rules close together / far apart: a short window and a tall one. */
  const gapIcon = (gap) => (title) => svgIcon(title, (svg) => {
    line(svg, 3, 8 - gap, 13, 8 - gap);
    line(svg, 3, 8 + gap, 13, 8 + gap);
  });

  /** A trace with two peaks -- amplitude, as distinct from window height. */
  const traceIcon = (title) => svgIcon(title, (svg) => {
    const p = document.createElementNS(SVG_NS, 'polyline');
    p.setAttribute('points', '2,13 4,13 6,3 8,13 10,13 11,6 12,13 14,13');
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke-width', '1.5');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
  });

  /** A small labelled button, sized to sit with OVE's own toolbar items. */
  function ctlButton(glyph, title, onClick) {
    const b = el('button', 'ovealign-ctlbtn', glyph);
    b.title = title;
    b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
    return b;
  }

  /** A control button that is there but cannot be used. */
  function disable(button) {
    button.disabled = true;
    return button;
  }

  const AMPLITUDE_STEP = 1.3;

  /** Does any read in the current alignment carry a trace? */
  function hasChromatogram() {
    const tracks = (state.alignment && state.alignment.tracks) || [];
    return tracks.some((t) => t && t.chromatogramData);
  }

  function renderTopControls() {
    if (!topBarRoot || !window.OveChromScale) return;
    topBarRoot.textContent = '';
    topBarRoot.className = 'ovealign-topctl';

    /*
     * Both controls here are about drawing a trace, and a trace only comes from
     * an .ab1. Against GenBank or FASTA reads they did nothing and said nothing
     * about why, so they are disabled and say so instead of being hidden --
     * a control that vanishes is harder to find again than one greyed out.
     */
    const live = hasChromatogram();
    topBarRoot.classList.toggle('is-off', !live);
    const why = isProtein() ? 'Protein alignment — no traces' : 'No .ab1 read in this alignment';

    /*
     * Track height: how tall each chromatogram window is. Shaped like OVE's
     * zoom slider next to it -- an icon each side saying which way is bigger --
     * because it does the same kind of job.
     */
    const height = el('div', 'ovealign-ctlgroup');
    height.title = live ? 'Height of every chromatogram window' : why;
    height.appendChild(gapIcon(2)('Shorter windows'));
    const slider = el('input', 'ovealign-ctlslider');
    slider.type = 'range';
    slider.min = '24';
    slider.max = '220';
    slider.step = '2';
    slider.value = String(window.OveChromScale.height());
    slider.disabled = !live;
    slider.addEventListener('input', () => {
      window.OveChromScale.setHeight(Number(slider.value));
    });
    height.appendChild(slider);
    height.appendChild(gapIcon(5)('Taller windows'));
    topBarRoot.appendChild(height);

    /*
     * Trace amplitude: how tall the peaks are drawn inside that window. A
     * separate concern from the window height, and the one you reach for when a
     * particular file came off the instrument hot or faint.
     */
    const amp = el('div', 'ovealign-ctlgroup');
    amp.title = live ? 'Peak height within each chromatogram' : why;
    amp.appendChild(traceIcon('Peak height'));
    const ampButton = (label, title, onClick) => {
      const b = ctlButton(label, live ? title : why, onClick);
      return live ? b : disable(b);
    };
    amp.appendChild(ampButton('▲', 'Taller peaks',
      () => window.OveChromScale.nudge(AMPLITUDE_STEP)));
    amp.appendChild(ampButton('▼', 'Shorter peaks',
      () => window.OveChromScale.nudge(1 / AMPLITUDE_STEP)));
    amp.appendChild(ampButton('⤢', 'Fit peaks to the window',
      () => window.OveChromScale.reset()));
    topBarRoot.appendChild(amp);
  }

  const $ = (id) => document.getElementById(id);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  const extOf = (name) => String(name || '').split('.').pop().toLowerCase();
  const supported = (name) => ACCEPT.includes(extOf(name));

  /* ------------------------------------------------------------ sending -- */

  function post(type, payload) {
    vscode.postMessage(Object.assign({ type }, payload || {}));
  }

  /**
   * Read dropped File objects and hand the bytes to the host.
   *
   * base64 rather than a typed array on purpose: VS Code serialises webview
   * messages as JSON, so a Uint8Array would arrive as an object with numeric
   * keys and quietly parse as garbage.
   */
  function sendFiles(files) {
    const wanted = [...files].filter((f) => supported(f.name));
    const rejected = [...files].filter((f) => !supported(f.name));
    if (rejected.length) {
      setStatus(`Ignored ${rejected.length} file(s) that are not ${ACCEPT.join(', ')}.`, true);
    }
    if (!wanted.length) return;

    let pending = wanted.length;
    const payload = [];
    for (const file of wanted) {
      const reader = new FileReader();
      reader.onload = () => {
        const bytes = new Uint8Array(reader.result);
        let binary = '';
        // In chunks: apply() on a 4 MB array blows the argument limit.
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        payload.push({ name: file.name, base64: btoa(binary) });
        if (--pending === 0) post('align/addBytes', { files: payload });
      };
      reader.onerror = () => {
        setStatus(`Could not read ${file.name}.`, true);
        if (--pending === 0 && payload.length) post('align/addBytes', { files: payload });
      };
      reader.readAsArrayBuffer(file);
    }
  }

  function setStatus(text, isError) {
    state.status = text || '';
    state.error = isError ? text : '';
    renderSetup();
  }

  /* --------------------------------------------------------- drop target -- */

  /* What the aligner can read, matching SEQUENCE_EXTENSIONS in alignTracks.js. */
  const READ_EXTENSIONS = ['ab1', 'gb', 'gbk', 'fa', 'fasta', 'faa', 'dna'];

  const isSequencePath = (p) =>
    READ_EXTENSIONS.includes(String(p).split('.').pop().toLowerCase());

  /**
   * Every path a drop is offering, whatever dropped it.
   *
   * Four sources, and they do not agree on a format:
   *
   *   text/uri-list   Finder and anything else outside the window: newlines
   *   ResourceURLs    the Explorer: a JSON array of URI strings
   *   CodeFiles       an editor tab: a JSON array of plain paths
   *   CodeEditors     an editor tab: a JSON array of editor inputs, whose
   *                   `resource` is a serialised URI object rather than a string
   *
   * The names are read back lowercased because that is what DataTransfer does
   * to them -- `setData("CodeEditors", …)` is readable only as `codeeditors`,
   * which is easy to get wrong and silently returns "".
   */
  function droppedPaths(dt) {
    const out = [];
    const add = (value) => {
      if (!value) return;
      const text = typeof value === 'string'
        ? value
        : (value.fsPath || value.external || value.path || '');
      if (!text) return;
      // A file: URI is what the host prefers; it takes bare paths too.
      const clean = text.trim();
      if (clean && !clean.startsWith('#') && !out.includes(clean)) out.push(clean);
    };

    const json = (type) => {
      const raw = dt.getData(type);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    };

    for (const entry of json('codeeditors') || []) add(entry && entry.resource);
    for (const entry of json('codefiles') || []) add(entry);
    for (const entry of json('resourceurls') || []) add(entry);

    for (const type of ['text/uri-list', 'resourceurls']) {
      const raw = dt.getData(type);
      if (raw && raw.trim().startsWith('[')) continue;   // already taken as JSON
      for (const line of String(raw || '').split(/\r?\n/)) add(line);
    }
    return out;
  }

  function wireDropZone(zone) {
    const over = (on) => (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Without preventDefault on dragover the workbench takes the drop and
      // opens the file in an editor instead of giving it to us.
      zone.classList.toggle('is-over', on);
    };
    zone.addEventListener('dragenter', over(true));
    zone.addEventListener('dragover', over(true));
    zone.addEventListener('dragleave', over(false));

    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('is-over');
      const dt = e.dataTransfer;
      if (!dt) return;

      if (dt.files && dt.files.length) {
        sendFiles(dt.files);
        return;
      }
      // The Explorer and the tab bar send paths, not files. Cheaper too: the
      // host reads from disk instead of the bytes crossing the message channel.
      const paths = droppedPaths(dt);
      const usable = paths.filter(isSequencePath);
      if (usable.length) {
        post('align/addUris', { uris: usable });
        return;
      }
      if (paths.length) {
        const names = paths.map((p) => p.split('/').pop()).slice(0, 3).join(', ');
        setStatus(`${names} ${paths.length === 1 ? 'is not a sequence file' : 'are not sequence files'}`
          + ` — reads are ${READ_EXTENSIONS.map((e) => `.${e}`).join(', ')}.`, true);
        return;
      }
      setStatus('Nothing usable in that drop — try Browse instead.', true);
    });
  }

  /* ------------------------------------------------------------ rendering -- */

  function renderReference(into) {
    const row = el('div', 'ovealign-refrow');
    row.appendChild(el('span', 'ovealign-reflabel', 'Reference:'));
    if (state.reference) {
      row.appendChild(el('span', 'ovealign-refname', state.reference.name));
      // A protein has no topology to speak of, so it gets a length and nothing else.
      row.appendChild(el('span', 'ovealign-refmeta', isProtein()
        ? `${state.reference.length} aa`
        : `${state.reference.length} bp · ${state.reference.circular ? 'circular' : 'linear'}`));
    } else {
      row.appendChild(el('span', 'ovealign-refmeta', 'none chosen'));
    }
    const change = el('button', 'ovealign-link', 'Change reference');
    change.addEventListener('click', () => post('align/pickReference'));
    row.appendChild(change);
    into.appendChild(row);
  }

  function renderRead(read) {
    const chip = el('div', 'ovealign-read' + (read.error ? ' is-error' : ''));
    const name = el('span', 'ovealign-readname', read.name);
    name.title = read.path || read.name;
    chip.appendChild(name);

    const refLen = state.reference && state.reference.length;
    const v = read.error ? null : verdict(read, refLen);
    if (read.error) {
      chip.appendChild(el('span', 'ovealign-readerr', read.error));
    } else if (v) {
      const stat = el('span', `ovealign-readstat ${v.cls}`, v.label);
      const covered = read.compared || 0;
      const unit = unitOf(isProtein() ? 'protein' : 'dna');
      // Strand, rotation and anchoring are all about where a read sits on a
      // circular plasmid; a protein has none of them, so none are listed.
      const dnaOnly = isProtein() ? [] : [
        read.strand === -1 ? 'aligned reverse-complemented' : 'forward strand',
        read.rotation ? `rotated ${read.rotation} bp to cross the origin` : null,
        read.anchored === false ? 'no anchor found on the reference' : null
      ];
      stat.title = [
        refLen
          ? `covers ${covered} of ${refLen} ${unit} (${((covered / refLen) * 100).toFixed(1)}%)`
          : `covers ${covered} ${unit}`,
        `${read.substitutions} substitution(s), ${read.gaps} gapped column(s)`,
        read.identity === undefined ? null : (isProtein()
          // The chip's figure counts gaps against it; this one does not, and
          // without saying so the two would look like a contradiction.
          ? `${(read.identity * 100).toFixed(3)}% identical where both have a residue`
          : `identity ${(read.identity * 100).toFixed(3)}%`),
        ...dnaOnly
      ].filter(Boolean).join('\n');
      chip.appendChild(stat);
    } else if (read.length) {
      chip.appendChild(el('span', 'ovealign-readstat', `${read.length} ${unitOf(read.molecule)}`));
    }

    const x = el('button', 'ovealign-x', '×');
    x.title = 'Remove this read';
    x.addEventListener('click', () => post('align/remove', { id: read.id }));
    chip.appendChild(x);
    return chip;
  }

  /**
   * The MAFFT banner.
   *
   * Shown as soon as the panel opens rather than when Align is pressed, so a
   * missing dependency is not discovered after choosing files and waiting --
   * especially since fixing it can need a window reload.
   */
  function renderMafft(into) {
    const m = state.mafft;
    if (!m || m.ok) return; // still checking, or fine

    const box = el('div', 'ovealign-banner');
    box.appendChild(el('div', 'ovealign-bannertitle', 'MAFFT is required to align'));
    box.appendChild(el('div', 'ovealign-bannertext', m.message || 'MAFFT was not found.'));

    // The host says what installs MAFFT on this machine: brew and conda, apt,
    // or on Windows a download.
    const install = m.install || { commands: ['brew install mafft', 'conda install -c bioconda mafft'] };
    const cmds = el('div', 'ovealign-cmds');
    install.commands.forEach((c) => cmds.appendChild(el('code', null, c)));
    box.appendChild(cmds);

    const row = el('div', 'ovealign-bannerbtns');
    if (install.download) {
      const download = el('button', 'ovealign-btn', 'Download MAFFT…');
      download.title = 'MAFFT for Windows, from its authors';
      download.addEventListener('click', () => post('align/mafftDownload'));
      row.appendChild(download);
    }
    const locate = el('button', install.download ? 'ovealign-btn secondary' : 'ovealign-btn', 'Locate MAFFT…');
    locate.title = 'Pick the mafft executable; its path is saved to settings';
    locate.addEventListener('click', () => post('align/locateMafft'));
    row.appendChild(locate);

    const recheck = el('button', 'ovealign-btn secondary', 'Re-check');
    recheck.title = 'Look again, after installing';
    recheck.addEventListener('click', () => post('align/recheckMafft'));
    row.appendChild(recheck);

    const settings = el('button', 'ovealign-link', 'Open settings');
    settings.addEventListener('click', () => post('align/openSettings'));
    row.appendChild(settings);

    box.appendChild(row);
    into.appendChild(box);
  }

  /* ------------------------------------------------------- paste table -- */

  const rowFilled = (r) => Boolean(String(r.name || '').trim() || String(r.sequence || '').trim());

  /** Always one empty row at the bottom, to type the next one into. */
  function ensureTrailingRow() {
    if (!pasteRows.length || rowFilled(pasteRows[pasteRows.length - 1])) {
      pasteRows.push({ name: '', sequence: '' });
    }
  }

  function submitPasteTable() {
    const rows = pasteRows.filter(rowFilled).map((r) => ({ name: r.name, sequence: r.sequence }));
    if (!rows.length) return;
    post('align/addSequences', { rows });
    // Cleared now; any row the host refuses comes back with its reason.
    pasteRows = [{ name: '', sequence: '' }];
    pasteFocus = { row: 0, col: 'sequence', start: 0, end: 0 };
    renderSetup();
  }

  /**
   * Put pasted text into the table, starting at the row it was pasted into.
   *
   * Like a spreadsheet: a block with both columns -- tab- or comma-separated,
   * FASTA, "name sequence" lines -- fills both, from this row down. A single
   * column fills only the column it was pasted into, and leaves the other as
   * it was, so names and sequences can be pasted in separately, in either
   * order. Into the sequence column, one sequence that happens to span lines
   * (a numbered GenBank block, a wrapped FASTA body) stays one sequence.
   */
  function pasteIntoTable(event, rowIndex, col) {
    const text = event.clipboardData && event.clipboardData.getData('text/plain');
    // One line with no tab is an ordinary paste into the box.
    if (!text || !/[\t\n]/.test(text.trim())) return;

    const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim());
    const twoColumns = /[\t]/.test(text) || lines[0].trim().startsWith('>') ||
      (lines.length > 0 && lines.every((l) => l.includes(',')));

    let values = null;      // a single column, for `col`
    let rows = null;        // both columns
    if (col === 'name' && !twoColumns) {
      values = lines.map((l) => l.trim());
    } else {
      const parsed = window.CartShared.parseSequenceTable(text);
      if (!parsed.length) return;
      if (parsed.some((r) => r.name)) rows = parsed;
      else values = parsed.map((r) => r.sequence);
      // A column of sequences pasted into the name column is still sequences.
      if (values && col === 'name') col = 'sequence';
    }
    // A column copied with its header: the header is not a row.
    if (values && values.length > 1 &&
        /^(names?|ids?|labels?|primers?|oligos?|seq|sequences?|bases|dna|protein)$/i.test(values[0].trim())) {
      values = values.slice(1);
    }
    event.preventDefault();

    const n = rows ? rows.length : values.length;
    for (let k = 0; k < n; k++) {
      const at = rowIndex + k;
      if (!pasteRows[at]) pasteRows[at] = { name: '', sequence: '' };
      if (rows) {
        pasteRows[at].name = rows[k].name;
        pasteRows[at].sequence = rows[k].sequence;
      } else {
        pasteRows[at][col] = values[k];
      }
      pasteRows[at].error = null;
    }
    ensureTrailingRow();
    pasteFocus = { row: rowIndex + n - 1, col: rows ? 'sequence' : col, start: 0, end: 0 };
    renderSetup();
  }

  function renderPasteTable() {
    ensureTrailingRow();
    const table = el('div', 'ovealign-pastetable');
    const head = el('div', 'ovealign-pastehead');
    head.appendChild(el('span', 'ovealign-pastename-h', 'Name'));
    head.appendChild(el('span', 'ovealign-pastebases-h', 'Sequence'));
    table.appendChild(head);

    const body = el('div', 'ovealign-pasterows');
    const addButton = el('button', 'ovealign-btn secondary ovealign-pasteadd');
    const label = () => {
      const n = pasteRows.filter(rowFilled).length;
      addButton.textContent = n > 1 ? `Add ${n}` : 'Add';
      addButton.disabled = n === 0;
    };

    const seqPlaceholder = !state.reference
      ? 'Paste or type a DNA or protein sequence'
      : (isProtein() ? 'Paste or type a protein sequence' : 'Paste or type a DNA sequence');

    pasteRows.forEach((row, i) => {
      const line = el('div', 'ovealign-pasterow' + (row.error ? ' has-error' : ''));
      const cell = (col, cls, placeholder) => {
        const input = el('input', cls);
        input.type = 'text';
        input.placeholder = placeholder;
        input.value = row[col] || '';
        input.dataset.row = String(i);
        input.dataset.col = col;
        input.addEventListener('input', () => {
          row[col] = input.value;
          pasteFocus = { row: i, col, start: input.selectionStart, end: input.selectionEnd };
          if (row.error) { row.error = null; line.classList.remove('has-error'); }
          // Typing into the last row grows the table by one.
          if (i === pasteRows.length - 1 && rowFilled(row)) { ensureTrailingRow(); renderSetup(); return; }
          label();
        });
        input.addEventListener('focus', () => {
          pasteFocus = { row: i, col, start: input.selectionStart, end: input.selectionEnd };
        });
        input.addEventListener('paste', (e) => pasteIntoTable(e, i, col));
        // Enter from any box adds the lot, since the name is optional.
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); submitPasteTable(); }
        });
        return input;
      };
      line.appendChild(cell('name', 'ovealign-pastename', i === 0 ? 'Name (optional)' : ''));
      line.appendChild(cell('sequence', 'ovealign-pastebases', i === 0 ? seqPlaceholder : ''));
      if (rowFilled(row)) {
        const x = el('button', 'ovealign-x', '×');
        x.title = 'Remove this row';
        x.addEventListener('click', () => { pasteRows.splice(i, 1); renderSetup(); });
        line.appendChild(x);
      } else {
        line.appendChild(el('span', 'ovealign-pastespacer'));
      }
      body.appendChild(line);
      if (row.error) body.appendChild(el('div', 'ovealign-pasteerr', row.error));
    });
    table.appendChild(body);

    const foot = el('div', 'ovealign-pastefoot');
    addButton.addEventListener('click', submitPasteTable);
    label();
    foot.appendChild(addButton);
    foot.appendChild(el('span', 'ovealign-drophint',
      'Paste rows from a spreadsheet or FASTA, or a column of names or sequences into its own column'));
    table.appendChild(foot);
    return table;
  }

  /** Put the caret back in the cell it was in before the strip was rebuilt. */
  function restorePasteFocus() {
    if (!pasteFocus) return;
    const input = document.querySelector(
      `.ovealign-pastetable input[data-row="${pasteFocus.row}"][data-col="${pasteFocus.col}"]`);
    if (!input) return;
    input.focus();
    try { input.setSelectionRange(pasteFocus.start, pasteFocus.end); } catch (e) { /* not a text box */ }
  }

  function renderSetup() {
    const setup = $('setup');
    // Only a cell of the table that had the caret gets it back.
    const active = document.activeElement;
    if (!(active && active.closest && active.closest('.ovealign-pastetable'))) pasteFocus = null;
    setup.textContent = '';
    renderMafft(setup);
    renderReference(setup);

    /*
     * Once an alignment is on screen it is what the panel is for, so the picker
     * folds away behind a button rather than keeping a large dashed box between
     * the reference and the tracks.
     */
    if (state.alignment) {
      const row = el('div', 'ovealign-addrow');
      const toggle = el('button', 'ovealign-toggle ovealign-addtoggle');
      toggle.appendChild(el('span', 'chev', dropOpen ? '▾' : '▸'));
      toggle.appendChild(el('span', null, 'Add sequences'));
      toggle.title = 'Drop or browse for more reads to add to this alignment';
      toggle.addEventListener('click', () => { dropOpen = !dropOpen; renderSetup(); });
      row.appendChild(toggle);

      setup.appendChild(row);
    }

    if (dropOpen || !state.alignment) {
      const zone = el('div', 'ovealign-drop');
      zone.appendChild(el('div', null, isProtein()
        ? 'Drop .fa, .fasta, .faa or .gb protein files here'
        : `Drop .${ACCEPT.slice(0, 4).join(', .')} or .fasta files here`));
      const browse = el('button', 'ovealign-btn secondary', 'Browse…');
      browse.addEventListener('click', () => post('align/browse'));
      zone.appendChild(browse);
      zone.appendChild(el('div', 'ovealign-drophint',
        'Hold \u21e7 Shift while dragging from Finder, or right-click files ' +
        'in the Explorer \u2192 Add to Alignment'));
      wireDropZone(zone);
      setup.appendChild(zone);

      /*
       * Typing or pasting sequences in, for when there is no file to point at
       * -- synthesised oligos, something out of a supplier's mail, a stretch off
       * another map. A table, so a block copied from a spreadsheet goes in
       * whole. Each row goes through the same route a dropped file does: the
       * host wraps it as FASTA and ingests it, so what comes back is shaped like
       * every other read rather than a special case.
       */
      setup.appendChild(renderPasteTable());
    }

    if (state.reads.length) {
      /*
       * Collapsible, because a long read list eats the vertical space the
       * alignment itself needs. Starts open -- unlike the picker -- since the
       * per-read verdicts are the reason to look at this panel at all.
       */
      const bar = el('div', 'ovealign-addrow');
      const toggle = el('button', 'ovealign-toggle ovealign-readstoggle');
      toggle.appendChild(el('span', 'chev', readsOpen ? '▾' : '▸'));
      toggle.appendChild(el('span', null,
        `${state.reads.length} sequence${state.reads.length === 1 ? '' : 's'}`));
      toggle.title = readsOpen ? 'Hide the sequence list' : 'Show the sequence list';
      toggle.addEventListener('click', () => { readsOpen = !readsOpen; renderSetup(); });
      bar.appendChild(toggle);
      // Clears the lot; the host asks first, since the alignment goes too.
      const clear = el('button', 'ovealign-link ovealign-removeall', 'Remove all');
      clear.title = 'Remove every sequence from this alignment';
      clear.addEventListener('click', () => post('align/removeAll'));
      bar.appendChild(clear);
      setup.appendChild(bar);

      if (readsOpen) {
        const list = el('div', 'ovealign-reads');
        state.reads.forEach((r) => list.appendChild(renderRead(r)));
        setup.appendChild(list);
      }
    }

    const actions = el('div', 'ovealign-actions');
    const run = el('button', 'ovealign-btn', state.busy ? 'Aligning…' : 'Align');
    // Disabled while MAFFT is missing, so the button cannot lead to a failure
    // the banner already explains. `null` means the check has not finished.
    const mafftMissing = state.mafft ? !state.mafft.ok : false;
    run.disabled = state.busy || mafftMissing || !state.reads.length || !state.reference;
    if (mafftMissing) run.title = 'MAFFT is required — see above';
    run.addEventListener('click', () => post('align/run'));
    actions.appendChild(run);

    /*
     * Saving writes the alignment to a Stockholm file, which reopens here with
     * the reads' own annotations and traces because the file records where
     * every sequence came from as well as the columns.
     *
     * Next to Align rather than in the top bar: it acts on the alignment as a
     * whole, which is what this strip is about, and the top bar's controls are
     * all about how a trace is drawn.
     */
    const save = el('button', 'ovealign-btn secondary', 'Save…');
    save.disabled = !state.canSave;
    save.title = state.canSave
      ? (state.file
        ? `Save this alignment — opened from ${state.file}`
        : 'Save this alignment to a file that reopens with its annotations')
      : 'Align some reads first';
    save.addEventListener('click', () => post('align/save'));
    actions.appendChild(save);

    const gear = el('button', 'ovealign-link', settingsOpen ? 'Hide settings' : 'Settings');
    gear.title = 'MAFFT strategy, gap penalties and trace trimming';
    gear.addEventListener('click', () => {
      settingsOpen = !settingsOpen;
      settingsDraft = null;
      renderSetup();
    });
    actions.appendChild(gear);
    if (state.status) {
      actions.appendChild(el('span', 'ovealign-status' + (state.error ? ' is-error' : ''), state.status));
    }
    setup.appendChild(actions);
    if (settingsOpen && state.settings) setup.appendChild(renderSettings());
    restorePasteFocus();
  }

  /**
   * The alignment settings: a MAFFT strategy, the two gap penalties, and how
   * hard to trim trace ends.
   *
   * These are oven.mafftArgs and oven.alignTrimQuality, edited in a friendlier
   * shape -- the host turns the choices into the one argument string and saves
   * them where they already live. They take effect on the next Align, which is
   * the only moment they are read.
   */
  function renderSettings() {
    const saved = state.settings;
    if (!settingsDraft) {
      settingsDraft = {
        strategy: saved.strategy, custom: saved.custom,
        gapOpen: saved.gapOpen === null ? '' : String(saved.gapOpen),
        gapExtend: saved.gapExtend === null ? '' : String(saved.gapExtend),
        trimQuality: String(saved.trimQuality)
      };
    }
    const d = settingsDraft;
    const box = el('div', 'ovealign-settings');
    const row = el('div', 'ovealign-settingsrow');

    const field = (label, control, title) => {
      const f = el('label', 'ovealign-field');
      f.appendChild(el('span', null, label));
      f.appendChild(control);
      if (title) f.title = title;
      return f;
    };
    const numberBox = (key, placeholder, step) => {
      const input = el('input');
      input.type = 'number';
      input.min = '0';
      input.step = step;
      input.placeholder = placeholder;
      input.value = d[key];
      input.addEventListener('input', () => { d[key] = input.value; });
      return input;
    };

    const strategy = el('select', 'ovealign-strategy');
    for (const p of saved.presets) {
      const o = el('option', null, p.label);
      o.value = p.id;
      strategy.appendChild(o);
    }
    const custom = el('option', null, 'Custom…');
    custom.value = 'custom';
    strategy.appendChild(custom);
    strategy.value = d.strategy;
    strategy.addEventListener('change', () => { d.strategy = strategy.value; renderSetup(); });
    const preset = saved.presets.find((p) => p.id === d.strategy);
    row.appendChild(field('Strategy', strategy, preset ? `${preset.args} — ${preset.note}` : null));

    if (d.strategy === 'custom') {
      const args = el('input', 'ovealign-customargs');
      args.type = 'text';
      args.placeholder = '--localpair --maxiterate 1000';
      args.value = d.custom;
      args.addEventListener('input', () => { d.custom = args.value; });
      row.appendChild(field('MAFFT arguments', args));
    }

    row.appendChild(field('Gap opening', numberBox('gapOpen', String(saved.defaults.gapOpen), '0.01'),
      `MAFFT --op. Higher means fewer, longer gaps. Empty uses MAFFT's ${saved.defaults.gapOpen}.`));
    row.appendChild(field('Gap extension', numberBox('gapExtend', String(saved.defaults.gapExtend), '0.01'),
      `MAFFT --ep. Empty uses MAFFT's ${saved.defaults.gapExtend}.`));

    // A protein has no trace to trim.
    if (!isProtein()) {
      row.appendChild(field('Trim trace ends below Q', numberBox('trimQuality', '20', '1'),
        'Phred quality below which .ab1 ends are trimmed before aligning. 0 aligns the full read.'));
    }
    box.appendChild(row);

    box.appendChild(el('div', 'ovealign-settingsnote', preset
      ? `${preset.label}: ${preset.note}. Used the next time you press Align.`
      : 'Used the next time you press Align.'));

    const btns = el('div', 'ovealign-settingsbtns');
    const apply = el('button', 'ovealign-btn', 'Save settings');
    apply.addEventListener('click', () => {
      // The draft stays until the host reports the settings saved, so a value
      // it refuses is left in the box to correct rather than snapped back.
      post('align/updateSettings', { settings: Object.assign({}, d) });
    });
    btns.appendChild(apply);
    const all = el('button', 'ovealign-link', 'All OVEN settings…');
    all.addEventListener('click', () => post('align/openSettings', { query: '@ext:gordonrix.oven' }));
    btns.appendChild(all);
    box.appendChild(btns);
    return box;
  }

  /*
   * What a protein alignment shows: the residues, numbered, and nothing that
   * only means anything for DNA.
   *
   * DNA Colors and Reverse Sequence are set off explicitly rather than left to
   * their defaults, because the eye menu saves them to localStorage: someone who
   * once switched either on for a DNA alignment would otherwise get coloured
   * nucleotide boxes behind every A, C, G and T residue, or a row of
   * "complemented" residues under each protein.
   */
  const PROTEIN_VISIBILITY = {
    chromatogram: false, features: false, axis: true, axisNumbers: true, sequence: true,
    translations: false, cdsFeatureTranslations: false, dnaColors: false, reverseSequence: false
  };

  /**
   * (Re)build the OVE alignment view.
   *
   * createAlignmentView mounts with ReactDOM.render, so it is torn down by
   * replacing the node rather than by any API of its own.
   */
  function renderAlignment() {
    const host = $('view');
    if (!state.alignment) {
      if (!host.querySelector('.ovealign-empty')) {
        host.textContent = '';
        host.appendChild(el('div', 'ovealign-empty',
          isProtein()
            ? 'Add one or more protein sequences, then press Align.'
            : 'Add one or more reads, then press Align. Trace files show their chromatogram; ' +
              'GenBank and FASTA reads align without one.'));
      }
      return;
    }

    host.textContent = '';
    const mount = el('div', 'ovealign-main');
    mount.style.height = '100%';
    host.appendChild(mount);

    const a = state.alignment;
    lastPayload = {
      id: `ove-align-${++renderedId}`,
      // Left unset deliberately: OVE shows this next to the name, and anything
      // we put here would be a guess about the user's data. The label itself is
      // hidden in CSS, so its "Unknown Alignment Type" fallback never shows.
      alignmentTracks: a.tracks,
      // chromatogram and features are both off by default, and the setting is
      // persisted to localStorage -- so a stale value there can mask a change
      // while debugging.
      alignmentAnnotationVisibility: a.molecule === 'protein' ? PROTEIN_VISIBILITY : {
        chromatogram: true, features: true, axis: true, axisNumbers: true, sequence: true,
        // `translations` only shows translations that exist as their own
        // annotations; the amino-acid track under a CDS is a separate toggle,
        // and it is the one people mean when they ask why a CDS has no
        // translation. Both default to off.
        translations: true, cdsFeatureTranslations: true
      },
      height: Math.max(320, host.clientHeight),
      /*
       * Pins the first track -- our reference -- above the scroller.
       *
       * This is OVE's own mechanism, added for the template row in pairwise
       * mode but written generally: it renders track 0 into
       * `.alignmentTrackFixedToTop` with its own scroll holder, keeps that
       * holder's scrollLeft in step with the main one, and offsets the
       * virtualised list's indices by one so nothing is drawn twice.
       *
       * We rendered a second one-track alignment view for this before. It
       * looked right but had its own redux store, so it had its own selection
       * -- highlighting in one did nothing to the other. Same view, same store,
       * one selection.
       */
      hasTemplate: true,
      // Injected into OVE's own top bar. `additionalTopEl` renders after the
      // visibility and sort controls, i.e. beside the eye; the `...LeftEl`
      // variant lands at the far left, before the alignment name.
      additionalTopEl: reactEl('div', { ref: topBarRef })
    };
    view = window.createAlignmentView(mount, lastPayload);
    window.__oveAlignment = view;
    watchSize(host);
    wireShiftScroll(host);
  }

  /**
   * Shift+wheel scrolls the alignment sideways.
   *
   * The browser only translates shift+wheel to horizontal scrolling for the
   * document scroller, so inside OVE's own overflow container it does nothing
   * -- which is why a wide alignment was otherwise only navigable by dragging
   * the scrollbar or the minimap.
   *
   * Bound to the host rather than to a holder, once: the holders are replaced
   * on every render, and there are two of them now that OVE pins the reference.
   * Whichever one the pointer is over is found from the event.
   */
  function wireShiftScroll(host) {
    if (wireShiftScroll.wired === host) return;
    wireShiftScroll.wired = host;
    host.addEventListener('wheel', (e) => {
      if (!e.shiftKey) return;
      const holder = e.target.closest && e.target.closest('.alignmentHolder');
      if (!holder) return;
      // deltaX is already horizontal on a trackpad two-finger swipe; only the
      // vertical component needs redirecting.
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!delta) return;
      holder.scrollLeft += delta;
      e.preventDefault();
    }, { passive: false });
  }

  /**
   * Keep the alignment's height in step with the panel.
   *
   * The reducer replaces an alignment's entry wholesale rather than merging, so
   * a height update has to re-send the entire payload -- sending just {id,
   * height} would drop the tracks. Still far cheaper than re-mounting React,
   * and rAF-coalesced so a drag-resize does not dispatch per frame.
   */
  function watchSize(host) {
    if (watchSize.observing === host) return;
    watchSize.observing = host;
    let queued = false;
    new ResizeObserver(() => {
      if (queued || !view || !lastPayload) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const height = Math.max(320, host.clientHeight);
        if (height === lastPayload.height) return;
        lastPayload = Object.assign({}, lastPayload, { height });
        view.updateAlignment(lastPayload);
      });
    }).observe(host);
  }

  function render() {
    document.querySelector('.ovealign-root')
      .classList.toggle('has-alignment', Boolean(state.alignment));
    renderSetup();
    renderAlignment();
  }

  /* ------------------------------------------------------------ messaging -- */

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'align/addSequencesResult') {
      // Refused rows come back into the table, each with its reason.
      const failed = msg.failed || [];
      if (failed.length) {
        pasteRows = failed.map((f) => ({ name: f.name, sequence: f.sequence, error: f.error }));
        pasteFocus = null;
        renderSetup();
      }
      return;
    }
    if (msg.type !== 'align/state') return;
    const hadAlignment = state.alignment;
    // Settings saved -- here, or in settings.json -- replace whatever was being
    // edited; anything else leaves the edit alone.
    if (JSON.stringify(msg.state.settings) !== JSON.stringify(state.settings)) settingsDraft = null;
    state = Object.assign({}, state, msg.state);
    // The first alignment folds the picker away; losing one (a read removed, a
    // new reference) brings it back, since choosing files is the job again.
    if (state.alignment && !hadAlignment) dropOpen = false;
    if (!state.alignment) dropOpen = true;
    // Only rebuild the (expensive) alignment when it actually changed.
    if (state.alignment !== hadAlignment) render();
    else renderSetup();
  });

  // The whole panel is a drop target, not just the dashed box -- dropping onto
  // the alignment itself is the obvious thing to try once one is showing.
  //
  // Dragging is not dependable, though, and the reason is outside this webview:
  // once a drag enters the VS Code window over any of its own chrome, the
  // workbench lays a drop overlay across the whole editor area and opens what
  // you drop as a new tab. Holding Shift dismisses that overlay. The routes
  // that always work are Browse..., paste (below), and the Explorer's
  // right-click > Add to Alignment.
  wireDropZone(document.body);

  // Copy files in Finder, click the panel, press Cmd+V.
  window.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (!files || !files.length) return;
    e.preventDefault();
    sendFiles(files);
  });

  render();
  post('align/ready');
  [300, 1200, 4000].forEach((ms) => setTimeout(() => {
    if (!state.reference) post('align/ready');
  }, ms));
})();
