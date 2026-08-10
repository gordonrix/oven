/* RFC4180-ish CSV/TSV parser: quoted fields, doubled quotes, embedded newlines. */
'use strict';

const fs = require('fs');

/** Pick , or \t by whichever occurs more in the header line. */
function sniffDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const commas = (firstLine.match(/,/g) || []).length;
  const tabs = (firstLine.match(/\t/g) || []).length;
  return tabs > commas ? '\t' : ',';
}

function parse(text, delimiter) {
  const d = delimiter || sniffDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') { inQuotes = true; }
    else if (ch === d) { row.push(field); field = ''; }
    else if (ch === '\r') { /* handled by the \n branch */ }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else { field += ch; }
  }

  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function readFile(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  return parse(text);
}

module.exports = { parse, readFile, sniffDelimiter };
