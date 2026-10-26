/*
 * Reading and writing a saved alignment.
 *
 * The file is Stockholm, because of the one thing Stockholm has that the other
 * alignment formats do not: per-sequence annotation lines. An alignment is only
 * half the story here -- the tracks carry features, traces and translations
 * that live in the files the reads came from, and none of that survives a
 * format that can hold nothing but rows of letters. Stockholm lets each row say
 * where it came from, which strand it was aligned on and how it was folded, in
 * `#=GS` lines every other tool is required to skip over.
 *
 * So a saved alignment is two things at once. To HMMER, Biopython or Jalview it
 * is an ordinary alignment of DNA or protein. To OVEN it is also a recipe: reopen it and
 * the sources are read again from disk, which is what brings the annotations
 * back. The columns are never recomputed -- they are in the file, so reopening
 * needs no MAFFT and cannot drift from what was saved.
 *
 * Nothing here touches vscode or the filesystem: the host hands in what it read
 * and gets back an align()-shaped result.
 */
'use strict';

const { countDifferences, rotateString } = require('./align');
const { revComp, guessMolecule } = require('../media/cartShared');

/* Bumped only for a change that an older OVEN would read wrongly. */
const FORMAT_VERSION = 1;

const GAP = '-';
const HEADER = '# STOCKHOLM 1.0';

const degap = (row) => String(row || '').replace(/[-.]/g, '');

/* ------------------------------------------------------------- encoding -- */

/**
 * Inclusive ranges as `12-40,90` -- a single position loses its dash.
 *
 * Used for the reference a read covered and for what it read through and found
 * missing. Both are short lists even for a folded read, so they fit on the one
 * `#=GS` line the format wants.
 */
function encodeRanges(ranges) {
  return (ranges || [])
    .map(([from, to]) => (from === to ? String(from) : `${from}-${to}`))
    .join(',');
}

function decodeRanges(text) {
  const out = [];
  for (const part of String(text || '').split(',')) {
    const bit = part.trim();
    if (!bit) continue;
    const m = /^(\d+)(?:-(\d+))?$/.exec(bit);
    if (!m) continue;
    out.push([Number(m[1]), m[2] === undefined ? Number(m[1]) : Number(m[2])]);
  }
  return out;
}

/**
 * Where each column's base sits in the read, as `start:length` runs.
 *
 * Only a read folded across the origin has one, and it is nearly always two
 * runs -- the piece after the origin and the piece before it -- so writing the
 * positions out one by one would put a line of thousands of numbers in the file
 * to say something two pairs can. A run breaks wherever the read skips, which
 * is an insertion that folding dropped.
 */
function encodeRuns(indices) {
  if (!indices || !indices.length) return '';
  const runs = [];
  let start = indices[0];
  let len = 1;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === indices[i - 1] + 1) { len++; continue; }
    runs.push(`${start}:${len}`);
    start = indices[i];
    len = 1;
  }
  runs.push(`${start}:${len}`);
  return runs.join(',');
}

function decodeRuns(text) {
  const out = [];
  for (const part of String(text || '').split(',')) {
    const m = /^\s*(\d+):(\d+)\s*$/.exec(part);
    if (!m) continue;
    const start = Number(m[1]);
    for (let i = 0; i < Number(m[2]); i++) out.push(start + i);
  }
  return out;
}

