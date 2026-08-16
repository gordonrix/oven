/*
 * Melting temperature for the extension host.
 *
 * The calculation itself lives in media/cartShared.js because the cart and
 * primer search both need it and it is shared with the webview. This module
 * adds the host-only policy on top: prefer a Tm the file already states over
 * one we compute.
 */
'use strict';

const { nebTm } = require('../media/cartShared');

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

  const computed = nebTm(bases);
  return computed === null ? { tm: null, tmSource: null } : { tm: computed, tmSource: 'computed' };
}

module.exports = { nebTm, tmForPrimer };
