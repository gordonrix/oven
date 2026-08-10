/*
 * Generates test/fixtures/synthetic-plasmid.gb.
 *
 * The tests need a GenBank file, not a real plasmid: they check that a primer's
 * sequence can be reconstructed from its coordinates, and they give the OVE
 * bundle something realistic to render. Using an actual lab construct would put
 * an unpublished design in a public repo for no test benefit, and a synthetic
 * one is arguably better -- the awkward cases are here on purpose rather than
 * by luck.
 *
 * Deliberately included, because each is something that has broken this code:
 *   - lowercase ORIGIN, so anything that forgets to uppercase is caught
 *   - primer_bind features carrying /Sequence, the independent statement of
 *     truth that deriveBases is checked against
 *   - forward and reverse primers, since the 3' end sits at opposite edges
 *   - a primer written with a lowercase 5' tail and uppercase annealing region
 *   - an origin-spanning feature, expressed as join(...)
 *   - ApE colour qualifiers, which the extension reads for feature colours
 *
 *   node test/fixtures/make-synthetic-plasmid.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LENGTH = 6537; // same size as the construct this replaced, so timings compare

/** mulberry32: deterministic, and without the short low-bit period of an LCG. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(20260811);
const BASES = 'acgt';
let seq = '';
for (let i = 0; i < LENGTH; i++) seq += BASES[Math.floor(rand() * 4)];

const revComp = (s) =>
  s.split('').reverse().map((c) => ({ a: 't', c: 'g', g: 'c', t: 'a' }[c.toLowerCase()] || 'n')).join('');

const up = (s) => s.toUpperCase();

/* --------------------------------------------------------------- features -- */

const features = [
  { type: 'misc_feature', start: 200, end: 940, strand: 1, label: 'synthetic ori',
    fwd: '#9ACD32', rev: '#9ACD32' },
  { type: 'CDS', start: 1200, end: 1859, strand: 1, label: 'synthetic marker',
    fwd: '#FFB300', rev: '#FFB300' },
  { type: 'promoter', start: 2100, end: 2149, strand: 1, label: 'synthetic promoter',
    fwd: '#31B440', rev: '#31B440' },
  { type: 'terminator', start: 3000, end: 3099, strand: -1, label: 'synthetic terminator',
    fwd: '#B0B0B0', rev: '#B0B0B0' },
  // Spans the origin, so the join(...) path is exercised on every parse.
  { type: 'misc_feature', start: 6500, end: 60, strand: 1, label: 'origin-spanning region',
    fwd: '#FF66CC', rev: '#FF66CC', wraps: true }
];

/*
 * Three primers, matching what the harnesses expect: a clean forward, a
 * reverse, and one whose 5' tail is absent from the template. Two state their
 * sequence in a /Sequence qualifier, which is what primers.test.js checks
 * derivation against.
 */
const primers = [
  { start: 24, end: 42, strand: -1, label: 'SYN-rev-primer',
    sequence: up(revComp(seq.slice(24, 43))), colour: '#ffef86' },
  { start: 4594, end: 4613, strand: 1, label: 'SYN-fwd-primer',
    sequence: up(seq.slice(4594, 4614)), colour: '#85dae9' },
  // Lowercase tail / uppercase annealing region, the convention used in the
  // reference inventory -- and one the matcher deliberately does not rely on.
  { start: 5200, end: 5224, strand: 1, label: 'SYN-tailed-primer',
    note: `sequence: ggggccccttttaaaa${up(seq.slice(5200, 5225))}`, colour: '#f58a5e' }
];

/* ------------------------------------------------------------------ emit -- */

function location(f) {
  const one = (a, b) => `${a + 1}..${b + 1}`;
  const loc = f.wraps ? `join(${one(f.start, LENGTH - 1)},${one(0, f.end)})` : one(f.start, f.end);
  return f.strand === -1 ? `complement(${loc})` : loc;
}

const lines = [
  `LOCUS       synthetic_plasmid       ${LENGTH} bp ds-DNA     circular     11-AUG-2026`,
  'DEFINITION  Synthetic test fixture. Not a real construct.',
  'KEYWORDS    "Type:test-fixture" "Generated:make-synthetic-plasmid.mjs"',
  'FEATURES             Location/Qualifiers'
];

const qual = (k, v) => lines.push(`                     /${k}="${v}"`);

for (const f of features) {
  lines.push(`     ${f.type.padEnd(16)}${location(f)}`);
  qual('label', f.label);
  qual('locus_tag', f.label);
  qual('ApEinfo_fwdcolor', f.fwd);
  qual('ApEinfo_revcolor', f.rev);
}
for (const p of primers) {
  lines.push(`     ${'primer_bind'.padEnd(16)}${location(p)}`);
  qual('label', p.label);
  qual('ApEinfo_fwdcolor', p.colour);
  qual('ApEinfo_revcolor', p.colour);
  if (p.sequence) qual('Sequence', p.sequence);
  if (p.note) qual('note', p.note);
}

lines.push('ORIGIN      ');
for (let i = 0; i < LENGTH; i += 60) {
  const chunk = seq.slice(i, i + 60).match(/.{1,10}/g).join(' ');
  lines.push(`${String(i + 1).padStart(9)} ${chunk}`);
}
lines.push('//', '');

const out = path.join(HERE, 'synthetic-plasmid.gb');
fs.writeFileSync(out, lines.join('\n'));
console.log(`wrote ${out} — ${LENGTH} bp, ${features.length} features, ${primers.length} primers`);
