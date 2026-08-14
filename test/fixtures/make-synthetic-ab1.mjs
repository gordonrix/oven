/*
 * Generates test/fixtures/synthetic-trace.ab1 and synthetic-trace-tiny.ab1.
 *
 * A real .ab1 from the lab would put an unpublished construct in a public repo,
 * and would also be a poor test: the interesting cases here are structural, and
 * a hand-built file can carry all of them on purpose rather than by luck.
 *
 * Deliberately included, because each one broke the vendored parser:
 *   - PBAS/PLOC/PCON present as tag number 1 only. Tag number 2 is the edited
 *     copy, which plenty of instruments never write; the parser asked for 2 and
 *     got undefined, then threw building the per-bp trace.
 *   - Tags whose data is 4 bytes or fewer, which ABIF stores INLINE in the
 *     offset field. Dereferencing one as an offset reads far past the end of
 *     the file. FWO_ is always inline; the *tiny* fixture exists so that a tag
 *     the parser actually reads (PBAS, PCON) is inline too, which is the only
 *     way to pin that fix.
 *   - DATA 9/10/11/12 in the G/A/T/C order that FWO_ declares.
 *
 *   node test/fixtures/make-synthetic-ab1.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PER_BASE = 6; // scan points per base
const PEAK = 1200;

/* --------------------------------------------------------------- encoding -- */

const CHAR = 2;
const SHORT = 4;

const bytesOf = (s) => Buffer.from(s, 'latin1');
const shortsOf = (arr) => {
  const b = Buffer.alloc(arr.length * 2);
  arr.forEach((v, i) => b.writeInt16BE(v, i * 2));
  return b;
};
const numbersOf = (arr) => Buffer.from(arr.map((v) => v & 0xff));

function build(bases, fileName) {
  const traces = { A: [], C: [], G: [], T: [] };
  const basePos = [];
  for (let i = 0; i < bases.length; i++) {
    const called = bases[i];
    basePos.push(i * PER_BASE + Math.floor(PER_BASE / 2));
    for (let s = 0; s < PER_BASE; s++) {
      // A triangular peak centred on the base position, near-zero elsewhere.
      const d = Math.abs(s - PER_BASE / 2);
      const h = Math.max(0, Math.round(PEAK * (1 - d / (PER_BASE / 2))));
      for (const b of 'ACGT') traces[b].push(b === called ? h : Math.round(h * 0.02));
    }
  }
  // Low-quality ends, so the trimming path has something to bite on.
  const quality = bases.split('').map((_, i) => (i < 3 || i > bases.length - 4 ? 12 : 47));

  /*
   * FWO_ declares which DATA channel holds which base. "GATC" means DATA9=G,
   * DATA10=A, DATA11=T, DATA12=C -- the order the parser assumes.
   */
  const entries = [
    { name: 'DATA', num: 9, type: SHORT, size: 2, data: shortsOf(traces.G) },
    { name: 'DATA', num: 10, type: SHORT, size: 2, data: shortsOf(traces.A) },
    { name: 'DATA', num: 11, type: SHORT, size: 2, data: shortsOf(traces.T) },
    { name: 'DATA', num: 12, type: SHORT, size: 2, data: shortsOf(traces.C) },
    { name: 'FWO_', num: 1, type: CHAR, size: 1, data: bytesOf('GATC') },
    { name: 'PBAS', num: 1, type: CHAR, size: 1, data: bytesOf(bases) },
    { name: 'PLOC', num: 1, type: SHORT, size: 2, data: shortsOf(basePos) },
    { name: 'PCON', num: 1, type: CHAR, size: 1, data: numbersOf(quality) }
  ];

  const HEADER = 128; // data starts here; the directory goes at the end
  let cursor = HEADER;
  const blocks = [];
  for (const e of entries) {
    // <= 4 bytes lives in the offset field itself, not in the file body.
    if (e.data.length <= 4) e.inline = true;
    else {
      e.offset = cursor;
      blocks.push(e.data);
      cursor += e.data.length;
    }
  }

  const dirLocation = cursor;
  const dir = Buffer.alloc(entries.length * 28);
  entries.forEach((e, i) => {
    const o = i * 28;
    bytesOf(e.name).copy(dir, o);
    dir.writeInt32BE(e.num, o + 4);
    dir.writeInt16BE(e.type, o + 8);
    dir.writeInt16BE(e.size, o + 10);
    dir.writeInt32BE(Math.floor(e.data.length / e.size), o + 12); // numelements
    dir.writeInt32BE(e.data.length, o + 16);                      // datasize
    if (e.inline) e.data.copy(dir, o + 20);
    else dir.writeInt32BE(e.offset, o + 20);
  });

  const head = Buffer.alloc(HEADER);
  bytesOf('ABIF').copy(head, 0);
  head.writeInt16BE(101, 4);
  bytesOf('tdir').copy(head, 6);
  head.writeInt32BE(1, 10);
  head.writeInt16BE(1023, 14);
  head.writeInt16BE(28, 16);
  head.writeInt32BE(entries.length, 18);       // read back from offset 18
  head.writeInt32BE(entries.length * 28, 22);
  head.writeInt32BE(dirLocation, 26);          // read back from offset 26

  const out = path.join(HERE, fileName);
  fs.writeFileSync(out, Buffer.concat([head, ...blocks, dir]));
  const inline = entries.filter((e) => e.inline).map((e) => e.name + e.num);
  console.log(`wrote ${out} — ${bases.length} bases, inline tags: ${inline.join(', ')}`);
}

build('ACGTACGTAAGGCCTTACGTTGCATTAGCA', 'synthetic-trace.ab1');
// Four bases makes PBAS and PCON exactly 4 bytes, so the tags the parser
// actually reads are stored inline -- the only way to pin that fix.
build('ACGT', 'synthetic-trace-tiny.ab1');
