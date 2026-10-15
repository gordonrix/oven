/*
 * Undo and redo in the webview's text boxes: Find, the alignment's paste
 * table, the settings form.
 *
 * VS Code takes Cmd+Z away from every webview. Its frame blocks the browser's
 * own undo and runs the workbench's Undo command instead, which hands the key
 * to whoever claims it first. A custom editor claims it ahead of the webview
 * (priority 105 against 100), and asks the document's undo stack -- so in a
 * plasmid or .sto tab the text box never hears of it, and what was pasted into
 * Find stays pasted.
 *
 * So the webview takes the key first. When a text box has focus, Cmd/Ctrl+Z,
 * Cmd/Ctrl+Shift+Z and Ctrl+Y are done here with the browser's own undo, and
 * the key goes no further: not to VS Code, which would otherwise do it a second
 * time in a plain webview panel, and not to OVE's own undo of sequence edits.
 * Anywhere else the key is left alone, and OVE undoes edits to the sequence as
 * before.
 */
(function () {
  'use strict';

  const TEXT_INPUTS = new Set(['text', 'search', 'number', 'email', 'url', 'tel', 'password']);

  /** Somewhere the browser keeps its own undo history for typing. */
  function isTextField(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') return TEXT_INPUTS.has((el.type || 'text').toLowerCase());
    return Boolean(el.isContentEditable);
  }

  /** 'undo', 'redo', or null for any other key. */
  function commandFor(e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
    const key = (e.key || '').toLowerCase();
    if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
    if (key === 'y' && e.ctrlKey && !e.shiftKey) return 'redo';
    return null;
  }

  window.addEventListener('keydown', (e) => {
    const command = commandFor(e);
    if (!command || !isTextField(document.activeElement)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    document.execCommand(command);
  }, true);

  window.OveTextUndo = { isTextField, commandFor };
})();
