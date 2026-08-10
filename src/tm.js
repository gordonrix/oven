/*
 * NEB Q5 nearest-neighbour melting temperature (SantaLucia 1998).
 *
 * Ported from tm_neb_q5() in the user's gibson_planner.py so the cart reports
 * the same number their primer-design pipeline does. OVE bundles its own
 * calculateTm, but it is not on the UMD export surface -- it is only reachable
 * from inside the webview, and the sidebar renders host-side. Two engines would
 * mean the same oligo showing two different Tms depending on how it was added.
 *
 * Deliberate divergence from the Python: that version raises ValueError on a
 * short or degenerate sequence. Here that would abort a cart add, so these
 * return null instead and the caller renders a blank Tm.
 */
'use strict';

const NN_R = 1.987;

const NN_TERM_DS = { g: -2.8, a: 4.1, t: 4.1, c: -2.8 };
const NN_TERM_DH = { g: 0.1, a: 2.3, t: 2.3, c: 0.1 };

const NN_DS = {
  gg: -19.9, ga: -22.2, gt: -22.4, gc: -27.2,
  ag: -21.0, aa: -22.2, at: -20.4, ac: -22.4,
  tg: -22.7, ta: -21.3, tt: -22.2, tc: -22.2,
  cg: -27.2, ca: -22.7, ct: -21.0, cc: -19.9
};

const NN_DH = {
  gg: -8.0, ga: -8.2, gt: -8.4, gc: -10.6,
  ag: -7.8, aa: -7.9, at: -7.2, ac: -8.4,
  tg: -8.5, ta: -7.2, tt: -7.9, tc: -8.2,
  cg: -10.6, ca: -8.5, ct: -7.8, cc: -8.0
};

// NEB Q5 reaction conditions, matching the Python defaults.
const NA = 0.05;
const MG = 0.0015;
const PRIMER_TOTAL = 2e-7;

/**
 * @returns {number|null} Tm in °C, or null when the sequence is shorter than
 *   two bases or contains anything other than A/C/G/T.
 */
function tmNebQ5(seq, opts) {
  const o = opts || {};
  const na = o.na === undefined ? NA : o.na;
  const mg = o.mg === undefined ? MG : o.mg;
  const primerTotal = o.primerTotal === undefined ? PRIMER_TOTAL : o.primerTotal;

  const s = String(seq || '').trim().toLowerCase();
  if (s.length < 2) return null;
  if (!/^[acgt]+$/.test(s)) return null;

  let ds = 0;
  let dh = 0;

  ds += 0.368 * (s.length - 1) * Math.log(na + mg * 140);
  ds += NN_TERM_DS[s[0]] + NN_TERM_DS[s[s.length - 1]];
  dh += NN_TERM_DH[s[0]] + NN_TERM_DH[s[s.length - 1]];

  for (let i = 0; i < s.length - 1; i++) {
    const pair = s.slice(i, i + 2);
    ds += NN_DS[pair];
    dh += NN_DH[pair];
  }

  return (1000 * dh) / (ds + NN_R * Math.log(primerTotal / 2)) - 273.15;
}

/**
 * Tm for a parsed annotation, preferring a /Tm qualifier already in the file
 * over our own calculation -- the file author's value wins.
 *
 * @returns {{tm: number|null, tmSource: 'notes'|'computed'|null}}
 */
function tmForPrimer(bases, notes) {
  const noteTm = notes && notes.Tm && notes.Tm[0];
  const parsed = typeof noteTm === 'number' ? noteTm : parseFloat(noteTm);
  if (Number.isFinite(parsed)) return { tm: parsed, tmSource: 'notes' };

  const computed = tmNebQ5(bases);
  return computed === null ? { tm: null, tmSource: null } : { tm: computed, tmSource: 'computed' };
}

module.exports = { tmNebQ5, tmForPrimer };