/** `key=value` pairs on one line. Values carrying a space are not allowed. */
function encodeFields(fields) {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, '_')}`)
    .join(' ');
}

function decodeFields(text) {
  const out = {};
  for (const part of String(text || '').trim().split(/\s+/)) {
    if (!part) continue;
    const at = part.indexOf('=');
    if (at < 0) { out[part] = true; continue; }
    out[part.slice(0, at)] = part.slice(at + 1);
  }
  return out;
}

const flag = (v) => v === '1' || v === 'true' || v === true;
const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));

/**
 * Stockholm names cannot hold whitespace, and no two rows may share one.
 *
 * The name someone recognises -- `013_B1_cloneA_pBT0-150.ab1` -- goes in the
 * row's `DE` line, which has no such rule, so nothing is lost by tidying the
 * identifier itself.
 */
function safeIds(names) {
  const used = new Set();
  return names.map((raw, i) => {
    let id = String(raw || '').trim().replace(/\s+/g, '_').replace(/[^\w.:|+-]/g, '_');
    if (!id) id = `seq${i + 1}`;
    let out = id;
    let n = 2;
    while (used.has(out)) out = `${id}_${n++}`;
    used.add(out);
    return out;
  });
}

/* -------------------------------------------------------------- writing -- */

/**
 * Serialise an alignment.
 *
 * @param {object} spec
 *   {reference: {name, path, rel, row, circular},
 *    reads: [{name, path, rel, row, strand, rotation, folded, anchored,
 *             covered, deleted, readIndex, trim, record}],
 *    meta: {tool, created, mafftArgs, type, alphabet}}
 *   `mafftArgs` is the full argument list MAFFT was run with, as one string.
 */
function buildStockholm(spec) {
  const reference = spec.reference;
  const reads = spec.reads || [];
  const meta = spec.meta || {};
  const ids = safeIds([reference.name, ...reads.map((r) => r.name)]);
  const rows = [{ id: ids[0], row: reference.row }]
    .concat(reads.map((r, i) => ({ id: ids[i + 1], row: r.row })));

  const lines = [HEADER, ''];
  const gf = (tag, text) => lines.push(`#=GF ${tag}   ${text}`);
  gf('ID', reference.name);
  gf('DE', `OVEN alignment of ${reads.length} read${reads.length === 1 ? '' : 's'} ` +
    `against ${reference.name}`);
  if (meta.tool) gf('AU', meta.tool);
  if (meta.created) gf('DT', meta.created);
  if (meta.type) gf('TP', meta.type);
  gf('SQ', String(rows.length));
  gf('OVEN', encodeFields({
    format: FORMAT_VERSION,
    // Additive, so FORMAT_VERSION stays put: a file without it was written
    // before proteins could be aligned, and is DNA.
    alphabet: meta.alphabet || 'dna'
  }));
  /*
   * The MAFFT arguments get a line of their own. The OVEN line is space-
   * separated key=value pairs, so a value holding spaces had them turned into
   * underscores -- "--localpair_--maxiterate_1000" -- and the arguments are the
   * one value that always has them. A #=GF line's text runs to the end of the
   * line, so here they are written exactly as they were passed.
   */
  if (meta.mafftArgs) gf('MAFFT', String(meta.mafftArgs).trim());
  lines.push('');

  const gs = (id, tag, text) => lines.push(`#=GS ${id} ${tag} ${text}`);
  gs(ids[0], 'DE', reference.name);
  if (reference.path) gs(ids[0], 'SRC', reference.path);
  if (reference.rel) gs(ids[0], 'REL', reference.rel);
  gs(ids[0], 'OVEN', encodeFields({
    role: 'reference',
    circular: reference.circular ? 1 : 0,
    length: degap(reference.row).length
  }));

  reads.forEach((read, i) => {
    const id = ids[i + 1];
    lines.push('');
    gs(id, 'DE', read.name);
    if (read.path) gs(id, 'SRC', read.path);
    if (read.rel) gs(id, 'REL', read.rel);
    gs(id, 'OVEN', encodeFields({
      role: 'read',
      strand: read.strand === -1 ? -1 : 1,
      rotation: read.rotation || 0,
      folded: read.folded ? 1 : 0,
      anchored: read.anchored === false ? 0 : 1,
      trim: read.trim || 0,
      record: read.record || 0
    }));
    if (read.covered && read.covered.length) gs(id, 'COV', encodeRanges(read.covered));
    if (read.deleted && read.deleted.length) gs(id, 'DEL', encodeRanges(read.deleted));
    if (read.readIndex && read.readIndex.length) gs(id, 'IDX', encodeRuns(read.readIndex));
    /*
     * A read with no file behind it -- typed or pasted in, or dropped from
     * Finder, which gives bytes but no path -- has nowhere else to come back
     * from. The row is not enough: folding drops a read's insertions, so a
     * folded read rebuilt from its row is missing bases, and before this was
     * written those came back as Ns that the next Align then aligned.
     */
    if (read.seq) gs(id, 'SEQ', read.seq);
  });

  lines.push('');
  // One block, one line per row, names padded into a column -- interleaving
  // buys nothing when nothing is going to read this in a terminal.
  const width = Math.max(...rows.map((r) => r.id.length));
  for (const r of rows) lines.push(`${r.id.padEnd(width)}  ${r.row}`);
  lines.push('//', '');
  return lines.join('\n');
}

