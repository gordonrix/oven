/*
 * Finding a read's file when nothing said where it was.
 *
 * A read dragged in from Finder arrives as bytes: the webview is handed the
 * file's name and contents, never its path. Such a read was saved with its
 * bases (SEQ) and nothing else, so reopening could not bring its trace back --
 * though the .ab1 was usually sitting a folder or two below the alignment,
 * where the sequencing order had been unpacked.
 *
 * So both ends look. Saving searches below the folder being saved to for a file
 * of that name with the same bytes, and reopening searches below the alignment
 * for one whose sequence fits the saved row. Either way a file is only taken
 * when its contents prove it is the one: a name alone is not enough, since
 * every sequencing order has a 001_A1.
 *
 * The search is breadth first, so the nearest match is tried first, and it is
 * bounded in depth and in entries read, because it may start in a Dropbox
 * folder holding years of experiments.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_DEPTH = 4;
const MAX_ENTRIES = 20000;
const SKIP = new Set(['node_modules', '__pycache__']);

/* The extensions a read's file can have, the one carrying a trace first. */
const READ_EXTENSIONS = ['ab1', 'gb', 'gbk', 'fa', 'fasta', 'faa', 'dna'];

/**
 * Every file below `roots` with one of these names, nearest first.
 *
 * @param {string[]} roots folders to search from; repeats and nesting are fine
 * @param {string[]} names file names, matched without regard to case
 * @returns {Promise<Map<string, string[]>>} lowercased name -> paths
 */
async function findByName(roots, names, opts = {}) {
  const maxDepth = opts.maxDepth === undefined ? MAX_DEPTH : opts.maxDepth;
  const maxEntries = opts.maxEntries || MAX_ENTRIES;
  const wanted = new Set(names.map((n) => String(n).toLowerCase()));
  const found = new Map();
  if (!wanted.size) return found;

  const queue = roots.filter(Boolean).map((dir) => ({ dir: path.resolve(dir), depth: 0 }));
  const visited = new Set();
  let read = 0;
  while (queue.length && read < maxEntries) {
    const { dir, depth } = queue.shift();
    if (visited.has(dir)) continue;
    visited.add(dir);
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // gone, or not ours to read
    }
    for (const entry of entries) {
      if (++read > maxEntries) break;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIP.has(entry.name)) queue.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        const key = entry.name.toLowerCase();
        if (!wanted.has(key)) continue;
        if (!found.has(key)) found.set(key, []);
        found.get(key).push(full);
      }
    }
  }
  return found;
}

/**
 * The file names a saved read may have come from.
 *
 * A read is named after its file, less the extension -- and, for one record
 * of several, with " · <record>" after it -- so the name says what to look for
 * but not which extension. A trace is the reason to look, so .ab1 comes first.
 */
function fileNamesFor(readName) {
  const base = String(readName || '').split(' · ')[0].trim();
  return base ? READ_EXTENSIONS.map((ext) => `${base}.${ext}`) : [];
}

function digest(bytes) {
  return crypto.createHash('sha1').update(bytes).digest('hex');
}

module.exports = { findByName, fileNamesFor, digest, READ_EXTENSIONS };
