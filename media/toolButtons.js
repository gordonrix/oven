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

  window.OveToolButtons = { place };
})();
