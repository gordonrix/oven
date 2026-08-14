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
    const change = el('button', 'ovealign-link', 'Change…');
    change.addEventListener('click', () => post('align/pickReference'));
    row.appendChild(change);
    into.appendChild(row);
  }

  function renderRead(read) {
    const chip = el('div', 'ovealign-read' + (read.error ? ' is-error' : ''));
    const name = el('span', 'ovealign-readname', read.name);
    name.title = read.path || read.name;
    chip.appendChild(name);

    if (read.error) {
      chip.appendChild(el('span', 'ovealign-readerr', read.error));
    } else if (read.mismatches !== undefined && read.mismatches !== null) {
      const clean = read.mismatches === 0;
      const stat = el('span', 'ovealign-readstat ' + (clean ? 'is-clean' : 'is-diff'),
        clean ? 'no mismatches' : `${read.mismatches} mismatch${read.mismatches === 1 ? '' : 'es'}`);
      stat.title = [
        `${read.substitutions} substitution(s), ${read.gaps} gapped column(s)`,
        read.identity !== undefined ? `identity ${(read.identity * 100).toFixed(3)}%` : null,
        read.strand === -1 ? 'aligned reverse-complemented' : 'forward strand',
        read.rotation ? `rotated ${read.rotation} bp to cross the origin` : null
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

  function renderSetup() {
    const setup = $('setup');
    setup.textContent = '';
    renderReference(setup);

    const zone = el('div', 'ovealign-drop');
    zone.appendChild(el('div', null, `Drop .${ACCEPT.slice(0, 4).join(', .')} or .fasta files here`));
    const browse = el('button', 'ovealign-btn secondary', 'Browse…');
    browse.addEventListener('click', () => post('align/browse'));
    zone.appendChild(browse);
    zone.appendChild(el('div', 'ovealign-drophint',
      'from Finder, or from the Explorer on the left'));
    wireDropZone(zone);
    setup.appendChild(zone);

    if (state.reads.length) {
      const list = el('div', 'ovealign-reads');
      state.reads.forEach((r) => list.appendChild(renderRead(r)));
      setup.appendChild(list);
    }

    const actions = el('div', 'ovealign-actions');
    const run = el('button', 'ovealign-btn', state.busy ? 'Aligning…' : 'Align');
    run.disabled = state.busy || !state.reads.length || !state.reference;
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
    const mount = el('div');
    mount.style.height = '100%';
    host.appendChild(mount);

    const a = state.alignment;
    view = window.createAlignmentView(mount, {
      id: `ove-align-${++renderedId}`,
      alignmentType: a.alignmentType || 'Sanger sequencing',
      alignmentTracks: a.tracks,
      // chromatogram and features are both off by default, and the setting is
      // persisted to localStorage -- so a stale value there can mask a change
      // while debugging.
      alignmentAnnotationVisibility: {
        chromatogram: true, features: true, translations: true,
        axis: true, axisNumbers: true, sequence: true
      },
      height: Math.max(320, host.clientHeight)
    });
    window.__oveAlignment = view;
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
    // Only rebuild the (expensive) alignment when it actually changed.
    if (state.alignment !== hadAlignment) render();
    else renderSetup();
  });

  // The whole panel is a drop target, not just the dashed box -- dropping onto
  // the alignment itself is the obvious thing to try once one is showing.
  wireDropZone(document.body);

  render();
  post('align/ready');
  [300, 1200, 4000].forEach((ms) => setTimeout(() => {
    if (!state.reference) post('align/ready');
  }, ms));
})();
