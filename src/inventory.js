/*
 * Cross-references cart primers against a user-supplied inventory of primers
 * they have already ordered.
 *
 * The status model matters more than it looks. A failed read must never
 * present as "these are all new" -- that is how you reorder an oligo you
 * already have in the freezer. So status is three-valued and the UI shows a
 * neutral "unknown" badge for anything other than a clean load.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const config = require('./config');
const csvLite = require('./csvLite');
const xlsxLite = require('./xlsxLite');
const primerMatch = require('./primerMatch');
const { normalizeSeqKey } = require('../media/cartShared');

const READ_TIMEOUT_MS = 3000;

let cache = null; // {path, mtimeMs, size, result}

/** @returns {{status:'disabled'|'ok'|'missing'|'error', ...}} */
function load() {
  const file = config.inventoryPath();
  if (!file) return { status: 'disabled' };

  const base = path.basename(file);
  if (base.startsWith('~$')) {
    return {
      status: 'error',
      path: file,
      message: `"${base}" is an Excel lock file, not a workbook. Point oven.inventoryPath at the real file.`
    };
  }

  let stat;
  try {
    stat = statWithTimeout(file);
  } catch (e) {
    return { status: 'missing', path: file, message: `Cannot read ${file}: ${e.message}` };
  }

  if (cache && cache.path === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.result;
  }

  let result;
  try {
    result = parseInventory(file);
  } catch (e) {
    result = { status: 'error', path: file, message: e.message };
  }

  cache = { path: file, mtimeMs: stat.mtimeMs, size: stat.size, result };
  return result;
}

/**
 * Dropbox CloudStorage placeholders can block while the file is hydrated from
 * the network. A stalled stat must not take the extension host with it.
 */
function statWithTimeout(file) {
  const started = Date.now();
  const stat = fs.statSync(file);
  if (Date.now() - started > READ_TIMEOUT_MS) {
    throw new Error('timed out (the file may still be downloading from cloud storage)');
  }
  return stat;
}

function parseInventory(file) {
  const ext = path.extname(file).toLowerCase();
  let rows;
  let sheetName = null;
  let sheetNames = [];

  if (ext === '.csv' || ext === '.tsv' || ext === '.txt') {
    rows = csvLite.readFile(file);
  } else if (ext === '.xlsx' || ext === '.xlsm') {
    const out = xlsxLite.readSheet(file, config.inventorySheet() || undefined);
    rows = out.rows;
    sheetName = out.sheetName;
    sheetNames = out.sheetNames;
  } else {
    throw new Error(`unsupported inventory file type "${ext}". Use .xlsx or .csv.`);
  }

  if (!rows || !rows.length) throw new Error('the inventory file has no rows');

  const headers = (rows[0] || []).map((h) => String(h === undefined ? '' : h).trim());
  const nameIdx = resolveColumn(headers, config.inventoryNameColumn(), 0, 'name');
  const seqIdx = resolveColumn(headers, config.inventorySequenceColumn(), 1, 'sequence');

  // Alias and description are decoration, not identity, so their lookup must
  // never fail the parse -- resolveColumn throws, and a file without an
  // "Alias" header would otherwise turn status:'ok' into status:'error' and
  // take the inventory badges down with it.
  const aliasIdx = optionalColumn(headers, config.inventoryAliasColumn(), 'Alias');
  const descIdx = optionalColumn(headers, config.inventoryDescriptionColumn(), 'Description');

  const cell = (row, i) => (i < 0 || row[i] === undefined ? '' : String(row[i]).trim());

  const bySeq = new Map();
  const entries = [];
  let duplicates = 0;
  let counted = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const seq = String(row[seqIdx] === undefined ? '' : row[seqIdx]).trim();
    if (!seq) continue;
    counted++;
    const name = cell(row, nameIdx);

    // Search wants every row, including duplicates-by-sequence: two inventory
    // entries with the same oligo are still two things you could pick off the
    // shelf. The matcher dedupes per binding site instead.
    entries.push({ name, sequence: seq, alias: cell(row, aliasIdx), description: cell(row, descIdx) });

    const key = normalizeSeqKey(seq);
    if (bySeq.has(key)) { duplicates++; continue; } // first occurrence wins
    bySeq.set(key, {
      name,
      sequence: seq // echoed verbatim: lower/upper case encodes overhang vs annealing region
    });
  }

  return {
    status: 'ok',
    path: file,
    sheetName,
    sheetNames,
    headers,
    nameColumn: headers[nameIdx],
    sequenceColumn: headers[seqIdx],
    aliasColumn: aliasIdx < 0 ? null : headers[aliasIdx],
    descriptionColumn: descIdx < 0 ? null : headers[descIdx],
    rowCount: counted,
    duplicates,
    bySeq,
    entries
  };
}

