/*
 * Primer Cart sidebar client.
 *
 * Rendered with createElement rather than innerHTML: primer names and plasmid
 * names come out of GenBank /label and LOCUS fields, which are not trusted
 * input.
 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);
  const listEl = $('list');
  const summaryEl = $('summary');
  const bannerEl = $('banner');
  const filterEl = $('filter');

  let items = [];
  let inventory = { status: 'disabled' };
  let sessions = [];
  let activeId = null;
  let selected = new Set();
  let lastClicked = -1;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function visible() {
    const q = filterEl.value.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.name.toLowerCase().includes(q) ||
        it.sequence.toLowerCase().includes(q) ||
        (it.sourceName || '').toLowerCase().includes(q)
    );
  }

  /** Nothing checked means "act on everything visible" -- see the button labels. */
  function targetIds() {
    const vis = visible();
    const chosen = vis.filter((it) => selected.has(it.id));
    return (chosen.length ? chosen : vis).map((it) => it.id);
  }

  function badge(item) {
    const m = item.inventoryMatch || { status: 'disabled' };
    if (m.status === 'disabled') return null;
    if (m.status === 'unknown') {
      const b = el('span', 'badge unknown', 'unknown');
      b.title = 'The primer inventory could not be read, so this primer has not been checked.';
      return b;
    }
    if (m.found) {
      const b = el('span', 'badge found', m.name ? `in inventory · ${m.name}` : 'in inventory');
      b.title = m.sequence ? `Inventory sequence: ${m.sequence}` : '';
      return b;
    }
    return el('span', 'badge fresh', 'new');
  }

  function renderBanner() {
    const inv = inventory || {};
    let text = null;
    let cls = 'banner';

    if (inv.status === 'disabled') {
      text = 'Set oveCart.inventoryPath to flag primers you have already ordered.';
      cls += ' info';
    } else if (inv.status === 'missing' || inv.status === 'error') {
      text = `Primer inventory could not be read — every primer shows as “unknown”. ${inv.message || ''}`;
      cls += ' error';
    } else if (inv.conflictWarning) {
      text = inv.conflictWarning;
      cls += ' warn';
    }

    bannerEl.textContent = '';
    if (!text) {
      bannerEl.hidden = true;
      return;
    }
    bannerEl.hidden = false;
    bannerEl.className = cls;
    bannerEl.appendChild(el('span', null, text));
    if (inv.status === 'disabled') {
      const link = el('button', 'linkbtn', 'Open settings');
      link.addEventListener('click', () => vscode.postMessage({ type: 'cart/openSettings' }));
      bannerEl.appendChild(link);
    }
  }

  function renderSummary() {
    const vis = visible();
    const chosen = vis.filter((it) => selected.has(it.id)).length;
    const bits = [`${items.length} primer${items.length === 1 ? '' : 's'}`];
    if (vis.length !== items.length) bits.push(`${vis.length} shown`);
    if (chosen) bits.push(`${chosen} selected`);
    if (inventory.status === 'ok') {
      const found = vis.filter((it) => it.inventoryMatch && it.inventoryMatch.found).length;
      bits.push(`${found} in inventory · ${vis.length - found} new`);
    }
    summaryEl.textContent = bits.join(' · ');

    const n = targetIds().length;
    const suffix = chosen ? ` (${n})` : ` (all ${n})`;
    $('copyTsv').textContent = 'Copy TSV' + (n ? suffix : '');
    $('copySeqs').textContent = 'Copy sequences' + (n ? suffix : '');
    $('remove').textContent = 'Remove' + (chosen ? ` (${chosen})` : '');
    $('remove').disabled = !chosen;
  }

  function renderRow(item, index) {
    const row = el('div', 'row' + (selected.has(item.id) ? ' selected' : ''));

    const cb = el('input', 'check');
    cb.type = 'checkbox';
    cb.checked = selected.has(item.id);
    cb.addEventListener('click', (e) => {
      if (e.shiftKey && lastClicked >= 0) {
        const vis = visible();
        const [a, b] = [Math.min(lastClicked, index), Math.max(lastClicked, index)];
        for (let i = a; i <= b; i++) {
          if (cb.checked) selected.add(vis[i].id);
          else selected.delete(vis[i].id);
        }
      } else if (cb.checked) {
        selected.add(item.id);
      } else {
        selected.delete(item.id);
      }
      lastClicked = index;
      render();
    });
    row.appendChild(cb);

    const body = el('div', 'rowbody');

    const line1 = el('div', 'line1');
    const name = el('span', 'name', item.name);
    name.title = 'Click to rename';
    name.addEventListener('click', () => startRename(item, name));
    line1.appendChild(name);
    const b = badge(item);
    if (b) line1.appendChild(b);
    body.appendChild(line1);

    const seq = el('div', 'seq', item.sequence);
    seq.title = item.sequence;
    body.appendChild(seq);

    const metaBits = [`${item.length} bp`];
    if (item.tm !== null && item.tm !== undefined) {
      metaBits.push(`Tm ${item.tm}${item.tmSource === 'notes' ? '*' : ''}`);
    }
    metaBits.push(item.strand === -1 ? 'reverse' : 'forward');
    const meta = el('div', 'meta', metaBits.join(' · '));
    if (item.tmSource === 'notes') meta.title = 'Tm marked * came from the file, not from our calculation.';
    body.appendChild(meta);

    if (item.sourceName) {
      const srcText = item.sourceName +
        (item.start !== null && item.start !== undefined ? ` · ${item.start + 1}..${item.end + 1}` : '') +
        (item.alsoFoundIn && item.alsoFoundIn.length ? ` (+${item.alsoFoundIn.length} more)` : '');
      const src = el('button', 'source', srcText);
      src.title = item.sourcePath || '';
      src.addEventListener('click', () => vscode.postMessage({ type: 'cart/openSource', id: item.id }));
      body.appendChild(src);
    }

    row.appendChild(body);

    const del = el('button', 'x', '×');
    del.title = 'Remove from cart';
    del.addEventListener('click', () => vscode.postMessage({ type: 'cart/remove', ids: [item.id] }));
    row.appendChild(del);

    return row;
  }

  function startRename(item, nameEl) {
    const input = el('input', 'renamer');
    input.type = 'text';
    input.value = item.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    const commit = () => {
      const v = input.value.trim();
      if (v && v !== item.name) vscode.postMessage({ type: 'cart/rename', id: item.id, name: v });
      else render();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') render();
    });
  }

  function renderSessionBar() {
    const active = sessions.find((s) => s.id === activeId);
    const others = sessions.length - 1;
    const btn = $('sessionName');
    btn.textContent = active ? active.name : 'Cart';
    btn.title = others > 0
      ? `Active session · ${others} other session${others === 1 ? '' : 's'} — click to switch, rename or delete`
      : 'Active session — click to rename or delete';
  }

  function render() {
    renderSessionBar();
    renderBanner();
    listEl.textContent = '';

    const vis = visible();
    if (!items.length) {
      listEl.appendChild(el('div', 'empty',
        'No primers yet. Open a plasmid, then use the Cart button in the editor — or just create a primer and it lands here automatically.'));
    } else if (!vis.length) {
      listEl.appendChild(el('div', 'empty', 'Nothing matches that filter.'));
    } else {
      vis.forEach((item, i) => listEl.appendChild(renderRow(item, i)));
    }
    renderSummary();
  }

  $('copyTsv').addEventListener('click', () => vscode.postMessage({ type: 'cart/copyTsv', ids: targetIds() }));
  $('copySeqs').addEventListener('click', () => vscode.postMessage({ type: 'cart/copySeqs', ids: targetIds() }));
  $('exportCsv').addEventListener('click', () => vscode.postMessage({ type: 'cart/exportCsv', ids: targetIds() }));
  $('remove').addEventListener('click', () => {
    const ids = visible().filter((it) => selected.has(it.id)).map((it) => it.id);
    if (ids.length) vscode.postMessage({ type: 'cart/remove', ids });
  });
  filterEl.addEventListener('input', render);
  $('sessionName').addEventListener('click', () => vscode.postMessage({ type: 'cart/manageSessions' }));
  $('newSession').addEventListener('click', () => vscode.postMessage({ type: 'cart/newSession' }));

  let gotState = false;

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'cart/state') {
      gotState = true;
      items = msg.items || [];
      inventory = msg.inventory || { status: 'disabled' };
      sessions = msg.sessions || [];
      activeId = msg.activeId || null;
      const live = new Set(items.map((it) => it.id));
      selected = new Set([...selected].filter((id) => live.has(id)));
      render();
    }
  });

  const requestState = () => vscode.postMessage({ type: 'cart/ready' });

  // A panel showing nothing while the cart is full is the worst failure mode
  // this thing has, and it only takes one dropped message. Ask again a few
  // times until state arrives, and again whenever the panel is re-shown.
  const retry = (ms) => setTimeout(() => { if (!gotState) requestState(); }, ms);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) requestState();
  });

  render();
  requestState();
  [300, 1200, 4000].forEach(retry);
})();
