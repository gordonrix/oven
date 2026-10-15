/*
 * The files the README screenshots are taken of.
 *
 * All synthetic. The repo is public, and a screenshot of a real construct, a
 * real primer list or a real read publishes it as surely as committing the file
 * would. Everything here comes from a seeded generator, so a rerun draws the
 * same pictures and a diff of images/ means OVEN changed, not the data.
 *
 * What is in it, and which shot needs it:
 *   demo-plasmid.gb   a 5 kb circular map with two CDSs, a promoter, terminator
 *                     and origin, and two primers (overview, cart, codon table)
 *   primers.csv       an inventory, a dozen of which bind the plasmid, some
 *                     with 5' tails (overview: Primer Search)
 *   reads/*.ab1       three Sanger reads over demoA: two clean, one carrying a
 *                     substitution that changes an amino acid (alignment)
 *   maps/*.gb         a folder of related maps for Sequence Search to find
 *                     a stretch of demoA in, exactly or nearly
 *   demoA.faa,        demoA's protein, and variants of it: substitutions, a
 *   demoA-variants.faa   truncation, a deletion (protein alignment)
 */
import fs from 'fs';
import path from 'path';
import { encodeAbif } from '../../test/fixtures/abif.mjs';

/* ---------------------------------------------------------------- random -- */

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

const pick = (r, list) => list[Math.floor(r() * list.length)];
const randomBases = (r, n) => Array.from({ length: n }, () => pick(r, 'ACGT')).join('');

/* -------------------------------------------------------------- sequence -- */

const COMPLEMENT = { A: 'T', C: 'G', G: 'C', T: 'A' };
const revComp = (s) => [...s].reverse().map((c) => COMPLEMENT[c]).join('');

const CODE = {
  TTT: 'F', TTC: 'F', TTA: 'L', TTG: 'L', CTT: 'L', CTC: 'L', CTA: 'L', CTG: 'L',
  ATT: 'I', ATC: 'I', ATA: 'I', ATG: 'M', GTT: 'V', GTC: 'V', GTA: 'V', GTG: 'V',
  TCT: 'S', TCC: 'S', TCA: 'S', TCG: 'S', CCT: 'P', CCC: 'P', CCA: 'P', CCG: 'P',
  ACT: 'T', ACC: 'T', ACA: 'T', ACG: 'T', GCT: 'A', GCC: 'A', GCA: 'A', GCG: 'A',
  TAT: 'Y', TAC: 'Y', TAA: '*', TAG: '*', CAT: 'H', CAC: 'H', CAA: 'Q', CAG: 'Q',
  AAT: 'N', AAC: 'N', AAA: 'K', AAG: 'K', GAT: 'D', GAC: 'D', GAA: 'E', GAG: 'E',
  TGT: 'C', TGC: 'C', TGA: '*', TGG: 'W', CGT: 'R', CGC: 'R', CGA: 'R', CGG: 'R',
  AGT: 'S', AGC: 'S', AGA: 'R', AGG: 'R', GGT: 'G', GGC: 'G', GGA: 'G', GGG: 'G'
};
const SENSE = Object.keys(CODE).filter((c) => CODE[c] !== '*');

const translate = (dna) => {
  let out = '';
  for (let i = 0; i + 3 <= dna.length; i += 3) out += CODE[dna.slice(i, i + 3)];
  return out;
};

/** An open reading frame of `codons` codons, start and stop included. */
const orf = (r, codons) =>
  'ATG' + Array.from({ length: codons - 2 }, () => pick(r, SENSE)).join('') + 'TAA';

/* -------------------------------------------------------------- the map -- */

const LENGTH = 5000;

/*
 * 1-based, inclusive, as GenBank writes them. demoA is the gene everything
 * else looks at: the reads cover it, Sequence Search looks for a piece of it,
 * and its protein is the protein-alignment reference.
 */
const LAYOUT = {
  promoter: [101, 170],
  rbs: [181, 192],
  demoA: [201, 1100],        // 300 codons
  terminator: [1131, 1200],
  selR: [1601, 2392],        // 264 codons, on the reverse strand
  ori: [2801, 3389]
};

