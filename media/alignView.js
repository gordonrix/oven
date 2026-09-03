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

  const ACCEPT = ['ab1', 'gb', 'gbk', 'fa', 'fasta', 'dna'];

  let state = {
    reference: null,
    reads: [],
    status: '',
    error: '',
    busy: false,
    alignment: null
  };
  let view = null;      // the live createAlignmentView handle

  let renderedId = 0;   // bumped so a stale alignment is never re-shown
  let lastPayload = null;
  let dropOpen = true;  // the picker IS the empty state until there is an alignment
  let readsOpen = true; // the chips are useful until there are twenty of them

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
    const label = window.CartShared.alignmentVerdict(read, referenceLength);
    return label ? { label, cls: VERDICT_CLASS[label] } : null;
  }

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

  const AMPLITUDE_STEP = 1.3;

  function renderTopControls() {
    if (!topBarRoot || !window.OveChromScale) return;
    topBarRoot.textContent = '';
    topBarRoot.className = 'ovealign-topctl';

    /*
     * Track height: how tall each chromatogram window is. Shaped like OVE's
     * zoom slider next to it -- an icon each side saying which way is bigger --
     * because it does the same kind of job.
     */
    const height = el('div', 'ovealign-ctlgroup');
    height.title = 'Height of every chromatogram window';
    height.appendChild(gapIcon(2)('Shorter windows'));
    const slider = el('input', 'ovealign-ctlslider');
    slider.type = 'range';
    slider.min = '24';
    slider.max = '220';
    slider.step = '2';
    slider.value = String(window.OveChromScale.height());
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
    amp.title = 'Peak height within each chromatogram';
    amp.appendChild(traceIcon('Peak height'));
    amp.appendChild(ctlButton('▲', 'Taller peaks',
      () => window.OveChromScale.nudge(AMPLITUDE_STEP)));
    amp.appendChild(ctlButton('▼', 'Shorter peaks',
      () => window.OveChromScale.nudge(1 / AMPLITUDE_STEP)));
    amp.appendChild(ctlButton('⤢', 'Fit peaks to the window',
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
      // The Explorer sends URIs, not files. Cheaper too: the host reads from
      // disk instead of the bytes crossing the message channel.
      const uriList = dt.getData('text/uri-list') || dt.getData('resourceurls') || '';
      const uris = uriList.split(/\r?\n/).map((s) => s.trim())
        .filter((s) => s && !s.startsWith('#'));
      if (uris.length) post('align/addUris', { uris });
      else setStatus('Nothing usable in that drop — try Browse instead.', true);
    });
  }

  /* ------------------------------------------------------------ rendering -- */

  function renderReference(into) {
    const row = el('div', 'ovealign-refrow');
    row.appendChild(el('span', 'ovealign-reflabel', 'Reference:'));
    if (state.reference) {
      row.appendChild(el('span', 'ovealign-refname', state.reference.name));
      row.appendChild(el('span', 'ovealign-refmeta',
        `${state.reference.length} bp · ${state.reference.circular ? 'circular' : 'linear'}`));
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
      stat.title = [
        refLen
          ? `covers ${covered} of ${refLen} bp (${((covered / refLen) * 100).toFixed(1)}%)`
          : `covers ${covered} bp`,
        `${read.substitutions} substitution(s), ${read.gaps} gapped column(s)`,
        read.identity !== undefined ? `identity ${(read.identity * 100).toFixed(3)}%` : null,
        read.strand === -1 ? 'aligned reverse-complemented' : 'forward strand',
        read.rotation ? `rotated ${read.rotation} bp to cross the origin` : null,
        read.anchored === false ? 'no anchor found on the reference' : null
      ].filter(Boolean).join('\n');
      chip.appendChild(stat);
    } else if (read.length) {
      chip.appendChild(el('span', 'ovealign-readstat', `${read.length} bp`));
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

    const cmds = el('div', 'ovealign-cmds');
    cmds.appendChild(el('code', null, 'brew install mafft'));
    cmds.appendChild(el('code', null, 'conda install -c bioconda mafft'));
    box.appendChild(cmds);

    const row = el('div', 'ovealign-bannerbtns');
    const locate = el('button', 'ovealign-btn', 'Locate MAFFT…');
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

  function renderSetup() {
    const setup = $('setup');
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
      zone.appendChild(el('div', null, `Drop .${ACCEPT.slice(0, 4).join(', .')} or .fasta files here`));
      const browse = el('button', 'ovealign-btn secondary', 'Browse…');
      browse.addEventListener('click', () => post('align/browse'));
      zone.appendChild(browse);
      zone.appendChild(el('div', 'ovealign-drophint',
        'Hold \u21e7 Shift while dragging from Finder, or right-click files ' +
        'in the Explorer \u2192 Add to Alignment'));
      wireDropZone(zone);
      setup.appendChild(zone);

      /*
       * Typing a sequence in, for when there is no file to point at -- a
       * synthesised oligo, something out of a supplier's mail, a stretch off
       * another map. It goes through the same route a dropped file does: the
       * host wraps it as FASTA and ingests it, so the entry that comes back is
       * shaped like every other read rather than a special case.
       */
      const paste = el('div', 'ovealign-pasteseq');
      const nameBox = el('input', 'ovealign-pastename');
      nameBox.type = 'text';
      nameBox.placeholder = 'Name (optional)';
      const seqBox = el('input', 'ovealign-pastebases');
      seqBox.type = 'text';
      seqBox.placeholder = 'Paste or type a DNA sequence';
      const add = el('button', 'ovealign-btn secondary ovealign-pasteadd', 'Add');

      const submit = () => {
        const sequence = seqBox.value.trim();
        if (!sequence) { seqBox.focus(); return; }
        post('align/addSequence', { name: nameBox.value.trim(), sequence });
        nameBox.value = '';
        seqBox.value = '';
        seqBox.focus();
      };
      add.addEventListener('click', submit);
      // Enter from either box, since the name is optional and often skipped.
      for (const box of [nameBox, seqBox]) {
        box.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
        });
      }

      paste.appendChild(nameBox);
      paste.appendChild(seqBox);
      paste.appendChild(add);
      setup.appendChild(paste);
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
    if (state.status) {
      actions.appendChild(el('span', 'ovealign-status' + (state.error ? ' is-error' : ''), state.status));
    }
    setup.appendChild(actions);
  }

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
          'Add one or more reads, then press Align. Trace files show their chromatogram; ' +
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
      alignmentAnnotationVisibility: {
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
    if (msg.type !== 'align/state') return;
    const hadAlignment = state.alignment;
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
