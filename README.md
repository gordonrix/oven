<p align="center">
  <img src="images/bigicon.png" alt="OVEN" width="200">
</p>

<h1 align="center">OVEN — Open Vector Editor with New Features</h1>

<p align="center">
  A plasmid editor for VS Code, built on
  <a href="https://github.com/TeselaGen/tg-oss/tree/master/packages/ove">Open Vector Editor</a>.
</p>

Open `.gb`, `.gbk`, `.fasta`, `.fa` and `.dna` files in a tab, then design primers, collect
them into an order, search your existing primer collection, edit codons, and align Sanger
reads against the plasmid on screen.

![A plasmid open in OVEN: the sequence map on the left, the circular map and primer search
results on the right, and the right-click menu showing Search primers in
selection](images/Screenshot_overview.png)

## Install

Search for **OVEN** in the Extensions view (`Cmd/Ctrl+Shift+X`), or:

```sh
code --install-extension gordonrix.oven
```

If you have `sanekun.openvectoreditor` installed, uninstall it first — otherwise both offer
to open `.gb` files.

<details>
<summary>Building it yourself</summary>

```sh
npm install
npm run package
code --install-extension oven-*.vsix --force
```

`npm run package` refuses to build if the vendored bundle has drifted from `patches/`.
</details>

## What this fork adds

Upstream is a viewer: it embeds Open Vector Editor in a VS Code tab and saves the file back.
Added here:

- **Primer cart** — collect primers across plasmid files into one order, with sessions, CSV
  export and cross-referencing against primers you already own
- **Primer search** over your own primer collection, 3′-anchored so a primer still matches
  through its 5′ tail, with attach-to-sequence, a column chooser and click-to-sort
- **New Primer as a side panel**, so the sequence stays visible while you design against it,
  with an editable 5′ tail and mismatching bases marked in red
- **Sanger alignment** against the open plasmid — chromatograms, mutated codons translated
  from the read's own bases, and reads that run off the end of a circular reference handled
  rather than reported as hundreds of mismatches
- **Change Amino Acid** — pick any codon in the genetic code, not just synonyms, with usage
  tables for *S. cerevisiae*, *E. coli*, *H. sapiens* and *M. musculus*