/** Where in demoA the mutant read differs, as a codon number from 1. */
const MUTANT_CODON = 112;

function buildPlasmid() {
  const r = rng(20261012);
  const seq = randomBases(r, LENGTH).split('');
  const put = ([start], bases) => { for (let i = 0; i < bases.length; i++) seq[start - 1 + i] = bases[i]; };
  put(LAYOUT.demoA, orf(r, 300));
  put(LAYOUT.selR, revComp(orf(r, 264)));
  put(LAYOUT.rbs, 'AAGGAGGTATAC');
  return seq.join('');
}

/* Primers on the map itself, which the cart picker offers. */
const MAP_PRIMERS = [
  { name: 'demoA-F', start: 181, end: 200, forward: true },
  { name: 'demoA-R', start: 1081, end: 1100, forward: false }
];

function bindingSite(plasmid, { start, end, forward }) {
  const site = plasmid.slice(start - 1, end);
  return forward ? site : revComp(site);
}

/* ------------------------------------------------------------- GenBank -- */

function genbank(name, sequence, features, { circular = true, definition = '' } = {}) {
  const date = '12-OCT-2026';
  const lines = [
    `LOCUS       ${name.padEnd(16)} ${String(sequence.length).padStart(11)} bp    DNA     ${circular ? 'circular' : 'linear  '} SYN ${date}`,
    `DEFINITION  ${definition || 'Synthetic map for the OVEN screenshots. Not a real construct.'}`,
    'FEATURES             Location/Qualifiers'
  ];
  for (const f of features) {
    const loc = f.forward === false ? `complement(${f.start}..${f.end})` : `${f.start}..${f.end}`;
    lines.push(`     ${f.type.padEnd(16)}${loc}`);
    lines.push(`                     /label="${f.name}"`);
    if (f.color) {
      lines.push(`                     /ApEinfo_fwdcolor="${f.color}"`);
      lines.push(`                     /ApEinfo_revcolor="${f.color}"`);
    }
    for (const [k, v] of Object.entries(f.qualifiers || {})) lines.push(`                     /${k}="${v}"`);
  }
  lines.push('ORIGIN');
  const lower = sequence.toLowerCase();
  for (let i = 0; i < lower.length; i += 60) {
    const groups = lower.slice(i, i + 60).match(/.{1,10}/g).join(' ');
    lines.push(`${String(i + 1).padStart(9)} ${groups}`);
  }
  lines.push('//', '');
  return lines.join('\n');
}

function plasmidFeatures(plasmid) {
  const f = (type, name, [start, end], color, extra = {}) => ({ type, name, start, end, color, ...extra });
  return [
    f('promoter', 'P_demo', LAYOUT.promoter, '#31B440'),
    f('RBS', 'RBS', LAYOUT.rbs, '#FFD966'),
    f('CDS', 'demoA', LAYOUT.demoA, '#4A90D9',
      { qualifiers: { translation: translate(plasmid.slice(LAYOUT.demoA[0] - 1, LAYOUT.demoA[1])).replace(/\*$/, '') } }),
    f('terminator', 'T_demo', LAYOUT.terminator, '#B0B0B0'),
    f('CDS', 'selR', LAYOUT.selR, '#E8743B', { forward: false }),
    f('rep_origin', 'ori', LAYOUT.ori, '#F2C14E'),
    ...MAP_PRIMERS.map((p) => ({
      type: 'primer_bind', name: p.name, start: p.start, end: p.end, forward: p.forward,
      color: p.forward ? '#85dae9' : '#f58a5e',
      qualifiers: { Sequence: bindingSite(plasmid, p) }
    }))
  ];
}

/* ------------------------------------------------------------ inventory -- */

/*
 * Some bind demo-plasmid, some of those with a 5' tail, and the rest bind
 * nothing, as most of a real collection binds any one plasmid.
 */
