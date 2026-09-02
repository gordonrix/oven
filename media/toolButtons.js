/*
 * Right-aligns our button row to OVE's menu bar rather than to the window.
 *
 * "position: fixed" measures from the webview viewport, and OVE's content stops
 * short of it -- there is a gutter down the right-hand side -- so a
 * viewport-anchored row hangs past the toolbar it is supposed to sit in. That
 * is what put Save half over the editor's edge.
 *
 * The menu bar is full-width within OVE, so its right edge is the one to line
 * up with. OVE mounts asynchronously and offers no callback for it, so this
 * waits for the bar to appear and then keeps up with resizes.
 */
(function () {
  'use strict';

  /* Breathing room past the menu bar's edge, matching its own left inset. */
  const EDGE = 12;

  function place() {
    const row = document.querySelector('.ove-toolbtns');
    const bar = document.querySelector('.tg-menu-bar');
    if (!row || !bar) return false;
    const gutter = document.documentElement.clientWidth - bar.getBoundingClientRect().right;
    row.style.right = `${Math.max(0, Math.round(gutter)) + EDGE}px`;
    return true;
  }

  if (!place()) {
    const waiting = new MutationObserver(() => { if (place()) waiting.disconnect(); });
    waiting.observe(document.documentElement, { childList: true, subtree: true });
  }
  window.addEventListener('resize', place);

  /*
   * Hover labels carrying each button's shortcut.
   *
   * The buttons say what they do, so the label earns its place by naming the
   * key -- which is otherwise only discoverable from the right-click menu, and
   * for the cart not at all. A button with no shortcut still gets one, so the
   * row behaves the same way throughout.
   *
   * `title` would do this for free but takes about a second to appear and
   * cannot be styled, which reads as nothing happening.
   */
  const SHORTCUTS = [
    ['ove-search-button', () => window.__ovenSearchPrimersHotkey]
    // Align and the primer cart have no shortcut to show. A label repeating
    // what the button already says is worse than none, so they get nothing
    // until they do.
  ];

  function label() {
    for (const [id, getCombo] of SHORTCUTS) {
      const el = document.getElementById(id);
      if (!el) continue;
      const combo = getCombo();
      // ovenHotkeyLabel comes from the bundle, so this and the right-click menu
      // spell a binding the same way.
      const shortcut = combo && typeof window.ovenHotkeyLabel === 'function'
        ? window.ovenHotkeyLabel(combo)
        : '';
      // The button's own text, so the label cannot drift from it.
      if (shortcut) el.setAttribute('data-tip', `${el.textContent.trim()}  ${shortcut}`);
      else el.removeAttribute('data-tip');
    }
  }

  label();

  window.OveToolButtons = { place, label };
})();