- **Keyboard shortcuts** for primer search, new primer and the copy variants — see
  [Keyboard shortcuts](#keyboard-shortcuts)
- **Melting temperature and GC** for the current selection, in the status bar
- **File → Save** and `Cmd/Ctrl+S` wired to Open Vector Editor's own menu item, which greys
  itself out when nothing has changed — that item stays hidden unless an `onSave` is passed,
  and upstream never passed one
- **DNA base editing enabled**, and the **Create** menu populated — upstream left OVE's
  `readOnly` default in place, which hid every item in it
- **Sequences open split**, sequence on the left and the circular map in a tab on the right
- **Persistent UI state** — cut-site filter, search columns and widths, codon-table organism

Plus fixes to Open Vector Editor itself, in the areas above: origin-spanning features
corrupting on save, three `.ab1` parser bugs, chromatogram scaling that drew some real reads
as a flat line, and annotation labels of three characters or fewer never being drawn.

The vendored OVE bundle is patched rather than forked, and every patch is tracked and
checksummed — see [`patches/README.md`](patches/README.md). Patches and issue drafts for
upstream are in [`upstream/`](upstream/).

## Primer cart

Collect primers from any number of plasmid files into one list you can paste into a
spreadsheet or an oligo order.

![The primer cart beside a plasmid, holding two newly drawn primers with their length, Tm,
strand and binding site, above buttons to copy them as TSV or export
CSV](images/Screenshot_primer-cart.png)

1. Open a plasmid, highlight a region, and use **Create → New Primer** — from the menu bar,
   the right-click menu, or `Cmd/Ctrl+Shift+K`. The form opens as a panel beside the
   sequence, so the plasmid stays visible, and the binding site follows the selection as
   you drag.

   **Set From Selection** fills in the binding site and the bases from whatever is
   highlighted, reading it on the strand the **Strand** radio names. Nothing follows the
   selection on its own, so dragging around costs nothing and never overwrites what you have
   typed.

   The **Bases** box holds the oligo itself. Type on the front to add a **5′ tail** — an
   overhang, a restriction site, a barcode — and any base that does not match the template
   turns red, so the tail shows as the part that will not anneal. The annotation still covers
   only the annealing footprint; the full ordered sequence goes to the cart and the file.

   Under **Advanced**, *Oligo Binds On* says which end of the oligo anneals (3′ by default,
   which is what puts a 5′ tail on the front).
2. Click **Add to Cart** in the top right to pick primers. Ones you create are added
   automatically.
3. Repeat in as many files as you like. The cart is global and survives restarts.
4. **Copy** puts names and sequences on the clipboard; **Export CSV** writes the full table.

**Sessions** keep separate orders apart. A new session is named for today's date; rename it
to something like `2026-08-10 backbone swaps` and old orders stay findable. See **OVEN: New
Cart Session** and **OVEN: Switch or Manage Cart Sessions**.

## Your primer inventory

Point `oven.inventoryPath` at a spreadsheet of primers you have already ordered, and OVEN
tells you which cart primers you already have in the freezer — green for in-inventory (with
its ID), orange for new, grey when the file could not be read.

**The file needs two columns: a name and a sequence.** Everything else is up to you — any
column order, any extra columns, any sheet, any header wording. `.xlsx`, `.xlsm`, `.csv`,
`.tsv` and `.txt` all work.

| setting | names | default |
|---|---|---|
| `oven.inventoryNameColumn` | the name or ID column | first column |
| `oven.inventorySequenceColumn` | the sequence column | second column |
| `oven.inventorySheet` | which sheet of a workbook | first sheet |
| `oven.inventoryAliasColumn` | an optional second identifier | a column named `Alias` |

Columns you do not name are still read — they are offered in the search results under
**Columns**, below. Header matching is exact first, then case-insensitive; if a name or
sequence column cannot be found, the error lists the headers actually present.

## Primer search

Click **Primer Search**, or right-click the sequence and choose **Search primers**, to find
every primer in your inventory that binds the open plasmid. Results open beside the sequence
map, so you can see where each hit lands. Clicking a row selects and scrolls to that site.

| Pos | Str | Name | Tm | Anneal bp | Tail bp | Alias | |
|---|---|---|---|---|---|---|---|
| 325 | + | P_0048 | 72.4 | 25 | — | fwd screen | Attach |
| 1522 | + | P_0123 | 65.4 | 22 | +16 | gibson fwd | Attach |

Matching is **exact and 3′-anchored**: a primer binds if enough bases at its 3′ end match
the template, so primers carrying a 5′ tail — a Gibson overhang, a restriction site, a
barcode — are found even though their full sequence appears nowhere in the plasmid. The
unmatched tail is shown in the **Tail bp** column; tick **100% match** to hide those.

**Scope it to a selection.** A 10 kb plasmid can legitimately return hundreds of hits, where
a 200 bp selection returns a handful. A primer is kept when its 3′ end lands inside the
selection, so the rest of the match may extend beyond it — which is what you want when
asking whether an existing primer can prime from a chosen point.

**Attach** adds a `primer_bind` annotation over the annealing footprint, with the full
ordered sequence (tail included) stored as a `/Sequence` qualifier. Press **Save** to write
it to the file. Attaching is not undoable with Cmd+Z — remove it from Properties → Primers.

### Choosing columns

**Columns** in the toolbar picks what the table shows. There are two kinds:

- **Computed** — `Tm`, `Anneal bp` and `Tail bp`, worked out from the match. `Pos`, `Str`,
  `Name` and the **Attach** button are always shown.
- **From your file** — every column of your inventory except the name and the sequence,
  under its own header. If your spreadsheet has `Date ordered` or `Dissolved in`, they are
  offered here.

By default you get `Tm`, `Anneal bp`, `Tail bp` and your alias column. Your choice is
remembered across files and sessions; **Reset to defaults** puts it back. Drag a column
divider to resize, double-click one to reset all widths.

The **Filter** box searches names, sequences and every inventory column — including ones you
are not showing.

Other settings: `oven.searchMinAnneal` (default 15), `oven.searchFullLengthOnly`,
`oven.searchMaxHits`.

## Alignment

Click **Align** in an open plasmid to check clones against it. That plasmid becomes the
reference; `.ab1`, `.gb`, `.gbk` and `.fasta` reads are all accepted, and a FASTA holding
several records becomes one track per record.

![Three Sanger reads aligned to a plasmid, each with its chromatogram, labelled match or
mismatch, with a single disagreeing base highlighted in
red](images/Screenshot_alignment.png)

Four ways to add reads:

- **Right-click the files in the Explorer → Add to Alignment** (handles a multi-selection)
- **Browse…** in the panel
- **Paste** — copy in Finder, click the panel, `Cmd+V`
- **Drag and drop** onto the panel, **holding ⇧ Shift**

> Shift matters. Without it, VS Code lays its own drop overlay over the editor area as soon
> as a drag enters the window, and opens what you drop as a new tab. That overlay belongs to
> the workbench and an extension cannot turn it off; holding Shift dismisses it.

The reference sits pinned along the top with its annotations and translations. Each read
gets a row, with its chromatogram if it has one. Differences are highlighted in the rows and
marked in the summary strip at the bottom, and mutated codons show the amino acid they now
encode.

Each read gets a verdict:

| | meaning |
|---|---|
| **match** (green) | perfect, and covers the reference end to end |
| **partial match** (gold) | perfect over the window it covers, but only part of the reference |
| **mismatch** (red) | something differs |

A Sanger read covers a window, so it can only ever reach **partial match** — only
whole-plasmid sequencing turns a reference green. One wrong base is a mismatch whatever the
coverage. Hover a read for coverage, substitution and gap counts, identity, strand, and how
far it was rotated.

**Reads that cross the origin are handled.** MAFFT has no notion of circular topology, so
each read is k-mer anchored and rotated into the reference's frame first, with its
chromatogram rotated to match. On a real 4489 bp plasmid that is the difference between 0
mismatches and 2140. The reference itself is never rotated, so coordinates hold.

Trace ends below `oven.alignTrimQuality` (default 20) are trimmed before aligning; set it to
`0` to align the full read. `oven.alignMaxReads` (default 50) caps one alignment.

### MAFFT

Alignment needs MAFFT, installed separately:

```bash
brew install mafft                      # macOS
conda install -c bioconda mafft         # any platform
```

The panel checks when it opens, not when you press Align, so you find out before choosing
files. If it is missing you get both commands, a **Locate MAFFT…** button, and **Re-check**.

You normally need not configure anything: OVEN looks on your `PATH`, then where Homebrew and
conda actually install — including named conda environments, which are never on VS Code's
`PATH` and are the usual reason a `mafft` that works in the terminal is invisible here. Note
that **VS Code reads your `PATH` at startup**, so installing MAFFT with the editor open needs
a window reload.

Run **OVEN: Check MAFFT Installation** to see which binary was found. `oven.mafftPath` sets
one explicitly; `oven.mafftArgs` (default `--auto`) chooses a strategy — try
`--localpair --maxiterate 1000` for L-INS-i accuracy. `--adjustdirection` is always passed,
so a read in the wrong orientation is flipped rather than reported as garbage.

## Editing

**Change Amino Acid** — right-click a residue in a translation and pick any codon from the
whole genetic code, not just that residue's synonyms, so you can mutate the residue itself
rather than only swap its codon.

![The Change Amino Acid dialog, laid out as a printed codon table with fraction and
frequency against every codon and the current one
highlighted](images/Screenshot_codon-table.png)

The dialog is laid out the way a codon table is printed — first base down the side, second
across the top, third within each block — and every codon carries its **fraction** (share of
that amino acid's codons) and **frequency** (per thousand), for *S. cerevisiae*, *E. coli*,
*H. sapiens* and *M. musculus*. Data is from the Codon Usage Database (Nakamura et al. 2000),
embedded because a webview cannot reach the network. Your organism and the
three-letter/single-letter choice are remembered.

Choosing a codon rewrites those three bases and nothing else, on either strand and across
the origin, in the opposite case to its neighbours so you can find it again. It lands on the
undo stack like any other edit.

Set `oven.allowSequenceEditing` to `false` to lock the bases, or `oven.readOnly` to lock the
file entirely.

## Selection readout

Selecting a region gives you, in one line:

```
DNA | Editable | Selecting 22 bps from 101 to 122 (45.5% GC) | Melting Temp: 64.5 | Length: 6537 bps
```

Melting temperature uses SantaLucia (1998) nearest-neighbour parameters by default — the
same model as NEB's calculator. Click the readout for a Breslauer/SantaLucia choice. Outside
**8–100 bp** it shows `—`: the nearest-neighbour model describes a short duplex melting all
at once, so a number there would not mean anything.

`oven.showSelectionStatsByDefault` (on) switches both status-bar items on the first time you
open a sequence; toggling them yourself in the **View** menu always wins.

## Other

- Select a DNA file → **Open With → OVEN**, and set it as the default if you like
- Sequences open with the **Circular Map** in a tab on the right, beside the sequence.
  `oven.viewType` changes that: `sequence` or `circular` for a single pane with the other
  as a tab you switch to. **Reopen the file** for a change to take effect
- Save with **File → Save** or `cmd/ctrl+S`, in every format including `.dna`
- **Filter Cut Sites** is remembered between files, rather than resetting each time
- Search hits are marked with a dark grey bar showing which strand they matched
- **OVEN: Open Demo Editor** opens a scratch editor that keeps its contents across tab switches

## Keyboard shortcuts

These are the ones this fork adds. **View → View Editor Hotkeys** lists them alongside Open
Vector Editor's own, and each is shown next to its entry in the right-click menu.

| | | |
|---|---|---|
| `⌘⌥F` | `Ctrl+Alt+F` | **Primer Search** — the selection if there is one, the whole plasmid otherwise |
| `⌘⇧K` | `Ctrl+Shift+K` | **New Primer** |
| `⌘⇧R` | `Ctrl+Shift+R` | Copy Reverse Complement |
| `⌘⌥A` | `Ctrl+Alt+A` | Copy AA Sequence |
| `⌘⌥E` | `Ctrl+Alt+E` | Copy Reverse Complement AA Sequence |
| `⌘⌥P` | `Ctrl+Alt+P` | Simulate PCR — moved off Open Vector Editor's `⌘⇧P`, which is the Command Palette |

Plain `⌘C` copies the selection as before; it simply was not labelled in the menu until now.

**Rebinding.** `oven.searchPrimersHotkey` and `oven.newPrimerHotkey` take Open Vector
Editor's notation: `mod` is Cmd on macOS and Ctrl elsewhere, joined with `+` — `alt+p`,
`mod+alt+n`. An empty string means no shortcut. **Reopen the file** for a change to take
effect.

Avoid anything VS Code binds at the workbench level, such as `mod+j` or `mod+shift+f`
(**Search: Find in Files**): those resolve before a webview ever sees the key, so the
shortcut appears to do nothing. Bindings scoped to a text editor are free, which is why
`⌘⇧K` works here despite being Delete Line. Open Vector Editor's own `mod+k` and `mod+l`
still make a feature and a part.

## Settings

Anything in this README that reads like `oven.something` is a VS Code setting. To change one:

**`Cmd+,`** on macOS, **`Ctrl+,`** on Windows and Linux — or **Code → Settings → Settings** —
then type **OVEN** in the search box. All of them are grouped under **Extensions → OVEN**.

To edit them as text instead, run **Preferences: Open User Settings (JSON)** from the
command palette (`Cmd/Ctrl+Shift+P`) and add entries like:

```jsonc
{
  "oven.inventoryPath": "/Users/you/Documents/Primers Inventory.xlsx",
  "oven.newPrimerHotkey": "alt+p"
}
```

Most take effect immediately; the ones that change how the editor is built —
`oven.newPrimerHotkey`, `oven.searchPrimersHotkey`, `oven.readOnly`, `oven.viewType` —
need the file reopened.

## Known issues

Inherited from upstream:

- Content in a file-backed editor does not persist across tab switches; only the editor
  opened via **OVEN: Open Demo Editor** retains its contents.
- `.dna` files: primers already in the file are displayed and preserved on save, but **new**
  primers created in the UI are not written back. Use `.gb` if you need that. The primer cart
  is unaffected.

## Fork notice

This is a fork of [sanekun/ove-vscode](https://github.com/sanekun/ove-vscode), which is
licensed under **GPL-3.0**. This fork is also GPL-3.0; see [LICENSE](LICENSE).

It is based on upstream **v1.2.0**. Upstream's git `main` is still at v1.1.5 — v1.2.0 was
published to the Marketplace but never pushed to git, so the v1.2.0 sources here were
imported from the published VSIX (see the `vendor-1.2.0` tag, which records a sha256 for
every imported file).

## Release notes

See [CHANGELOG.md](CHANGELOG.md).