/* -------------------------------------------------------------- reading -- */

/** Stockholm as it is on the page: rows, `#=GF` and `#=GS` lines. */
function parseStockholm(text) {
  const rows = [];
  const byId = new Map();
  const gf = {};
  const gs = {};

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line || line === '//') continue;
    if (line.startsWith('# STOCKHOLM')) continue;

    if (line.startsWith('#=GF ')) {
      const m = /^#=GF\s+(\S+)\s*(.*)$/.exec(line);
      if (m) gf[m[1]] = gf[m[1]] ? `${gf[m[1]]} ${m[2]}` : m[2];
      continue;
    }
    if (line.startsWith('#=GS ')) {
      const m = /^#=GS\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
      if (m) {
        if (!gs[m[1]]) gs[m[1]] = {};
        gs[m[1]][m[2]] = m[3];
      }
      continue;
    }
    // #=GR and #=GC are per-column annotation we neither write nor need.
    if (line.startsWith('#')) continue;

    const m = /^(\S+)\s+(\S+)\s*$/.exec(line);
    if (!m) continue;
    const id = m[1];
    // '.' is Stockholm's other gap character; case carries no meaning for us.
    const part = m[2].replace(/\./g, GAP).toUpperCase();
    if (byId.has(id)) byId.get(id).sequence += part;
    else {
      const row = { id, sequence: part };
      byId.set(id, row);
      rows.push(row);
    }
  }
  return { gf, gs, rows };
}

/**
 * The alignment as OVEN means it.
 *
 * A Stockholm file from somewhere else parses too: with no `#=GS ... OVEN`
 * lines the first row is taken as the reference and the rest as reads on the
 * forward strand, which is exactly what the file says and all it says.
 */
function readAlignment(text) {
  const { gf, gs, rows } = parseStockholm(text);
  if (!rows.length) throw new Error('No alignment rows in this file.');

  const header = decodeFields(gf.OVEN || '');
  const oven = Boolean(gf.OVEN);
  const meta = {
    format: num(header.format, 0),
    /*
     * What the file says, when it says. One we wrote before this field existed
     * is DNA, since that is all there was. One from somewhere else says
     * nothing, and is classified from its first row by the same rule as any
     * sequence -- a Pfam-style file is far more often protein than not.
     */
    alphabet: header.alphabet === 'protein' || header.alphabet === 'dna'
      ? header.alphabet
      : (oven ? 'dna' : guessMolecule(degap(rows[0].sequence))),
    /*
     * From its own line; or, in a file written before it had one, from the
     * OVEN line, with the underscores that stood in for spaces put back. MAFFT
     * options never contain an underscore, so nothing is lost doing that.
     */
    mafftArgs: gf.MAFFT || String(header.mafftArgs || '').replace(/_/g, ' '),
    tool: gf.AU || '',
    created: gf.DT || '',
    type: gf.TP || '',
    // What tells a file we wrote from one that merely parses.
    oven
  };

  const info = (id) => gs[id] || {};
  const fieldsOf = (id) => decodeFields(info(id).OVEN || '');

  const refId = rows[0].id;
  const refFields = fieldsOf(refId);
  const reference = {
    id: refId,
    name: info(refId).DE || refId,
    path: info(refId).SRC || null,
    rel: info(refId).REL || null,
    row: rows[0].sequence,
    // A reference with no topology recorded is treated as circular, which is
    // what every plasmid here is and what the aligner already assumes.
    circular: refFields.circular === undefined ? true : flag(refFields.circular)
  };

  const reads = rows.slice(1).map((row) => {
    const f = fieldsOf(row.id);
    const readIndex = decodeRuns(info(row.id).IDX || '');
    return {
      id: row.id,
      name: info(row.id).DE || row.id,
      path: info(row.id).SRC || null,
      rel: info(row.id).REL || null,
      row: row.sequence,
      strand: num(f.strand, 1) === -1 ? -1 : 1,
      rotation: num(f.rotation, 0),
      folded: flag(f.folded),
      anchored: f.anchored === undefined ? true : flag(f.anchored),
      trim: num(f.trim, 0),
      record: num(f.record, 0),
      covered: decodeRanges(info(row.id).COV || ''),
      deleted: decodeRanges(info(row.id).DEL || ''),
      readIndex: readIndex.length ? readIndex : null,
      seq: String(info(row.id).SEQ || '').replace(/\s/g, '').toUpperCase() || null
    };
  });

  const length = reference.row.length;
  for (const r of reads) {
    if (r.row.length !== length) {
      throw new Error(`Row "${r.id}" is ${r.row.length} columns; the reference is ${length}.`);
    }
  }
  return { reference, reads, meta };
}