/**
 * Resolve an optional column: the configured header if set, else a header with
 * the conventional name, else -1. Never throws.
 */
function optionalColumn(headers, wanted, conventional) {
  const target = wanted || conventional;
  if (!target) return -1;
  const exact = headers.indexOf(target);
  if (exact >= 0) return exact;
  return headers.findIndex((h) => h.toLowerCase() === String(target).toLowerCase());
}

/**
 * Exact header match, then case-insensitive, else a hard error naming the
 * headers that are actually present. Inventory headers routinely contain
 * characters that are easy to mistype (U+00B0 degree, U+03BC micro), and
 * without the list a mismatch is a very slow thing to debug.
 */
function resolveColumn(headers, wanted, fallbackIdx, label) {
  if (!wanted) {
    if (fallbackIdx >= headers.length) {
      throw new Error(`no column ${fallbackIdx + 1} to use as the ${label} column. Headers found: ${headers.join(' | ')}`);
    }
    return fallbackIdx;
  }
  let idx = headers.indexOf(wanted);
  if (idx < 0) idx = headers.findIndex((h) => h.toLowerCase() === wanted.toLowerCase());
  if (idx < 0) {
    throw new Error(`${label} column "${wanted}" not found. Headers found: ${headers.join(' | ')}`);
  }
  return idx;
}

/** Attach an inventoryMatch to each cart item. Never mutates the stored cart. */
function annotate(items) {
  const inv = load();
  const ok = inv.status === 'ok';

  const annotated = items.map((it) => {
    let match;
    if (!ok) {
      match = { status: inv.status === 'disabled' ? 'disabled' : 'unknown', found: false };
    } else {
      const hit = inv.bySeq.get(normalizeSeqKey(it.sequence));
      match = hit
        ? { status: 'ok', found: true, name: hit.name, sequence: hit.sequence }
        : { status: 'ok', found: false };
    }
    return Object.assign({}, it, { inventoryMatch: match });
  });

  return {
    items: annotated,
    inventory: {
      status: inv.status,
      path: inv.path || '',
      sheetName: inv.sheetName || null,
      nameColumn: inv.nameColumn || null,
      sequenceColumn: inv.sequenceColumn || null,
      rowCount: inv.rowCount || 0,
      duplicates: inv.duplicates || 0,
      message: inv.message || null
    }
  };
}

function invalidate() {
  cache = null;
  indexCache = null;
}

/*
 * The plasmid k-mer index is memoised so repeated searches on one file (scope
 * toggles, re-runs) skip the rebuild. Keyed on length plus both ends rather
 * than the whole sequence, which is enough to notice a different plasmid
 * without hashing 10 kb on every call.
 */
let indexCache = null;

function indexFor(sequence, circular, maxPrimerLen) {
  const key = `${sequence.length}|${circular}|${sequence.slice(0, 64)}|${sequence.slice(-64)}`;
  if (indexCache && indexCache.key === key) return indexCache.index;
  const index = primerMatch.buildIndex(sequence, circular, maxPrimerLen);
  indexCache = { key, index };
  return index;
}

/**
 * Search the inventory for primers binding this sequence.
 *
 * @returns {{hits, inventory, tookMs, scanned, skipped, truncated}} — `hits` is
 *   empty whenever the inventory is not loadable, and `inventory.status` says why.
 */
function searchSequence(sequence, circular, opts) {
  const inv = load();
  const summary = {
    status: inv.status,
    path: inv.path || '',
    message: inv.message || null,
    rowCount: inv.rowCount || 0
  };
  if (inv.status !== 'ok') {
    return { hits: [], inventory: summary, tookMs: 0, scanned: 0, skipped: 0, truncated: false };
  }

  const entries = inv.entries || [];
  const maxPrimerLen = entries.reduce((m, e) => Math.max(m, e.sequence.length), 0);

  const t0 = Date.now();
  const index = indexFor(String(sequence || '').toUpperCase(), Boolean(circular), maxPrimerLen);
  const res = primerMatch.search(index, entries, opts);
  return Object.assign({ inventory: summary, tookMs: Date.now() - t0 }, res);
}

module.exports = { load, annotate, invalidate, resolveColumn, optionalColumn, searchSequence };
