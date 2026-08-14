# Change Log

All notable changes to the "openvectoreditor" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## 1.9.3

- The read verdict rule moved into the shared module so it can be unit-tested. It was
  living inside the webview script, where the most-read output in the panel had no coverage
  beyond a handful of fixed cases in a browser test. Behaviour is unchanged; every edge of
  it is now pinned, including the full-coverage boundary and the short-stretch floor.

## 1.9.2

- **The alignment now fills the panel.** It was collapsing to a short strip with dead space
  underneath because the panel page never set a height on `html`/`body`, so the layout had
  nothing to resolve `100%` against. It also tracks the panel as you resize it.
- **Reads report a verdict, not a count**: **match** (green) is perfect *and* covers the
  reference end to end; **partial match** (gold) is perfect over the window it covers;
  **mismatch** (red) is anything that actually differs. A Sanger read can therefore only
  ever reach partial match — only whole-plasmid sequencing turns the whole reference green.
  Coverage, counts, identity, strand and rotation stay in the tooltip. A perfect stretch
  under 50 bp is treated as luck rather than evidence and reads as a mismatch.
- **The drop box folds away once there is an alignment**, behind an **Add sequences** button
  that opens and closes it. It is still the whole empty state before the first alignment.
- Dropped the invented "Sanger sequencing" label from the alignment header, and renamed
  **Change…** to **Change reference**.
- **Editor buttons restyled** to match OVE's own menu bar — 14 px, square, desaturated — and
  moved up into the menu row. At 16 px bold they were wide enough to cover the toolbar icons
  as soon as the editor was made narrow; they no longer overlap at any width that fits the
  menu bar itself.

## 1.9.1

- **MAFFT setup is now checked when the alignment panel opens**, rather than failing after
  you have chosen files and waited. A banner offers the install commands, a **Locate
  MAFFT…** button that writes the path to settings for you, and **Re-check**.
- **Finds MAFFT without configuration in more places**: `PATH` first, then Homebrew,
  MacPorts and conda locations — including **named conda environments**, which are never on
  VS Code's `PATH` and are the usual reason a `mafft` that works in the terminal is
  invisible to the editor.
- The not-found message now mentions reloading the window, which is the second thing people
  hit: VS Code reads `PATH` at startup, so a fresh install is invisible until it does.
- Clearer failures for a misconfigured `oveCart.mafftPath`: a file that exists but is not
  MAFFT, a directory, and a path that does not exist are now told apart and named, instead
  of surfacing as "MAFFT returned 0 sequences". A configured path is never silently fallen
  back from — being told it is wrong beats quietly aligning with a different binary.
- New command **Primer Cart: Check MAFFT Installation**, reporting the resolved path and
  version.

## 1.9.0

- **Alignment tool.** Press **Align** in an open plasmid to check sequencing reads against
  it. The reference keeps its annotations along the top, each read gets its own row with its
  AB1 chromatogram, and a summary strip underneath marks mismatches in red. Reads are added
  by dropping files onto the panel — from Finder or from the VS Code Explorer — or with
  **Browse…**; `.ab1`, `.gb`, `.gbk` and `.fasta` are accepted, and a multi-record FASTA
  becomes one track per record. A read with no trace data simply renders without one.
- Alignment is done by **MAFFT**, which is now required for this feature: install it with
  `brew install mafft` or `conda install -c bioconda mafft`. `oveCart.mafftPath` and
  `oveCart.mafftArgs` control which binary is used and how it is run.
- **Reads that cross the origin align end to end.** MAFFT has no notion of circular
  topology, and a full-plasmid read starts wherever the assembler broke it — measured on a
  real 4489 bp plasmid, handing MAFFT the read unchanged gave 2140 mismatches instead of 0.
  Reads are therefore k-mer anchored and rotated into the reference's frame first, with the
  chromatogram carried along so peaks still line up with their bases. The reference is never
  rotated, so positions stay in its coordinates.
- Trace ends below `oveCart.alignTrimQuality` (default 20) are trimmed before aligning, so
  end noise does not dominate the mismatch count. Set it to `0` to align the full read.
- **Fixed: `.ab1` files could not be read at all.** Three separate faults in the vendored
  parser, each a hard throw; see [patches/README.md](patches/README.md). Any Node input
  produced a zero-length view; trace tags written only as number 1 were not found; and tags
  whose data is 4 bytes or fewer, which ABIF stores inline, were dereferenced as offsets.

## 1.8.1

- **Fixed: primers spanning the origin rendered as empty hatched boxes, drawn twice.**
  Two separate faults in the same file, both specific to a `join(...)` that crosses the
  origin — as the Gibson planner emits for a backbone primer.
  - Open Vector Editor computed the primer's bases from an offset that goes negative when
    the annotation wraps, so it found no bases at all and emitted an invalid negative SVG
    `textLength`. Patched in the vendored bundle; see [patches/README.md](patches/README.md).
  - The parser describes an origin wrap twice over — as a wrapped start/end *and* as a
    two-entry `locations` array — and OVE draws both, stacking two copies 8 px apart. The
    redundant half is now dropped on load. A genuine spliced join keeps its exons, and the
    strip is undone before saving, so files are still written with `join(...)` exactly as
    they came in rather than the non-standard `4113..17` the writer falls back to.

## 1.8.0

- Search hits now say which strand they came from: a light grey bar hugging the letters,
  above them for a top-strand match and below them for a bottom-strand one. It applies
  both to OVE's Find tool and to clicking a row in Primer Search, which previously
  revealed the footprint with no strand cue at all.
- Removed the gold triangles OVE drew on bottom-strand Find hits. They were washed out by
  the highlight's own 30% opacity and read as decoration rather than direction; the bar
  replaces what they were for.

## 1.7.1

- Dropped the "conflicted copy" warning. It scanned the inventory's folder on every load
  to flag similarly named siblings, which is a directory read per parse in a Dropbox tree
  in exchange for a warning about a file that is usually harmless.

## 1.7.0

- Removed the separate selection readout added in 1.6.0. Open Vector Editor already has
  melting-temp and GC status-bar items; a second one competing with them was the wrong
  shape.
- `oveCart.showSelectionStatsByDefault` (default on) turns OVE's own **Melting Temp of
  Selection** and **Percent GC Content of Selection** on. The View-menu toggles still win.
- `oveCart.useDesignTmCalculation` (default on) substitutes the pipeline's NEB Q5 Tm
  (200 nM primer, 1.5 mM Mg²⁺) into OVE's item, in place of its own 500 nM no-Mg figure.

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