function inventory(plasmid) {
  const r = rng(77);
  const rows = [['Name', 'Sequence', 'Alias']];
  let n = 1;
  const id = () => `P_${String(n++).padStart(4, '0')}`;
  const binders = [
    [120, 22, true, 0, 'promoter screen'], [205, 20, true, 18, 'gibson demoA'], [260, 24, true, 0, ''],
    [410, 21, false, 0, 'demoA seq'], [655, 23, true, 12, 'mutagenesis'], [790, 20, false, 0, ''],
    [1015, 22, false, 20, 'gibson demoA'], [1150, 19, true, 0, 'term check'], [1700, 22, false, 0, 'selR seq'],
    [2950, 20, true, 0, 'ori fwd'], [3300, 21, false, 15, ''], [4400, 22, true, 0, '']
  ];
  for (const [start, len, forward, tail, alias] of binders) {
    const site = plasmid.slice(start - 1, start - 1 + len);
    const seq = (tail ? randomBases(r, tail) : '') + (forward ? site : revComp(site));
    rows.push([id(), seq, alias]);
  }
  for (let i = 0; i < 40; i++) rows.push([id(), randomBases(r, 18 + Math.floor(r() * 10)), '']);
  return rows.map((row) => row.join(',')).join('\n') + '\n';
}

/* ---------------------------------------------------------------- reads -- */

const SCANS_PER_BASE = 12;

/**
 * A Sanger read that looks like one: Gaussian peaks of uneven height, a
 * little baseline, low quality at both ends, and the first and last few
 * dozen bases noisier, as a real run's are.
 */
function sangerRead(bases, seed) {
  const r = rng(seed);
  const n = bases.length;
  const scans = n * SCANS_PER_BASE + SCANS_PER_BASE;
  const traces = { A: new Array(scans).fill(0), C: new Array(scans).fill(0), G: new Array(scans).fill(0), T: new Array(scans).fill(0) };
  const basePos = [];
  const quality = [];
  const SIGMA = 2.4;
  for (let i = 0; i < n; i++) {
    const centre = i * SCANS_PER_BASE + SCANS_PER_BASE / 2 + Math.round((r() - 0.5) * 2);
    basePos.push(centre);
    const edge = Math.min(i, n - 1 - i);
    const clean = Math.min(1, edge / 40);
    const height = (500 + r() * 900) * (0.45 + 0.55 * clean);
    quality.push(Math.round(edge < 12 ? 6 + r() * 10 : 18 + clean * (30 + r() * 15)));
    for (let s = -8; s <= 8; s++) {
      const x = centre + s;
      if (x < 0 || x >= scans) continue;
      const g = Math.exp(-(s * s) / (2 * SIGMA * SIGMA));
      traces[bases[i]][x] += height * g;
      // Noise peaks under the called one, larger where quality is low.
      for (const b of 'ACGT') if (b !== bases[i]) traces[b][x] += height * g * (0.03 + (1 - clean) * 0.25 * r());
    }
  }
  for (const b of 'ACGT') traces[b] = traces[b].map((v) => Math.round(v + 10 + r() * 25));
  return encodeAbif({ bases, traces, basePos, quality }).bytes;
}

function reads(plasmid) {
  const region = (start, end) => plasmid.slice(start - 1, end);
  const clean = region(150, 950);
  // The mutant: one base changed in demoA codon MUTANT_CODON, to a codon for
  // a different amino acid, so the alignment draws the new residue.
  const codonStart = LAYOUT.demoA[0] - 1 + (MUTANT_CODON - 1) * 3;   // 0-based in the plasmid
  const codon = plasmid.slice(codonStart, codonStart + 3);
  const changed = ['A', 'C', 'G', 'T'].map((b) => b + codon.slice(1))
    .find((c) => c !== codon && CODE[c] !== '*' && CODE[c] !== CODE[codon]);
  const mutantPlasmid = plasmid.slice(0, codonStart) + changed + plasmid.slice(codonStart + 3);
  const mutant = mutantPlasmid.slice(150 - 1, 950);
  return {
    'clone1_F.ab1': sangerRead(clean, 1),
    'clone2_F.ab1': sangerRead(mutant, 2),
    'clone3_R.ab1': sangerRead(revComp(region(420, 1180)), 3)
  };
}

/* ---------------------------------------------------- sequence search -- */

/*
 * A folder of maps. Some carry demoA, so the search for a piece of it finds
 * them; one carries it with two bases changed, which only Fuzzy finds.
 */
