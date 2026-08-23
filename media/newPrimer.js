/*
 * New Primer as a side panel instead of a modal.
 *
 * Open Vector Editor's New Primer is a dialog, which covers the sequence you
 * are designing against -- the same complaint that moved primer search out of
 * a modal, and the same fix: a real tab in OVE's split layout, so the map stays
 * visible while you work.
 *
 * This deliberately does not reimplement the form. The bundle exposes OVE's own
 * primer form with its modal wrapper removed (see the `AddOrEditPrimerPanel`
 * hunk in patches/index.umd.js.patch), so what renders here is the same fields,
 * the same validation, the same upsertPrimer, and the same
 * beforeAnnotationCreate hook the cart listens on. The only things this module
 * owns are the panel, the shortcut, and the right-click entry.
 *
 * The panel machinery is the same shape as primerSearch.js; see the comment at
 * the top of that file for why a React element can be hand-built without React
 * being exported.
 */
(function () {
  'use strict';

  const PANEL_ID = 'newPrimer';
  const PANEL_NAME = 'New Primer';
  const REACT_ELEMENT = Symbol.for('react.element');

  let editor = null;
  // withEditorProps picks its slice of the store by editorName. Without it the
  // form connects to a blank editor state, whose readOnly defaults to true --
  // which renders every field and the Save button disabled, with no hint as to
  // why. Both mount sites use "VectorEditor".
  let editorName = 'VectorEditor';

  function seqState() {
    try {
      return editor.getState() || {};
    } catch (e) {
      console.error('new primer: could not read editor state', e);
      return {};
    }
  }

  /* ------------------------------------------------------------- panel -- */

  function reactElement(type, props) {
    return {
      $$typeof: REACT_ELEMENT,
      type,
      key: (props && props.key) || null,
      ref: (props && props.ref) || null,
      props: Object.assign({}, props),
      _owner: null,
      _store: {}
    };
  }

  /**
   * The panel body: OVE's primer form, plus the one prop wrapDialog would have
   * supplied. Cancel calls hideModal, so it closes the panel rather than
   * leaving an empty tab behind.
   */
  function PanelComponent() {
    const Form = window.oveAddOrEditPrimerPanel;
    if (!Form) {
      return reactElement('div', {
        className: 'ovenp-missing',
        children: 'The primer form is unavailable in this build.'
      });
    }
    return reactElement('div', {
      className: 'ovenp-root',
      children: reactElement(Form, { hideModal: hidePanel, editorName })
    });
  }

  const panelMap = { [PANEL_ID]: { comp: PanelComponent } };

  function showPanel() {
    const groups = (seqState().panelsShown || []).map((g) => (g || []).map((p) => Object.assign({}, p)));

    for (const group of groups) {
      const mine = group.find((p) => p.id === PANEL_ID);
      if (mine) {
        group.forEach((p) => { p.active = p.id === PANEL_ID; });
        editor.updateEditor({ panelsShown: groups });
        return;
      }
    }

    const panel = { id: PANEL_ID, name: PANEL_NAME, active: true };
    if (groups.length <= 1) {
      groups.push([panel]); // split, so the sequence stays beside the form
    } else {
      const target = groups[groups.length - 1];
      target.forEach((p) => { p.active = false; });
      target.push(panel);
    }
    editor.updateEditor({ panelsShown: groups });
  }

  /**
   * Take the panel back off screen.
   *
   * OVE has no close affordance on a panel it did not put there, so this
   * removes it from `panelsShown` -- and drops the group with it if it was the
   * only thing in it, which un-splits the view rather than leaving an empty
   * half beside the sequence.
   */
  function hidePanel() {
    const groups = (seqState().panelsShown || [])
      .map((g) => (g || []).filter((p) => p.id !== PANEL_ID).map((p) => Object.assign({}, p)))
      .filter((g) => g.length);
    for (const group of groups) {
      if (!group.some((p) => p.active)) group[0].active = true;
    }
    editor.updateEditor({ panelsShown: groups });
  }

  function open() {
    showPanel();
  }

  /* ------------------------------------------------------------- hotkey -- */

  // Overridden from settings; see oven.newPrimerHotkey.
  let hotkey = 'mod+shift+k';

  /** "mod+shift+k" -> "⌘⇧K" on a Mac, "Ctrl+Shift+K" elsewhere. */
  function hotkeyLabel(combo) {
    const mac = isMac();
    return String(combo || '').split('+').map((part) => {
      const p = part.trim().toLowerCase();
      if (p === 'mod') return mac ? '⌘' : 'Ctrl';
      if (p === 'cmd' || p === 'meta') return mac ? '⌘' : 'Win';
      if (p === 'ctrl' || p === 'control') return mac ? '⌃' : 'Ctrl';
      if (p === 'shift') return mac ? '⇧' : 'Shift';
      if (p === 'alt' || p === 'option') return mac ? '⌥' : 'Alt';
      return p.toUpperCase();
    }).join(mac ? '' : '+');
  }

  function isMac() {
    return /Mac|iPhone|iPad/.test((navigator && navigator.platform) || '');
  }

  function matchesHotkey(e, combo) {
    const parts = String(combo || '').split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
    const key = parts[parts.length - 1];
    if (!key || (e.key || '').toLowerCase() !== key) return false;

    const mac = isMac();
    // "mod" is Cmd on a Mac and Ctrl everywhere else, matching OVE's own
    // hotkey vocabulary so a binding reads the same in both places.
    const want = {
      shift: parts.includes('shift'),
      alt: parts.includes('alt') || parts.includes('option'),
      meta: parts.includes('cmd') || parts.includes('meta') || (mac && parts.includes('mod')),
      ctrl: parts.includes('ctrl') || parts.includes('control') || (!mac && parts.includes('mod'))
    };
    return e.shiftKey === want.shift && e.altKey === want.alt
      && e.metaKey === want.meta && e.ctrlKey === want.ctrl;
  }

  function wireHotkey() {
    window.addEventListener('keydown', (e) => {
      if (!hotkey || !matchesHotkey(e, hotkey)) return;
      e.preventDefault();
      e.stopPropagation();
      open();
    }, true); // capture, so OVE's own handlers do not swallow it first
  }

  /* -------------------------------------------------- right-click entry -- */

  /**
   * The menu item, with its shortcut shown beside it.
   *
   * OVE renders a menu item's `label` to the right of its text, which is how
   * its own commands show their hotkeys -- so the binding is discoverable from
   * the menu rather than only from settings.
   */
  function menuItems() {
    return [{
      text: 'New primer',
      label: hotkeyLabel(hotkey),
      className: 'ove-newprimer-menu-item',
      onClick: () => open()
    }];
  }

  function init(ove, opts) {
    editor = ove;
    if (opts && opts.hotkey) hotkey = opts.hotkey;
    if (opts && opts.editorName) editorName = opts.editorName;
    wireHotkey();
  }

  window.OveNewPrimer = {
    init, open, showPanel, hidePanel, panelMap, menuItems, PANEL_ID,
    // exported for tests
    hotkeyLabel, matchesHotkey
  };
})();
