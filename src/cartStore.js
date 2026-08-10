/*
 * The primer cart: a list of primers accumulated across plasmid files.
 *
 * Backed by globalState rather than workspaceState. The whole point of the
 * cart is to span files, the plasmid library usually is not the open
 * workspace, and custom editors are routinely opened with no folder open at
 * all -- in which case workspaceState quietly becomes a per-window scratch
 * store and the cart appears to have vanished.
 */
'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const { tmForPrimer } = require('./tm');
const { normalizeSeqKey } = require('../media/cartShared');

const STORAGE_KEY = 'oveCart.items';
const SCHEMA_VERSION = 1;

class CartStore {
  constructor(context) {
    this.context = context;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
    context.globalState.setKeysForSync([STORAGE_KEY]);
  }

  /** @returns {Array<object>} cart items, oldest first */
  items() {
    const raw = this.context.globalState.get(STORAGE_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter((it) => it && it.schemaVersion === SCHEMA_VERSION && it.sequence);
  }

  async _write(items) {
    await this.context.globalState.update(STORAGE_KEY, items);
    this._onDidChange.fire(items);
  }

  /**
   * Add primers, skipping any whose sequence is already carted.
   *
   * Dedupe is on sequence alone: the same oligo annotated in three plasmids is
   * still one line on an order form. The extra provenance is not thrown away
   * though -- it is appended to the existing item's alsoFoundIn list.
   *
   * @returns {{added:number, duplicates:number, refused:number, limit:number}}
   */
  async add(entries, maxItems) {
    const items = this.items();
    const bySeq = new Map(items.map((it) => [normalizeSeqKey(it.sequence), it]));

    let added = 0;
    let duplicates = 0;
    let refused = 0;
    let touchedExisting = false;

    for (const entry of entries || []) {
      const sequence = String(entry.sequence || '').replace(/\s+/g, '').toUpperCase();
      if (!sequence) continue;

      const key = normalizeSeqKey(sequence);
      const existing = bySeq.get(key);
      if (existing) {
        duplicates++;
        if (entry.sourcePath && entry.sourcePath !== existing.sourcePath) {
          existing.alsoFoundIn = existing.alsoFoundIn || [];
          if (!existing.alsoFoundIn.some((s) => s.sourcePath === entry.sourcePath)) {
            existing.alsoFoundIn.push({
              sourcePath: entry.sourcePath,
              sourceName: entry.sourceName
            });
            touchedExisting = true;
          }
        }
        continue;
      }

      if (items.length >= maxItems) {
        refused++;
        continue;
      }

      const item = makeItem(entry, sequence);
      items.push(item);
      bySeq.set(key, item);
      added++;
    }

    if (added || refused || touchedExisting) await this._write(items);
    return { added, duplicates, refused, limit: maxItems };
  }

  async remove(ids) {
    const drop = new Set(ids || []);
    if (!drop.size) return 0;
    const items = this.items();
    const kept = items.filter((it) => !drop.has(it.id));
    if (kept.length === items.length) return 0;
    await this._write(kept);
    return items.length - kept.length;
  }

  async clear() {
    await this._write([]);
  }

  async rename(id, name) {
    const items = this.items();
    const item = items.find((it) => it.id === id);
    if (!item) return false;
    item.name = String(name || '').trim() || item.name;
    await this._write(items);
    return true;
  }

  async setNote(id, note) {
    const items = this.items();
    const item = items.find((it) => it.id === id);
    if (!item) return false;
    item.note = String(note || '');
    await this._write(items);
    return true;
  }

  /** Sequence keys currently in the cart, for dimming rows in the editor picker. */
  keys() {
    return this.items().map((it) => normalizeSeqKey(it.sequence));
  }
}

function makeId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function makeItem(entry, sequence) {
  const { tm, tmSource } = tmForPrimer(sequence, entry.notes);
  return {
    id: makeId(),
    schemaVersion: SCHEMA_VERSION,
    name: String(entry.name || 'unnamed primer').trim(),
    sequence,
    length: sequence.length,
    tm: tm === null ? null : Math.round(tm * 10) / 10,
    tmSource,
    sourcePath: entry.sourcePath || '',
    sourceName: entry.sourceName || '',
    start: typeof entry.start === 'number' ? entry.start : null,
    end: typeof entry.end === 'number' ? entry.end : null,
    strand: entry.strand === -1 ? -1 : 1,
    circularWrap: Boolean(entry.circularWrap),
    origin: entry.origin || 'existing',
    note: '',
    addedAt: new Date().toISOString()
  };
}

module.exports = { CartStore, STORAGE_KEY, SCHEMA_VERSION };
