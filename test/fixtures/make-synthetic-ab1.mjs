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
import { encodeAbif } from './abif.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PER_BASE = 6; // scan points per base
const PEAK = 1200;

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

  const { bytes, inline } = encodeAbif({ bases, traces, basePos, quality });
  const out = path.join(HERE, fileName);
  fs.writeFileSync(out, bytes);
  console.log(`wrote ${out} — ${bases.length} bases, inline tags: ${inline.join(', ')}`);
}

build('ACGTACGTAAGGCCTTACGTTGCATTAGCA', 'synthetic-trace.ab1');
// Four bases makes PBAS and PCON exactly 4 bytes, so the tags the parser
// actually reads are stored inline -- the only way to pin that fix.
build('ACGT', 'synthetic-trace-tiny.ab1');