function searchMaps(plasmid) {
  const r = rng(4242);
  const demoA = plasmid.slice(LAYOUT.demoA[0] - 1, LAYOUT.demoA[1]);
  const maps = {};
  const withInsert = (name, insert, len) => {
    const backbone = randomBases(r, len);
    const at = 300 + Math.floor(r() * (len - insert.length - 600));
    maps[name] = genbank(name, backbone.slice(0, at) + insert + backbone.slice(at + insert.length), [
      { type: 'CDS', name: name.includes('rev') ? 'demoA (rev)' : 'demoA', start: at + 1, end: at + insert.length, color: '#4A90D9' }
    ]);
  };
  const mutate = (s, positions) => [...s].map((c, i) => (positions.includes(i) ? (c === 'A' ? 'G' : 'A') : c)).join('');
  withInsert('pDemo-01', demoA, 4200);
  withInsert('pDemo-02', demoA, 6100);
  withInsert('pDemo-03', mutate(demoA, [SEARCH_QUERY_AT + 7, SEARCH_QUERY_AT + 21]), 5300);
  withInsert('pDemo-04-rev', revComp(demoA), 3900);
  for (let i = 5; i <= 9; i++) {
    const name = `pDemo-0${i}`;
    maps[name] = genbank(name, randomBases(r, 3000 + Math.floor(r() * 4000)), []);
  }
  return maps;
}

/** The Sequence Search query: 36 bases from inside demoA. */
const SEARCH_QUERY_AT = 450;   // offset into demoA
export function searchQuery(plasmid) {
  const at = LAYOUT.demoA[0] - 1 + SEARCH_QUERY_AT;
  return plasmid.slice(at, at + 36);
}

/* -------------------------------------------------------------- protein -- */

function proteins(plasmid) {
  const r = rng(99);
  const demoA = translate(plasmid.slice(LAYOUT.demoA[0] - 1, LAYOUT.demoA[1])).replace(/\*$/, '');
  const AA = 'ACDEFGHIKLMNPQRSTVWY';
  const substitute = (p, count) => {
    const out = p.split('');
    for (let i = 0; i < count; i++) {
      const at = 5 + Math.floor(r() * (p.length - 10));
      out[at] = pick(r, AA.replace(out[at], ''));
    }
    return out.join('');
  };
  const wrap = (s) => s.match(/.{1,60}/g).join('\n');
  const record = (name, seq) => `>${name}\n${wrap(seq)}\n`;
  return {
    'demoA.faa': record('demoA', demoA),
    'demoA-variants.faa': [
      record('demoA_v1', substitute(demoA, 3)),
      record('demoA_v2', demoA.slice(0, 120) + demoA.slice(126)),
      record('demoA_N-term', demoA.slice(0, 150)),
      record('demoA_v3', substitute(demoA, 12))
    ].join('')
  };
}

/* ------------------------------------------------------------------ all -- */

/**
 * Write every fixture under `dir`.
 * @returns what the scenes need to know about them
 */
export function writeFixtures(dir) {
  const plasmid = buildPlasmid();
  const write = (rel, data) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
    return p;
  };
  const files = {
    plasmid: write('demo-plasmid.gb', genbank('demo-plasmid', plasmid, plasmidFeatures(plasmid))),
    inventory: write('primers.csv', inventory(plasmid)),
    reads: Object.entries(reads(plasmid)).map(([name, bytes]) => write(path.join('reads', name), bytes)),
    maps: path.join(dir, 'maps'),
    protein: null,
    proteinReads: null
  };
  for (const [name, text] of Object.entries(searchMaps(plasmid))) write(path.join('maps', `${name}.gb`), text);
  const prot = proteins(plasmid);
  files.protein = write('demoA.faa', prot['demoA.faa']);
  files.proteinReads = write('demoA-variants.faa', prot['demoA-variants.faa']);
  return {
    files,
    plasmid,
    layout: LAYOUT,
    mutantBase: LAYOUT.demoA[0] - 1 + (MUTANT_CODON - 1) * 3,
    searchQuery: searchQuery(plasmid)
  };
}
