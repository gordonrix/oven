/*
 * The alignment settings the panel can change, as choices rather than a string.
 *
 * Everything here lives in two ordinary VS Code settings, oven.mafftArgs and
 * oven.alignTrimQuality, which the aligner already reads on every Align. The
 * panel only offers a friendlier way to set them: a MAFFT strategy from a short
 * list, and the two gap penalties, are turned into the one argument string and
 * back. Whatever the string holds that is not one of those -- a strategy typed
 * into settings.json by hand -- is kept, as a custom strategy, rather than
 * thrown away by the round trip.
 *
 * Pure: no vscode, so it is tested on its own.
 */
'use strict';

/*
 * The strategies worth offering, from MAFFT's own manual. Auto picks by the
 * size of the data. L-INS-i is the accurate one for a handful of sequences,
 * and the slowest; FFT-NS-1 is the quick one for large read sets.
 */
const PRESETS = [
  { id: 'auto', label: 'Auto', args: '--auto', note: 'MAFFT picks by the size of the data' },
  {
    id: 'accurate', label: 'Accurate (L-INS-i)', args: '--localpair --maxiterate 1000',
    note: 'most accurate; slow with many reads'
  },
  { id: 'fast', label: 'Fast (FFT-NS-1)', args: '--retree 1', note: 'quickest, for large read sets' }
];

/* MAFFT's own defaults, shown as placeholders so an empty box reads as "default". */
const DEFAULT_GAP_OPEN = 1.53;
const DEFAULT_GAP_EXTEND = 0.0;

const MAX_TRIM_QUALITY = 60;

const tokens = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);

/**
 * Read an oven.mafftArgs string into choices.
 *
 * @returns {{strategy: string, custom: string, gapOpen: number|null, gapExtend: number|null}}
 */
function parseMafftArgs(args) {
  const rest = [];
  let gapOpen = null;
  let gapExtend = null;
  const list = tokens(args);
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const inline = /^--(op|ep)=(.+)$/.exec(t);
    if (inline) {
      if (inline[1] === 'op') gapOpen = Number(inline[2]);
      else gapExtend = Number(inline[2]);
      continue;
    }
    if ((t === '--op' || t === '--ep') && i + 1 < list.length && isFinite(Number(list[i + 1]))) {
      if (t === '--op') gapOpen = Number(list[++i]);
      else gapExtend = Number(list[++i]);
      continue;
    }
    rest.push(t);
  }
  const remaining = rest.join(' ');
  const preset = PRESETS.find((p) => p.args === remaining);
  return {
    strategy: preset ? preset.id : (remaining ? 'custom' : 'auto'),
    custom: preset ? '' : remaining,
    gapOpen: Number.isFinite(gapOpen) ? gapOpen : null,
    gapExtend: Number.isFinite(gapExtend) ? gapExtend : null
  };
}

/** The oven.mafftArgs string for a set of choices. */
function composeMafftArgs({ strategy, custom, gapOpen, gapExtend } = {}) {
  const preset = PRESETS.find((p) => p.id === strategy);
  const parts = [preset ? preset.args : String(custom || '').trim() || '--auto'];
  // Penalties typed into a custom string are the custom string's business;
  // the boxes are only added when they hold something.
  if (gapOpen !== null && gapOpen !== undefined && gapOpen !== '') parts.push('--op', String(Number(gapOpen)));
  if (gapExtend !== null && gapExtend !== undefined && gapExtend !== '') parts.push('--ep', String(Number(gapExtend)));
  return parts.join(' ');
}

/**
 * What is wrong with a set of choices, or null when they can be saved.
 *
 * Checked here rather than left to MAFFT, whose complaint about a bad number
 * arrives only after Align is pressed and reads like an alignment failure.
 */
function validate({ strategy, custom, gapOpen, gapExtend, trimQuality } = {}) {
  if (!PRESETS.some((p) => p.id === strategy) && strategy !== 'custom') return 'Choose a strategy.';
  if (strategy === 'custom') {
    const list = tokens(custom);
    if (!list.length) return 'A custom strategy needs MAFFT arguments.';
    if (list.some((t) => !t.startsWith('-') && !isFinite(Number(t)))) {
      return 'Custom arguments are MAFFT options, like --localpair --maxiterate 1000.';
    }
    // Input and output belong to OVEN; a file name or "-" here would break the run.
    if (list.includes('-') || list.includes('--adjustdirection')) {
      return `OVEN adds ${list.includes('-') ? '"-"' : '--adjustdirection'} itself; leave it out.`;
    }
  }
  for (const [name, v] of [['Gap opening penalty', gapOpen], ['Gap extension penalty', gapExtend]]) {
    if (v === null || v === undefined || v === '') continue;
    if (!isFinite(Number(v)) || Number(v) < 0) return `${name} must be a number, 0 or more.`;
  }
  if (trimQuality !== undefined && trimQuality !== null && trimQuality !== '') {
    const q = Number(trimQuality);
    if (!Number.isInteger(q) || q < 0 || q > MAX_TRIM_QUALITY) {
      return `Trim quality is a whole Phred score from 0 to ${MAX_TRIM_QUALITY}.`;
    }
  }
  return null;
}

module.exports = {
  PRESETS, DEFAULT_GAP_OPEN, DEFAULT_GAP_EXTEND, MAX_TRIM_QUALITY,
  parseMafftArgs, composeMafftArgs, validate
};