/* ------------------------------------------------------------ rebuilding -- */

/**
 * Carve a shared pair of rows into the pairwise form the mismatch counts are
 * measured on -- the same rule splitPairs uses, for the same reason: a column
 * gapped in both rows belongs to some other read's insertion.
 */
function pairRows(referenceRow, readRow) {
  const ref = [];
  const read = [];
  for (let i = 0; i < referenceRow.length; i++) {
    if (referenceRow[i] === GAP && readRow[i] === GAP) continue;
    ref.push(referenceRow[i]);
    read.push(readRow[i]);
  }
  return [ref.join(''), read.join('')];
}

/** The read as it was handed to the aligner: flipped if it was, rotated if it was. */
function orientRead(sequence, read, molecule) {
  const flip = read.strand === -1 && molecule !== 'protein';
  const oriented = flip ? revComp(String(sequence).toUpperCase())
    : String(sequence).toUpperCase();
  return {
    oriented,
    columnOrder: read.readIndex
      ? read.readIndex.map((i) => oriented[i] || GAP).join('')
      : rotateString(oriented, read.rotation)
  };
}

/**
 * Is this the file that row came from? Its bases, oriented and folded the way
 * the read was, have to be the row's letters exactly -- the same test rebuild
 * holds every source to.
 */
function fitsRow(source, read, molecule) {
  if (!source || (source.molecule && source.molecule !== molecule)) return false;
  return orientRead(source.sequence, read, molecule).columnOrder === degap(read.row);
}

/**
 * Put the read back in read order when there is nothing else to go on.
 *
 * A folded read is stored in column order, and the letters alone cannot say
 * where the origin fell -- but `IDX` can, so the read is laid back out from it.
 *
 * Any base folding dropped -- an insertion -- has nowhere to come from, and is
 * left out rather than made up. It used to come back as an N, and pressing
 * Align then aligned the Ns: a 120-base read with four of them came back with
 * nearly eighteen thousand gaps, and dragged the reads aligned alongside it
 * out of place with it. `lost` says how many there were, so it can be said.
 */
function readOrderFrom(columnOrder, readIndex) {
  if (!readIndex || !readIndex.length) return { sequence: columnOrder, lost: 0, readIndex };
  const out = new Array(Math.max(...readIndex) + 1).fill(null);
  readIndex.forEach((at, col) => { out[at] = columnOrder[col] || null; });
  /*
   * With the lost bases left out, the read is shorter than IDX counts, so IDX
   * is renumbered to match it. Otherwise saving again would write the shorter
   * read beside the old numbering, and the next reopen would find the two
   * disagreeing and call the read changed.
   */
  const renumber = [];
  let next = 0;
  for (const base of out) renumber.push(base === null ? -1 : next++);
  return {
    sequence: out.filter((b) => b !== null).join(''),
    lost: out.length - next,
    readIndex: readIndex.map((at) => renumber[at])
  };
}

/**
 * Rebuild an align()-shaped result from a saved alignment and its sources.
 *
 * `sources.reference` and each `sources.reads[i]` is the track parsed out of
 * the file that row came from, or null when it could not be read. A source
 * whose bases no longer match the row it is supposed to explain is refused
 * rather than drawn: the file has changed since the alignment was saved, and
 * hanging its annotations on these columns would put them in the wrong place.
 *
 * @returns {{reference, msa, tracks, problems: Array<{name, reason}>}}
 */
