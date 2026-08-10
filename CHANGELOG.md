# Change Log

All notable changes to the "openvectoreditor" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## 1.6.1

- The selection readout moved into OVE's status bar, next to "Selecting N bps" and
  "Length", instead of floating in the corner where it was easy to miss.
- Tm limit lowered from 200 bp to 100 bp.

## 1.6.0

- A readout in the bottom-right corner showing length, GC and Tm for the current
  selection. The Tm calculation moved into the shared module so the host and the webview
  cannot drift apart; verified to match the Python to four decimals.
- Declines to show a Tm over 200 bp, where the nearest-neighbour primer model stops
  meaning anything.

## 1.5.3

- Narrower default width for the primer search Name column, matching Pos. Existing saved
  widths win over the new default; double-click a divider to reset.

## 1.5.2

- Primer search table columns are now resizable: drag a header divider, or
  double-click one to restore the defaults. Widths persist across files and sessions.
- Replaced the automatic column hiding at narrow widths, which removed data with no way
  to get it back. A narrow pane now scrolls sideways and what is visible is your choice.

## 1.5.1

- Primer search results now open as a **Primer Search tab beside the sequence map**
  rather than a modal overlay that covered the very sequence you were checking. OVE
  accepts a `panelMap` prop merged over its built-in one, so this is a real panel in its
  own split layout: resizable, reorderable, and visible alongside the map.
- Clicking a result selects and scrolls to that binding site.
- The right-click entry is registered on every annotation surface (translation, ORF,
  cut site, feature, part, primer, warning...) instead of a handful, so it can no longer
  go missing depending on what happens to lie under the cursor. Its scope now follows the
  live selection rather than which menu was opened.

## 1.5.0

- **Primer search.** Matches the configured primer inventory against the open plasmid,
  exact matches only, from a toolbar button or the sequence right-click menu. Anchored on
  each primer's 3' end rather than matching whole sequences, so primers carrying a 5'
  Gibson tail or restriction site are found -- a third of the reference inventory, and
  invisible to whole-string matching. Case is not used to locate the tail; the convention
  does not hold in real data.
- Scope to the whole plasmid or to the current selection. A hit is kept when its 3' end
  falls inside the selection, even if the match extends outside it.
- **100% match only** filter, applied client-side so toggling it is instant.
- **Primer attach.** Turns a hit into a `primer_bind` annotation over the annealing
  footprint, keeping the full ordered sequence (tail included) on the primer and in a
  `/Sequence` qualifier.
- `Primer Cart: Choose Primer Inventory File...`, also offered inline when a search runs
  with no inventory configured.
- The editor buttons now sit in one flex row rather than three hand-tuned offsets.

## 1.4.0

- **Cart sessions.** The cart is grouped into named sessions so it does not grow without
  bound; starting a new one parks the previous batch rather than deleting it. Existing
  carts migrate into a first session automatically.
- **No more activity-bar icon.** The cart now opens as an editor tab from the green
  button in the editor or from `Primer Cart: Show Cart`, instead of occupying a permanent
  activity-bar slot.
- The editor button is relabelled **Add to Cart**. Calling it "Cart" made it read as
  "show me my cart", when it only ever listed the open file's primers -- the actual cart
  was somewhere else entirely.
- Copy/export/session commands are all available from the command palette, so the cart
  can be exported without opening any UI.

## 1.3.2

- Fixed: the cart panel could sit empty while the badge showed a full cart. Three
  separate message-delivery faults; see the commit log.

## 1.3.0 (fork)

Fork of [sanekun/ove-vscode](https://github.com/sanekun/ove-vscode) (GPL-3.0), branched
from upstream v1.2.0. Upstream git `main` is v1.1.5; the v1.2.0 sources were imported
from the published Marketplace VSIX, recorded under the `vendor-1.2.0` tag with a sha256
per file.

- **Primer Cart**: sidebar panel collecting primers across plasmid files, with copy-TSV,
  copy-sequences and CSV export, plus optional cross-reference against a user-supplied
  `.xlsx`/`.csv` primer inventory.
- **Fixed: the Create menu was always empty.** OVE's `readOnly` state defaults to `true`
  and the wrapper never overrode it, so every Create item was hidden. Now passes
  `readOnly: false` with `disableBpEditing: true`, so annotations can be created while
  the sequence itself stays protected.
- Renamed identity to `gordonrix.ove-vscode-primer-cart` and the custom editor viewType
  to `oveCart.editor`; settings moved from `openvectoreditor.*` to `oveCart.*` (the old
  `viewType` key is still read as a fallback).
- Removed `media/bioparser.umd.js`, `media/style.css`, two committed `.vsix` files and
  the unused `react` dependency (~10 MB off the repo, ~3 MB off the VSIX).

## 1.1.0

- 250629
- Change save button css.
- Change initial state `preview mode` to `normal mode`
- Use umd version bioparser
    - Change fasta name from `jsonToFasta` function
    ``` code
    name||length||description > name
    ```
- **Update ove-webview panel**
    - background color is always white
    - height is always 100%
- **Support .dna format**
    - Edit bio-parser script
    ``` code
    // const arrayBuffer = yield getArrayBufferFromFile(fileObj);
    const arrayBuffer = fileObj;
    ```
    - Change `CustomTextEditorProvider` to `CustomEditorProvider` (can read binary)
    - disabled save button.
- Update README to 1.1.0

### 1.1.1

- Update README in vsix
- Update `package.json` tag, category

### 1.1.2

- tabmenu name .OVE to .show
- Add `retainContextWhenHidden: true` option in tabmenu editor
- code refactoring

### 1.1.3

- Add setting `openvectoreditor.viewType` to adjust initial view type (sequence only, circular map only, split)

### 1.1.4

- issue#2 accepted.
- added Ape color support

``` js
if (feat.notes.ApEinfo_fwdcolor && feat.notes.ApEinfo_fwdcolor[0]) {
  feat.color = feat.notes.ApEinfo_fwdcolor[0];
} else if (feat.notes.ApEinfo_revcolor && feat.notes.ApEinfo_revcolor[0]) {
  feat.color = feat.notes.ApEinfo_revcolor[0];
}
```

### 1.1.5

- add '.fa', '.gbk' extension
- Issue#3

## 1.2.0

- 260620
- **SnapGene .dna file writing support**
    - Replaced `bioparser.umd.js` with upgraded `bioparser2.umd.js`
    - Added `jsonToSnapgene()` to `bioparser2.umd.js`
        - Writes SnapGene binary format (.dna) from sequence JSON
        - Preserves all original TLV blocks (Primers, Features, Notes, History, etc.) via `_snapgeneRawBlocks`
        - Always reconstructs block 0 (sequence) and block 10 (features) to reflect edits
    - `snapgeneToJson()` now parses block 5 primers and stores raw blocks for lossless roundtrip
- **Save button enabled for .dna files**
    - Removed `disabled = true` restriction on Save button for `.dna` format
    - Extension stores `_snapgeneRawBlocks` in closure on open; merges back on save
- **Known Limitation**
    - `.dna` format: Primers from block 5 are displayed in OVE and preserved on save, but **adding new primers via OVE UI is not supported** — new primers will not be written to the file
