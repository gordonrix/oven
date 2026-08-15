/*
 * Change Amino Acid.
 *
 * Right-click a residue in a translation and pick any codon for it, from the
 * whole genetic code, with codon usage for the organism you are expressing in
 * shown alongside so the choice is not blind. The whole table rather than the
 * residue's own synonyms: changing which amino acid is encoded is the common
 * case, and that is not reachable from a list of synonyms.
 *
 * Its own overlay rather than a Blueprint dialog: React is inlined into the OVE
 * bundle but not exported, so there is nothing to construct one with. Same
 * approach as cartPicker.js.
 *
 * The arithmetic -- which bases a residue is made of, and how to write a codon
 * back on a reverse strand or across the origin -- is in codonEdit.js, where it
 * can be tested without a browser. This file is the dialog around it.
 */
(function () {
  'use strict';

  const ORGANISM_KEY = 'oveCart.codonOrganism';
  const NOTATION_KEY = 'oveCart.codonThreeLetter';

  let editor = null;
  let overlay = null;
  let target = null;      // what codonEdit worked out about the clicked residue
  let organism = null;
  let threeLetter = true;
  let applyEdit = null;   // OVE's updateSequenceData, from the right-click props

  const usage = () => window.OveCodonUsage;
  const edit = () => window.OveCodonEdit;

  /* Remembered locally: it is a display preference, not worth a round trip. */
  function remember(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }
  function recall(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * Which residue was right-clicked.
   *
   * OVE hands the override the whole translation, not the residue, so the one
   * thing identifying the residue is the element under the cursor. Each is a
   * <g> whose <title> reads "... -- Index: N -- ...", counting from 1.
   *
   * @returns {number|null} the index counting from 0, or null if it cannot be
   *   read -- in which case the menu item is not offered at all, rather than
   *   offered and pointed at the wrong residue.
   */
  function clickedIndex(opts) {
    const t = opts && opts.event && opts.event.target;
    const g = t && t.closest && t.closest('g');
    const match = g && /Index:\s*(\d+)/.exec(g.textContent || '');
    if (!match) return null;
    const index = Number(match[1]) - 1;
    return index >= 0 ? index : null;
  }

  /* ---------------------------------------------------------- rendering -- */

  function close() {
    if (overlay) overlay.remove();
    overlay = null;
    target = null;
  }

  function choose(codon) {
    const data = editor.getState().sequenceData;
    const next = edit().applyCodon(data.sequence, target, codon);
    if (next === data.sequence) return close();

    /*
     * Through OVE's own `updateSequenceData`, not `updateEditor`.
     *
     * `updateEditor` replaces the editor's state wholesale -- it is how a file
     * is loaded -- so an edit made that way sits outside the undo stack and
     * cmd+Z does nothing to it. It also reads as a fresh load rather than a
     * change, which left File > Save greyed out afterwards.
     *
     * `updateSequenceData` is the action OVE's own editing goes through, so the
     * edit is undoable and the document is marked dirty, both for free.
     *
     * The whole sequenceData goes back rather than just the sequence: this
     * replaces the entry rather than merging into it, so passing a fragment
     * would drop every feature on the plasmid.
     */
    applyEdit(Object.assign({}, data, { sequence: next }));
    close();
  }

  /** One codon: a clickable cell laid out as codon / AA / Frac. / Freq. */
  function cell(codon) {
    const entry = usage().lookup(organism, codon);
    const box = el('td', 'oveaa-cell');
    if (!entry) return box;
    if (codon === target.codon) box.classList.add('is-current');

    // The four fields go in a grid inside the cell, not on the cell itself:
    // display:grid on a <td> takes it out of the table's layout, and the
    // columns collapse into one.
    const inner = el('div', 'oveaa-cellgrid');
    inner.appendChild(el('span', 'oveaa-codon', codon));
    inner.appendChild(el('span', 'oveaa-aa', usage().label(entry.aa, threeLetter)));
    inner.appendChild(el('span', 'oveaa-num', usage().num(entry.fraction)));
    inner.appendChild(el('span', 'oveaa-num', usage().num(entry.frequency)));
    box.appendChild(inner);

    box.title = `${usage().FULL_NAME[entry.aa] || entry.aa} · ${codon}`;
    box.addEventListener('click', () => choose(codon));
    return box;
  }

  /**
   * The whole genetic code, arranged as it is conventionally printed: first
   * base down the side, second base across the top, third base within each
   * cell -- so an amino acid's codons are the block they sit in.
   *
   * Every codon keeps its own amino-acid label. Printed tables usually bracket
   * a block and name the residue once, which is compact on paper but leaves a
   * row meaning nothing on its own -- and here every row is a thing you click.
   */
  function grid() {
    const order = usage().ORDER;
    const table = el('table', 'oveaa-code');

    const top = el('tr');
    top.appendChild(el('td', 'oveaa-corner'));
    const across = el('th', 'oveaa-axis', 'Second letter');
    across.colSpan = order.length;
    top.appendChild(across);
    top.appendChild(el('td', 'oveaa-corner'));
    table.appendChild(top);

    const heads = el('tr');
    heads.appendChild(el('td', 'oveaa-corner'));
    for (const second of order) heads.appendChild(el('th', 'oveaa-base', second));
    heads.appendChild(el('td', 'oveaa-corner'));
    table.appendChild(heads);

    usage().GRID.forEach((row, first) => {
      order.forEach((third, depth) => {
        const tr = el('tr', 'oveaa-coderow');
        if (depth === 0 && first > 0) tr.classList.add('is-block-start');

        if (depth === 0) {
          // One label per block of four, down the left, as in the printed table.
          const label = el('th', 'oveaa-first', order[first]);
          label.rowSpan = order.length;
          tr.appendChild(label);
        }
        for (const codons of row) tr.appendChild(cell(codons[depth]));
        tr.appendChild(el('th', 'oveaa-third', third));
        table.appendChild(tr);
      });
    });

    /*
     * What the four fields in a cell are, under the leftmost block only. The
     * columns are identical, so repeating the labels four times is noise --
     * and putting them along the top would sit between the second-letter
     * header and the codons it names.
     */
    const legend = el('tr', 'oveaa-legendrow');
    legend.appendChild(el('td', 'oveaa-corner'));
    const key = el('td', 'oveaa-legend');
    const keyGrid = el('div', 'oveaa-cellgrid');
    for (const [text, cls] of [['Codon', 'oveaa-codon'], ['AA', 'oveaa-aa'],
      ['Frac.', 'oveaa-num'], ['Freq.', 'oveaa-num']]) {
      keyGrid.appendChild(el('span', cls, text));
    }
    key.appendChild(keyGrid);
    legend.appendChild(key);
    for (let i = 1; i < order.length; i++) legend.appendChild(el('td', 'oveaa-corner'));
    legend.appendChild(el('td', 'oveaa-corner'));
    table.appendChild(legend);

    const wrap = el('div', 'oveaa-grid');
    wrap.appendChild(el('div', 'oveaa-axis-left', 'First letter'));
    wrap.appendChild(table);
    wrap.appendChild(el('div', 'oveaa-axis-right', 'Third letter'));
    return wrap;
  }

  function render() {
    const body = overlay.querySelector('.oveaa-body');
    body.textContent = '';
    body.appendChild(grid());
    const source = overlay.querySelector('.oveaa-link');
    source.href = usage().sourceUrl(organism);
    source.textContent = usage().sourceUrl(organism);
  }

  function build() {
    overlay = el('div', 'oveaa-overlay');
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

    const panel = el('div', 'oveaa-panel');
    const aa = target.aminoAcid || usage().translate(target.codon);

    const head = el('div', 'oveaa-head');
    head.appendChild(el('div', 'oveaa-title', 'Change Amino Acid'));
    const shut = el('button', 'oveaa-close', '\u00d7');
    shut.title = 'Close';
    shut.addEventListener('click', close);
    head.appendChild(shut);
    panel.appendChild(head);

    const controls = el('div', 'oveaa-controls');

    const label = el('label', 'oveaa-orglabel', 'Organism');
    const picker = el('select', 'oveaa-select');
    for (const organismInfo of usage().ORGANISMS) {
      const option = el('option', null, organismInfo.label);
      option.value = organismInfo.key;
      if (organismInfo.key === organism) option.selected = true;
      picker.appendChild(option);
    }
    picker.addEventListener('change', () => {
      organism = picker.value;
      remember(ORGANISM_KEY, organism);
      render();
    });
    label.appendChild(picker);
    controls.appendChild(label);

    // Which residue is being changed, since the table itself no longer says.
    const current = el('div', 'oveaa-current');
    current.textContent = `${usage().FULL_NAME[aa] || aa} · ${target.codon}` +
      (target.forward ? '' : ' · reverse strand');
    controls.appendChild(current);

    const notation = el('div', 'oveaa-notation');
    for (const [value, text] of [[true, 'Three-letter'], [false, 'Single-letter']]) {
      const option = el('label', 'oveaa-radio');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'oveaa-notation';
      radio.checked = threeLetter === value;
      radio.addEventListener('change', () => {
        threeLetter = value;
        remember(NOTATION_KEY, threeLetter);
        render();
      });
      option.appendChild(radio);
      option.appendChild(document.createTextNode(text));
      notation.appendChild(option);
    }
    controls.appendChild(notation);
    panel.appendChild(controls);

    panel.appendChild(el('div', 'oveaa-body'));

    const foot = el('div', 'oveaa-foot');
    const frac = el('div');
    frac.appendChild(el('b', null, 'Frac.'));
    frac.appendChild(document.createTextNode(
      ' = the abundance of this codon relative to all codons for this amino acid'));
    const freq = el('div');
    freq.appendChild(el('b', null, 'Freq.'));
    freq.appendChild(document.createTextNode(
      " = the average frequency of this codon's appearance per 1000 codons in the organism"));
    const src = el('div');
    src.appendChild(el('b', null, 'Source: '));
    const link = el('a', 'oveaa-link');
    link.target = '_blank';
    link.rel = 'noreferrer';
    src.appendChild(link);
    foot.append(frac, freq, src);
    panel.appendChild(foot);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    render();
  }

  /* -------------------------------------------------------- integration -- */

  /**
   * Open the dialog for a residue. Nothing happens if it cannot be located.
   *
   * @param {function} [update] OVE's `updateSequenceData`, taken from the props
   *   handed to the right-click override -- the only way to make an edit that
   *   lands on the undo stack.
   */
  function open(annotation, aminoAcidIndex, update) {
    if (!editor || !usage() || !edit()) return;
    applyEdit = update || applyEdit;
    if (!applyEdit) return;
    const data = editor.getState().sequenceData;
    const at = edit().codonAt(data.sequence, annotation, aminoAcidIndex);
    if (!at) return;

    close();
    target = at;
    organism = recall(ORGANISM_KEY, usage().ORGANISMS[0].key);
    if (!usage().ORGANISMS.some((o) => o.key === organism)) {
      organism = usage().ORGANISMS[0].key;
    }
    threeLetter = recall(NOTATION_KEY, true);
    build();
  }

  /**
   * The menu entry, for translationRightClicked.
   *
   * @returns {Array} items to append, empty when the click cannot be tied to a
   *   particular residue -- an ORF translation, or an event we cannot read.
   */
  function menuItems(opts, props) {
    const annotation = opts && opts.annotation;
    if (!annotation || !annotation.aminoAcids || annotation.isOrf) return [];
    const index = clickedIndex(opts);
    if (index === null) return [];
    // Without a way to make an undoable edit, do not offer the item at all.
    const update = props && props.updateSequenceData;
    if (typeof update !== 'function') return [];
    return ['--', {
      text: 'Change Amino Acid…',
      className: 'ove-aminoacid-menu-item',
      onClick: () => open(annotation, index, update)
    }];
  }

  function init(api, ove) {
    editor = ove;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }

  window.OveAminoAcid = { init, open, close, menuItems, clickedIndex };
})();