function rebuild(spec, sources = {}) {
  const problems = [];
  const molecule = spec.meta && spec.meta.alphabet === 'protein' ? 'protein' : 'dna';
  const refRow = spec.reference.row;
  const refBases = degap(refRow);
  // A source that now parses as the other kind of molecule is not the file
  // this alignment was made from, whatever its letters.
  const changed = (src) => Boolean(src && src.molecule && src.molecule !== molecule);

  let reference = sources.reference || null;
  if (reference && (changed(reference) || String(reference.sequence || '').toUpperCase() !== refBases)) {
    problems.push({ name: spec.reference.name, reason: 'has changed since the alignment was saved' });
    reference = null;
  } else if (!reference && spec.reference.path) {
    problems.push({ name: spec.reference.name, reason: 'could not be read' });
  }
  if (!reference) {
    const circular = molecule === 'protein' ? false : spec.reference.circular;
    reference = {
      name: spec.reference.name,
      sequence: refBases,
      circular,
      sequenceData: {
        name: spec.reference.name,
        sequence: refBases,
        circular,
        features: []
      },
      chromatogramData: null
    };
  }
  reference = Object.assign({}, reference, { path: spec.reference.path || null, molecule });

  const reads = [];
  const tracks = spec.reads.map((read, at) => {
    const want = degap(read.row);
    let source = (sources.reads || [])[at] || null;
    // A read the file carries itself is its own source, and is held to the
    // same check as a file read back from disk.
    if (!source && read.seq) source = { name: read.name, sequence: read.seq, molecule };

    if (source) {
      const { columnOrder } = orientRead(source.sequence, read, molecule);
      if (changed(source) || columnOrder !== want) {
        problems.push({ name: read.name, reason: 'has changed since the alignment was saved' });
        source = null;
      }
    } else if (read.path) {
      problems.push({ name: read.name, reason: 'could not be read' });
    }

    let oriented;
    let readIndex = read.readIndex;
    if (source) {
      oriented = orientRead(source.sequence, read, molecule).oriented;
    } else {
      const rebuilt = readOrderFrom(want, read.readIndex);
      oriented = rebuilt.sequence;
      readIndex = rebuilt.readIndex;
      // Only a read with no file and no SEQ gets here unflagged: one saved by
      // 1.59, or typed in before SEQ existed.
      if (rebuilt.lost && !read.path) {
        problems.push({
          name: read.name,
          reason: `was saved without its own sequence, and ${rebuilt.lost} of its bases ` +
            `(insertions) could not be recovered -- add it again to restore them`
        });
      }
    }

    reads.push(Object.assign({}, source || {}, {
      name: read.name,
      path: read.path || null,
      // The bases as the aligner saw them, so pressing Align again on a
      // restored alignment realigns the same sequence -- on its own strand,
      // which is the one the file holds.
      sequence: source ? String(source.sequence).toUpperCase()
        : (read.strand === -1 && molecule !== 'protein' ? revComp(oriented) : oriented),
      molecule,
      raw: source ? source.raw || source : null,
      chromatogramData: source ? source.chromatogramData || null : null,
      restored: true,
      missing: !source
    }));

    const folded = Boolean(read.folded);
    const [referenceRow, readRow] = folded ? [refRow, read.row] : pairRows(refRow, read.row);
    /*
     * A folded read with nothing deleted still carries an empty list rather
     * than nothing at all: `covered` is what says the read brought its own
     * coverage, and the two are read together.
     */
    const covered = folded && read.covered.length ? read.covered : null;
    const deleted = covered ? read.deleted : null;

    return Object.assign({
      name: read.name,
      strand: read.strand,
      anchored: read.anchored,
      rotation: read.rotation,
      sequence: folded ? oriented : rotateString(oriented, read.rotation),
      referenceRow,
      readRow,
      covered,
      crossesOrigin: folded,
      columnOrderSequence: folded ? want : null,
      readIndex,
      deleted
    }, countDifferences(referenceRow, readRow, {
      wraps: Boolean(read.rotation),
      covered,
      deleted
    }));
  });

  return {
    reference,
    molecule,
    reads,
    msa: {
      reference: refRow,
      rows: spec.reads.map((r) => ({ name: r.name, sequence: r.row }))
    },
    tracks,
    problems
  };
}

module.exports = {
  FORMAT_VERSION, buildStockholm, parseStockholm, readAlignment, rebuild, fitsRow,
  encodeRanges, decodeRanges, encodeRuns, decodeRuns,
  encodeFields, decodeFields, safeIds, degap, pairRows
};
