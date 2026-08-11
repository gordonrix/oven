'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { parseSharedStrings, parseSheet, colToIndex, readSheet } = require('../../src/xlsxLite');
const csvLite = require('../../src/csvLite');
const { resolveColumn } = require('../../src/inventory');

test('shared strings concatenate every run in a rich-text cell', () => {
  // This is the regression that matters. Excel stores "Tm (°C)" as three runs.
  // Reading only the first <t> yields "Tm (", and a user's column-name
  // setting would then never match, with no obvious explanation.
  const xml = `<sst>
    <si><t>Plain</t></si>
    <si><r><t>Tm (</t></r><r><rPr><i/></rPr><t>°</t></r><r><t>C)</t></r></si>
    <si><r><t>[] (</t></r><r><t>μM)</t></r></si>
    <si><t xml:space="preserve"> pad </t></si>
    <si><r><t>A</t><rPh sb="0" eb="1"><t>IGNORED</t></rPh></r><r><t>B</t></r></si>
    <si><t/></si>
  </sst>`;
  assert.deepStrictEqual(parseSharedStrings(xml), ['Plain', 'Tm (°C)', '[] (μM)', ' pad ', 'AB', '']);
});

test('shared strings unescape XML entities', () => {
  const xml = '<sst><si><t>a &amp; b &lt;c&gt; &quot;d&quot; &#65;&#x42;</t></si></sst>';
  assert.deepStrictEqual(parseSharedStrings(xml), ['a & b <c> "d" AB']);
});

test('column references decode to zero-based indices', () => {
  assert.strictEqual(colToIndex('A1'), 0);
  assert.strictEqual(colToIndex('B7'), 1);
  assert.strictEqual(colToIndex('Z1'), 25);
  assert.strictEqual(colToIndex('AA1'), 26);
  assert.strictEqual(colToIndex('BC12'), 54);
});

test('cells are placed by reference so gaps do not shift columns', () => {
  // Row 2 skips B entirely; without honouring r=, "third" would land in B.
  const xml = `<sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
    <row r="2"><c r="A2" t="s"><v>3</v></c><c r="C2" t="s"><v>4</v></c></row>
    <row r="3"><c r="A3"><v>42</v></c><c r="B3" t="str"><f>X()</f><v>formula result</v></c>
                <c r="C3" t="inlineStr"><is><t>inline</t></is></c></row>
  </sheetData>`;
  const rows = parseSheet(xml, ['name', 'seq', 'third', 'a-val', 'c-val']);
  assert.deepStrictEqual(rows[0], ['name', 'seq', 'third']);
  assert.deepStrictEqual(rows[1], ['a-val', '', 'c-val']);
  assert.deepStrictEqual(rows[2], ['42', 'formula result', 'inline']);
});

test('resolveColumn falls back, matches case-insensitively, and reports headers', () => {
  const headers = ['Name/barcode', 'Sequence', 'Length', 'Tm (°C)'];

  assert.strictEqual(resolveColumn(headers, '', 0, 'name'), 0);
  assert.strictEqual(resolveColumn(headers, '', 1, 'sequence'), 1);
  assert.strictEqual(resolveColumn(headers, 'Sequence', 1, 'sequence'), 1);
  assert.strictEqual(resolveColumn(headers, 'sequence', 1, 'sequence'), 1);
  assert.strictEqual(resolveColumn(headers, 'Tm (°C)', 1, 'x'), 3);

  assert.throws(
    () => resolveColumn(headers, 'Tm (C)', 1, 'name'),
    (err) => {
      // The whole point of the error: it must name the real headers, so a
      // degree-sign or micro-sign mismatch is obvious rather than mystifying.
      assert.match(err.message, /Tm \(C\)/);
      assert.match(err.message, /Name\/barcode \| Sequence \| Length \| Tm \(°C\)/);
      return true;
    }
  );
});

test('csv parsing handles quotes, embedded separators and newlines', () => {
  const rows = csvLite.parse('name,seq\n"a,b",ATGC\n"say ""hi""","AT\nGC"\n');
  assert.deepStrictEqual(rows, [['name', 'seq'], ['a,b', 'ATGC'], ['say "hi"', 'AT\nGC']]);
});

test('csv delimiter is sniffed from the header line', () => {
  assert.strictEqual(csvLite.sniffDelimiter('a,b,c\n1,2,3'), ',');
  assert.strictEqual(csvLite.sniffDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.deepStrictEqual(csvLite.parse('name\tseq\nBE_1\tATGC\n'), [['name', 'seq'], ['BE_1', 'ATGC']]);
});

/*
 * An optional check against a real workbook, for the awkward things a
 * hand-written fixture will not reproduce -- rich-text headers, thousands of
 * rows, characters like U+00B0 and U+03BC. Point OVECART_TEST_INVENTORY at a
 * spreadsheet to run it; it skips otherwise. No real path is committed: the
 * inventory is the user's data and so is where it lives.
 *
 *   OVECART_TEST_INVENTORY="/path/to/Primers Inventory.xlsx" npm test
 */
const REAL_INVENTORY = process.env.OVECART_TEST_INVENTORY || '';

test('reads a real inventory workbook', { skip: !REAL_INVENTORY || !fs.existsSync(REAL_INVENTORY) }, () => {
  const { rows, sheetNames } = readSheet(REAL_INVENTORY);
  assert.ok(sheetNames.length >= 1);

  const headers = rows[0];
  assert.ok(headers.length >= 2, 'need at least a name and a sequence column');
  assert.ok(headers.every((h) => typeof h === 'string'));
  // Rich-text headers are the regression this guards: a header split across
  // runs must come back whole, not truncated at the first run.
  assert.ok(headers.every((h) => !h.endsWith('(')), `header looks truncated: ${headers.join(' | ')}`);
  assert.ok(rows.length > 1, 'expected data rows below the header');

  // Casing is meaningful: lowercase marks the Gibson overhang tail.
  const mixed = rows.slice(1).map((r) => r[1]).find((s) => /[a-z]/.test(s) && /[A-Z]/.test(s));
  assert.ok(mixed, 'expected at least one mixed-case sequence to prove casing survives');
});
