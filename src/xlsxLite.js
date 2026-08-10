/*
 * Minimal .xlsx reader: enough to pull two columns of text out of one sheet.
 *
 * Deliberately dependency-free. An xlsx is a ZIP and Node ships zlib, so the
 * whole job is a few hundred lines -- versus adding a parser dependency to an
 * extension whose entire build story is "committed prebuilt files, no bundler".
 * (The npm build of SheetJS is also frozen at 0.18.5 with unfixed advisories.)
 *
 * Not supported, because this never needs them: number formats and dates
 * (values come back as raw serials), styles, formulas (the cached value is
 * used), and zip64 archives.
 */
'use strict';

const fs = require('fs');
const zlib = require('zlib');

/* ------------------------------------------------------------------ ZIP -- */

function findEocd(buf) {
  const maxBack = Math.min(buf.length, 0xffff + 22);
  for (let i = buf.length - 22; i >= buf.length - maxBack; i--) {
    if (i >= 0 && buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** @returns {Map<string, {offset:number, method:number, compSize:number}>} */
function readCentralDirectory(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { offset: localOffset, method, compSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, entry) {
  if (!entry) return null;
  const p = entry.offset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('corrupt zip entry header');
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw.toString('utf8');
  if (entry.method === 8) return zlib.inflateRawSync(raw).toString('utf8');
  throw new Error(`unsupported zip compression method ${entry.method}`);
}

/* ------------------------------------------------------------------ XML -- */

function unescapeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Shared strings, one entry per <si>.
 *
 * Every <t> inside an <si> must be concatenated. Rich text splits a single
 * cell across runs, and taking only the first <t> silently truncates: in the
 * reference inventory the header "Tm (°C)" is stored as three runs and would
 * read back as "Tm (", so a user's column-name setting would never match.
 * <rPh> holds furigana annotations and is not part of the value.
 */
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    const body = (m[1] || '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    let text = '';
    const tRe = /<t\b[^>]*\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(body)) !== null) text += unescapeXml(t[1] || '');
    out.push(text);
  }
  return out;
}

/** "BC" -> 54 (0-based) */
function colToIndex(ref) {
  const letters = String(ref).replace(/[^A-Za-z]/g, '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Sheet rows as arrays of strings.
 *
 * Cells are placed by their r="B7" reference rather than by position: rows
 * omit empty cells entirely, so a sheet with a gap (or a formula column
 * between populated ones) would otherwise shift everything left.
 */
function parseSheet(xml, strings) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
  let rm;
  while ((rm = rowRe.exec(xml)) !== null) {
    const body = rm[1] || '';
    const cells = [];
    const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(body)) !== null) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const refMatch = /\br="([A-Z]+)\d+"/i.exec(attrs);
      const idx = refMatch ? colToIndex(refMatch[1]) : cells.length;
      const typeMatch = /\bt="([^"]+)"/.exec(attrs);
      const type = typeMatch ? typeMatch[1] : 'n';

      let value = '';
      if (type === 'inlineStr') {
        let t;
        const tRe = /<t\b[^>]*\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g;
        while ((t = tRe.exec(inner)) !== null) value += unescapeXml(t[1] || '');
      } else {
        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        const raw = vMatch ? unescapeXml(vMatch[1]) : '';
        value = type === 's' ? (strings[parseInt(raw, 10)] || '') : raw;
      }

      cells[idx] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

/* --------------------------------------------------------------- public -- */

/**
 * @param {string} file path to an .xlsx
 * @param {string} [sheetName] worksheet to read; first sheet when omitted
 * @returns {{sheetName:string, sheetNames:string[], rows:string[][]}}
 */
function readSheet(file, sheetName) {
  const buf = fs.readFileSync(file);
  const dir = readCentralDirectory(buf);

  const workbookXml = readEntry(buf, dir.get('xl/workbook.xml'));
  if (!workbookXml) throw new Error('missing xl/workbook.xml -- is this really an .xlsx?');

  const sheets = [];
  const sheetRe = /<sheet\b([^>]*)\/?>/g;
  let sm;
  while ((sm = sheetRe.exec(workbookXml)) !== null) {
    const attrs = sm[1];
    const name = /\bname="([^"]*)"/.exec(attrs);
    const rid = /\br:id="([^"]*)"/.exec(attrs);
    if (name) sheets.push({ name: unescapeXml(name[1]), rid: rid ? rid[1] : null });
  }
  if (!sheets.length) throw new Error('workbook declares no sheets');

  // Resolve r:id -> part name; do not assume the first tab is sheet1.xml.
  const relsXml = readEntry(buf, dir.get('xl/_rels/workbook.xml.rels')) || '';
  const relTargets = new Map();
  const relRe = /<Relationship\b([^>]*)\/?>/g;
  let rl;
  while ((rl = relRe.exec(relsXml)) !== null) {
    const id = /\bId="([^"]*)"/.exec(rl[1]);
    const target = /\bTarget="([^"]*)"/.exec(rl[1]);
    if (id && target) relTargets.set(id[1], unescapeXml(target[1]));
  }

  const wanted = sheetName
    ? sheets.find((s) => s.name === sheetName) ||
      sheets.find((s) => s.name.toLowerCase() === String(sheetName).toLowerCase())
    : sheets[0];
  if (!wanted) {
    throw new Error(`sheet "${sheetName}" not found. Sheets in this workbook: ${sheets.map((s) => s.name).join(', ')}`);
  }

  let target = wanted.rid ? relTargets.get(wanted.rid) : null;
  if (!target) target = 'worksheets/sheet1.xml';
  target = target.replace(/^\//, '');
  const partName = target.startsWith('xl/') ? target : `xl/${target}`;

  const sheetXml = readEntry(buf, dir.get(partName));
  if (!sheetXml) throw new Error(`worksheet part ${partName} missing from the archive`);

  const strings = parseSharedStrings(readEntry(buf, dir.get('xl/sharedStrings.xml')));
  return { sheetName: wanted.name, sheetNames: sheets.map((s) => s.name), rows: parseSheet(sheetXml, strings) };
}

module.exports = { readSheet, parseSharedStrings, parseSheet, colToIndex };
