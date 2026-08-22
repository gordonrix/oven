/*
 * The primer cart: primers accumulated across plasmid files, grouped into
 * named sessions.
 *
 * Sessions exist so the cart maps onto how cloning actually works -- one batch
 * of primers per design round, ordered together, then done. Without them a
 * single cart grows without bound and you end up re-reading a year of history
 * every time you want this week's ten oligos. Starting a new session parks the
 * old one rather than deleting it, so previous orders stay available.
 *
 * Backed by globalState rather than workspaceState: the whole point is to span
 * files, the plasmid library usually is not the open workspace, and custom
 * editors are routinely opened with no folder open at all -- in which case
 * workspaceState quietly becomes a per-window scratch store and the cart
 * appears to have vanished.
 */
'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const { tmForPrimer } = require('./tm');
const { normalizeSeqKey } = require('../media/cartShared');

const LEGACY_ITEMS_KEY = 'oven.items';
const SESSIONS_KEY = 'oven.sessions';
const ACTIVE_KEY = 'oven.activeSessionId';
const SCHEMA_VERSION = 1;
const DEFAULT_SESSION_ID = 'cart-default';

class CartStore {
  constructor(context) {
    this.context = context;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
    context.globalState.setKeysForSync([LEGACY_ITEMS_KEY, SESSIONS_KEY, ACTIVE_KEY]);
  }

  /* ---------------------------------------------------------- sessions -- */

  /**
   * All sessions, newest first, migrating the pre-sessions flat list on first
   * read so nobody loses a cart across the upgrade.
   */
  sessions() {
    let raw = this.context.globalState.get(SESSIONS_KEY, null);

    if (!Array.isArray(raw)) {
      // Pre-sessions layout: a single flat oven.items list. Surface it as
      // one session, written back on the next mutation so reads stay pure.
      //
      // The id must be a constant, not a fresh one per call: sessions() is
      // re-entered by activeSessionId() and activeSession(), and a random id
      // each time meant the lookup never matched and the migrated cart read
      // back as empty.
      const legacy = this.context.globalState.get(LEGACY_ITEMS_KEY, []);
      const items = Array.isArray(legacy) ? legacy : [];
      raw = [{
        id: DEFAULT_SESSION_ID,
        name: 'Cart',
        createdAt: (items[0] && items[0].addedAt) || new Date(0).toISOString(),
        items
      }];
    }

    return raw
      .filter((s) => s && s.id && Array.isArray(s.items))
      .map((s) => Object.assign({}, s, {
        items: s.items.filter((it) => it && it.schemaVersion === SCHEMA_VERSION && it.sequence)
      }));
  }

  activeSessionId() {
    const all = this.sessions();
    const wanted = this.context.globalState.get(ACTIVE_KEY, null);
    if (wanted && all.some((s) => s.id === wanted)) return wanted;
    return all.length ? all[0].id : null;
  }

  activeSession() {
    const id = this.activeSessionId();
    return this.sessions().find((s) => s.id === id) || makeSession('Cart', []);
  }

  async _writeSessions(sessions, activeId) {
    await this.context.globalState.update(SESSIONS_KEY, sessions);
    if (activeId !== undefined) await this.context.globalState.update(ACTIVE_KEY, activeId);
    // The legacy key is now redundant; drop it so it cannot resurrect later.
    if (this.context.globalState.get(LEGACY_ITEMS_KEY, null) !== null) {
      await this.context.globalState.update(LEGACY_ITEMS_KEY, undefined);
    }
    this._onDidChange.fire();
  }

  /** Start a fresh empty session and make it active. The old one is kept. */
  async newSession(name) {
    const sessions = this.sessions();
    const session = makeSession(name || defaultSessionName(sessions), []);
    sessions.unshift(session);
    await this._writeSessions(sessions, session.id);
    return session;
  }

  async switchSession(id) {
    if (!this.sessions().some((s) => s.id === id)) return false;
    await this.context.globalState.update(ACTIVE_KEY, id);
    this._onDidChange.fire();
    return true;
  }

  async renameSession(id, name) {
    const sessions = this.sessions();
    const s = sessions.find((x) => x.id === id);
    if (!s) return false;
    s.name = String(name || '').trim() || s.name;
    await this._writeSessions(sessions);
    return true;
  }

  /** Deleting the last remaining session leaves one empty session behind. */
  async deleteSession(id) {
    let sessions = this.sessions().filter((s) => s.id !== id);
    let active = this.activeSessionId();
    if (!sessions.length) sessions = [makeSession('Cart', [])];
    if (active === id) active = sessions[0].id;
    await this._writeSessions(sessions, active);
    return true;
  }

  /* ------------------------------------------------------------- items -- */

  /** Items in the active session, oldest first. */
  items() {
    return this.activeSession().items;
  }

  async _writeActiveItems(items) {
    const sessions = this.sessions();
    const id = this.activeSessionId();
    const target = sessions.find((s) => s.id === id) || sessions[0];
    if (!target) return;
    target.items = items;
    await this._writeSessions(sessions);
  }

  /**
   * Add primers to the active session, skipping any whose sequence is already
   * there.
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
            existing.alsoFoundIn.push({ sourcePath: entry.sourcePath, sourceName: entry.sourceName });
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

    if (added || refused || touchedExisting) await this._writeActiveItems(items);
    return { added, duplicates, refused, limit: maxItems };
  }

  async remove(ids) {
    const drop = new Set(ids || []);
    if (!drop.size) return 0;
    const items = this.items();
    const kept = items.filter((it) => !drop.has(it.id));
    if (kept.length === items.length) return 0;
    await this._writeActiveItems(kept);
    return items.length - kept.length;
  }

  async clear() {
    await this._writeActiveItems([]);
  }

  async rename(id, name) {
    const items = this.items();
    const item = items.find((it) => it.id === id);
    if (!item) return false;
    item.name = String(name || '').trim() || item.name;
    await this._writeActiveItems(items);
    return true;
  }

  async setNote(id, note) {
    const items = this.items();
    const item = items.find((it) => it.id === id);
    if (!item) return false;
    item.note = String(note || '');
    await this._writeActiveItems(items);
    return true;
  }

  /** Sequence keys in the active session, for dimming rows in the editor picker. */
  keys() {
    return this.items().map((it) => normalizeSeqKey(it.sequence));
  }
}

function makeId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function makeSession(name, items) {
  return { id: makeId(), name, createdAt: new Date().toISOString(), items: items || [] };
}

function defaultSessionName(existing) {
  const stamp = new Date().toISOString().slice(0, 10);
  const sameDay = (existing || []).filter((s) => String(s.name).startsWith(stamp)).length;
  return sameDay ? `${stamp} (${sameDay + 1})` : stamp;
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

module.exports = { CartStore, SESSIONS_KEY, ACTIVE_KEY, LEGACY_ITEMS_KEY, SCHEMA_VERSION, DEFAULT_SESSION_ID };
