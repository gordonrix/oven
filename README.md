# OVEN — Open Vector Editor with New Features

<img src="icon.png" alt="OVEN" width="128">

View plasmid sequences in VS Code with [Open Vector Editor](https://github.com/TeselaGen/tg-oss/tree/master/packages/ove),
and collect the primers you design across many plasmid files into one list you can copy
straight into a spreadsheet or an oligo order.

![ove-vscode](https://github.com/sanekun/ove-vscode/raw/HEAD/media/ove-vscode.png)

## Fork notice

This is a fork of [sanekun/ove-vscode](https://github.com/sanekun/ove-vscode), which is
licensed under **GPL-3.0**. This fork is also GPL-3.0; see [LICENSE](LICENSE).

It is based on upstream **v1.2.0**. Note that upstream's git `main` is still at v1.1.5 —
v1.2.0 was published to the Marketplace but never pushed to git, so the v1.2.0 sources
here were imported from the published VSIX (see the `vendor-1.2.0` tag, which records a
sha256 for every imported file).

## What this fork adds

Upstream is a viewer: it embeds Open Vector Editor in a VS Code tab and saves the file
back. Everything below is added here. Grouped by what it is for rather than by release —
see [CHANGELOG.md](CHANGELOG.md) for the detail.

### Designing and ordering primers

- **Primer Cart** — a panel that accumulates primers across plasmid files into one list,
  with copy names+sequences, copy-sequences and full CSV export, and named sessions so several orders
  can be in flight at once. Primers created in the editor are added automatically.
- **Cross-reference an inventory** — point it at your own primer spreadsheet and the cart
  tells you which primers you already have in the freezer.
- **Primer search** — search a plasmid, or just the selection, for every primer in your
  inventory, with melting temperatures and full-length/partial matching. Hits can be
  attached to the sequence as annotations or added to the cart.
- **Melting temperatures** come from Open Vector Editor's own nearest-neighbour
  calculation, with a Breslauer/SantaLucia choice in the status-bar popover.

### Checking clones

- **Alignment** — align Sanger reads against the plasmid on screen. Takes `.ab1`, `.fasta`,
  `.gb` and `.gbk` from the Explorer's right-click menu, a file picker, a paste or a drop,
  and uses MAFFT (found automatically in Homebrew or conda; the panel walks you through
  installing it if it is missing).
- Reads are quality-trimmed, reverse-complemented if needed, and **rotated when they span
  the plasmid origin** — which MAFFT cannot do on its own, since it has no notion of a
  circular sequence.
- **Chromatograms** are drawn under each trace read, with controls for track height and
  trace amplitude, and the reference stays pinned above the reads while you scroll.
- Each read is called **match / partial match / mismatch**, and mutated codons show the
  amino acid they now encode.

### Editing

- **Change Amino Acid, with a built-in codon usage table** — right-click a residue in a
  translation and pick any codon from the whole genetic code, not just that residue's
  synonyms, so the residue itself can be mutated and not only its codon swapped.

  The table is laid out the way a codon table is printed — first base down the side, second
  across the top, third within each block — and every codon carries its **fraction** (its share
  of that amino acid's codons) and **frequency** (per thousand codons), for
  *S. cerevisiae*, *E. coli*, *H. sapiens* and *M. musculus*. The organism and the
  three-letter/single-letter notation are remembered between sessions, and each organism links
  back to the table it came from: the Codon Usage Database (Nakamura et al. 2000), embedded
  because a webview's content-security policy blocks the network.

  Choosing a codon rewrites those three bases and nothing else, on either strand and across the
  origin, and the edit is written in the opposite case to its neighbours so it can be found
  again. It lands on the undo stack like any other edit.
- **The editor is no longer read-only by default.** Upstream never overrode OVE's `readOnly`
  default of `true`, which hid every item in the **Create** menu — so "Create → New Primer"
  appeared as an empty popup.
- **Filter Cut Sites is remembered** between files and sessions, rather than resetting to
  "Single cutters" every time.

### Reading the sequence

- **Strand indicator bar** — search hits are marked with which strand they matched.
- **Selection readout** — length, GC content and melting temperature for the current
  selection.

### Correctness fixes

- **Features that span the origin** of a circular plasmid render correctly and survive a
  save round-trip. Upstream wrote them back in a form that grew a spurious duplicate
  location each time the file was saved.
- **Three `.ab1` parser bugs** in `@teselagen/bio-parsers`, which between them made trace
  files unreadable in this environment. Patches and issue drafts for upstream are in
  [`upstream/`](upstream/).
- **Chromatogram scaling** is taken from a percentile of the called-base peaks rather than
  the tallest sample anywhere in the trace — which in a real Sanger file is the dye front,
  not a base, and drew some reads as a flat line. Measured over 157 real reads; the
  working is in [`notes/chromatogram-fit-scale.md`](notes/chromatogram-fit-scale.md).

### Housekeeping

- Removed ~10 MB of dead artifacts (a superseded bio-parser bundle, a duplicate
  stylesheet, two committed `.vsix` files) and an unused `react` dependency.
- Renamed the extension identity and custom-editor `viewType` so it can be installed
  alongside, or instead of, the Marketplace original.
- The vendored OVE bundle is patched rather than forked, and every patch is tracked,
  checksummed and re-checkable — see [`patches/README.md`](patches/README.md).

## Installation

Not published to the Marketplace. Build and sideload:

```sh
npm install
npm run package
code --install-extension oven-*.vsix --force
```

If you have the original `sanekun.openvectoreditor` installed, uninstall it — otherwise
both will offer to open `.gb` files and "Reopen Editor With…" will show two OVE entries.

## Using the Primer Cart

1. Open a plasmid file. Select a region and use **Create → New Primer**, or use an
   existing primer already annotated in the file.
2. Click **Cart** in the top-right of the editor to pick primers to add. Primers you
   create are added automatically (`oven.autoAddCreatedPrimers`).
3. Repeat in as many plasmid files as you like — the cart is global and persists across
   restarts.
4. Click **Open cart** at the top of that picker (or run **OVEN: Show Primer Cart**) to
   open the cart as an editor tab, listing primers from every file. Use **Copy TSV**
   (pastes into Excel/Sheets as columns), **Copy sequences** (one per line, for bulk
   oligo order forms), or **Export CSV…**.

There is deliberately no activity-bar icon: the cart is opened on demand and closed when
you are done, rather than occupying a permanent slot.

### Sessions

A cart belongs to a **session**, so it does not grow without bound. Hit **+ New session**
in the cart to park the current batch and start empty — nothing is deleted, and the old
session stays available from the session button. Sessions are named by date by default;
rename them to something like `2026-08-10 backbone swaps` and old orders stay findable.
Commands: **OVEN: New Cart Session**, **OVEN: Switch or Manage Cart Sessions**.

### Cross-referencing an existing inventory

Point `oven.inventoryPath` at an `.xlsx` or `.csv` of primers you have already
ordered and each cart row is flagged green (already in inventory, with its ID) or orange
(new). Matching is by exact sequence, ignoring case and whitespace.

**Your file only has to have two columns: a name and a sequence.** Everything else about
its shape is up to you — any column order, any extra columns, any sheet, any header
wording.

| setting | what it names | default |
|---|---|---|
| `oven.inventoryNameColumn` | the name or ID column | first column |
| `oven.inventorySequenceColumn` | the sequence column | second column |
| `oven.inventorySheet` | which sheet, for a workbook | first sheet |
| `oven.inventoryAliasColumn` | an optional short second identifier | a column named `Alias` |
| `oven.inventoryDescriptionColumn` | an optional free-text column | a column named `Description` |

The two optional columns are exactly that — a file without them loads fine. The
description column can name **anything**: point it at `Purpose`, `Ordered by` or
`Freezer box` and that column appears as the last column of the search results, headed
with your own wording. When no such column exists the column is not drawn at all.

Columns you do not name are read past and ignored, so a spreadsheet with twenty columns
of ordering metadata works without being cut down first.

Header matching is exact first, then case-insensitive. A name or sequence column that
cannot be found is a hard error listing the headers actually present — inventory headers
routinely contain characters that are easy to mistype (`°`, `μ`), and a silent "no
matches" would read as "nothing in your inventory" when it means "I read the wrong
column".

If the inventory cannot be read, every row shows a grey **unknown** badge rather than
orange — a primer is never labelled "new" on the strength of a failed lookup.

The `.xlsx` reader is dependency-free and deliberately minimal (it reads two columns of
text). If it ever fails on a workbook, converting that sheet to `.csv` is the fastest
workaround.

## Primer search and attach

Click **Primer Search** in the editor, or right-click anywhere in the sequence and choose
**Search primers**. Results open as a **Primer Search tab beside the sequence map**, using
OVE's own split layout — so you can see exactly where each hit lands while you scan the
list, and drag the divider to resize. Clicking a row selects and scrolls to that binding
site, with a **light grey bar marking the strand** — above the letters for a top-strand
match, below them for a bottom-strand one. The same bar marks hits from OVE's own Find
tool, replacing the gold triangles it used to draw. Hits are sorted by position:

| Pos | Str | Name | Anneal | Tm | 5′ tail | Alias | |
|---|---|---|---|---|---|---|---|
| 325 | + | P_0048 | 25 nt | 72.4 | — | fwd screen | Attach |
| 1522 | + | P_0123 | 22 nt | 65.4 | +16 | gibson fwd | Attach |

Matching is **exact and 3′-anchored**: a primer counts as binding if enough bases at its
3′ end match the template, so primers carrying a 5′ Gibson tail, restriction site or
barcode are found even though their full sequence appears nowhere in the plasmid. The
unmatched tail is reported in the **5′ tail** column. Tick **100% match only** to hide
anything with a tail.

Scoping to a selection is what makes this usable — a whole 10 kb plasmid can legitimately
return hundreds of hits, while a 200 bp selection returns a handful. A primer is kept when
its **3′ end** lands inside the selection; the rest of the match may extend outside it,
which is what you want when checking whether an existing primer can prime from a chosen
point.

**Attach** adds a `primer_bind` annotation over the annealing footprint only, with the
full ordered sequence (tail included) stored on the primer and written out as a
`/Sequence` qualifier, so nothing about the oligo you'd actually order is lost. As with
Create → New Primer, press **Save** to write it to the file. Attaching is not undoable
with Cmd+Z; remove it from Properties → Primers instead.

Clicking a row scrolls the sequence view to that binding site.

Drag the divider at the right of any column header to resize it, and double-click a
divider to restore the defaults. Widths are remembered across files and sessions. If the
columns total more than the pane, the table scrolls sideways rather than hiding anything.

Configure the inventory with `oven.inventoryPath` (or **OVEN: Choose Primer
Inventory File…**, also offered inline the first time you search). Tuning:
`oven.searchMinAnneal` (default 15), `oven.searchFullLengthOnly`,
`oven.searchMaxHits`, and the optional `Alias` / description columns described under
[Cross-referencing an existing inventory](#cross-referencing-an-existing-inventory).

## Alignment

Click **Align** in an open plasmid. That plasmid becomes the reference. `.ab1`, `.gb`,
`.gbk` and `.fasta` are all accepted, and a FASTA holding several records becomes one
track per record. There are four ways to add reads:

- **Right-click the files in the Explorer → Add to Alignment.** Handles a multi-selection,
  and is the one route nothing can get in the way of.
- **Browse…** in the panel.
- **Paste.** Copy the files in Finder, click the panel, press `Cmd+V`.
- **Drag and drop** onto the panel, **holding ⇧ Shift**. Shift matters: without it VS Code
  lays its own drop overlay across the editor area as soon as a drag enters the window, and
  opens what you drop as a new tab instead of handing it to the panel. That overlay belongs
  to the workbench, not to this extension, and an extension cannot turn it off — holding
  Shift dismisses it. Dropping without Shift can still work if the pointer enters the window
  directly over the panel and touches no other part of the editor on the way, which is why
  it tends to work full-screen and fail in a smaller window.

The reference sits along the top with its annotations and translations; each read gets its
own row, showing its chromatogram when it has one and just its bases when it does not, so a
GenBank read aligns perfectly happily without a trace. Differences are highlighted in the
rows and marked in the summary strip at the bottom.

Each read is given one of three verdicts in the panel above:

| | meaning |
|---|---|
| **match** (green) | perfect, and covers the reference end to end |
| **partial match** (gold) | perfect over the window it covers, but only part of the reference |
| **mismatch** (red) | something differs |

A Sanger read covers a window, so it can only ever reach **partial match**; only
whole-plasmid sequencing turns the whole reference green. One wrong base is a mismatch
whatever the coverage. Hover a read for its coverage, substitution and gap counts,
identity, strand, and how far it was rotated to cross the origin.

### Installing MAFFT

MAFFT does the alignment and must be installed separately:

```bash
brew install mafft                      # macOS
conda install -c bioconda mafft         # any platform
```

The panel checks for it **when it opens**, not when you press Align, so you find out before
choosing any files. If it is missing you get a banner with both commands, a **Locate
MAFFT…** button that saves the path for you, and **Re-check**.

You normally do not have to configure anything. The extension looks on your `PATH` first,
then in the places Homebrew and conda actually install to — including **named conda
environments**, which are never on VS Code's `PATH` and are the usual reason a working
`mafft` in the terminal is invisible to the editor.

Two things worth knowing if it is still not found:

- **VS Code reads your `PATH` when it starts.** Installing MAFFT while the editor is open
  leaves it invisible until you reload the window.
- `conda install` into an environment other than `base` puts the binary somewhere the login
  shell never sees. The search covers `~/miniforge3`, `~/miniconda3`, `~/anaconda3` and
  `~/mambaforge` and their `envs/*`, but if yours lives elsewhere use **Locate MAFFT…** or
  set `oven.mafftPath` by hand.

Run **OVEN: Check MAFFT Installation** at any time to see which binary was found and
what version it is. Use `oven.mafftArgs` (default `--auto`) to choose a strategy —
`--localpair --maxiterate 1000` for L-INS-i accuracy, say. `--adjustdirection` is always
passed, so a read given in the wrong orientation is flipped rather than reported as garbage.

**Reads that cross the origin are handled.** MAFFT has no notion of circular topology, and
a full-plasmid read starts wherever the assembler happened to break it. Each read is
therefore k-mer anchored and rotated into the reference's frame before alignment, with its
chromatogram rotated to match so the peaks still sit over their own bases. On a real
4489 bp plasmid this is the difference between 0 mismatches and 2140. The reference is
never rotated, so every position stays in its coordinates.

Trace ends below `oven.alignTrimQuality` (default 20) are trimmed first, so a noisy
Sanger tail does not drown the mismatch count; set it to `0` to align the full read.
`oven.alignMaxReads` (default 50) caps one alignment.

## Selection readout

Open Vector Editor has **Melting Temp of Selection** and **Percent GC Content of
Selection** status-bar items, both off by default. `oven.showSelectionStatsByDefault`
(on) switches them on the first time you open a sequence; toggling them yourself in the
**View** menu afterwards always wins.

`oven.useDesignTmCalculation` (on) substitutes the number in that melting-temp item
with the NEB Q5 nearest-neighbour Tm a primer-design pipeline targets — 200 nM primer
with a 1.5 mM Mg²⁺ correction — instead of OVE's own figure at 500 nM with no Mg. The
difference is small but real; on a 22 bp region OVE reports 64.6 where your pipeline
says 64.5. Turn it off to get OVE's stock behaviour back.

Selecting a region gives you, in one line:

```
DNA | Editable | Selecting 22 bps from 101 to 122 (45.5% GC) | Melting Temp: 64.5 | Length: 6537 bps
```

Over 100 bp it shows `Melting Temp: — (>100 bp)` rather than a figure that means nothing:
the nearest-neighbour model is a primer model.

## Other features

- Supports `.dna`, `.fa`, `.fasta`, `.gb`, `.gbk`
- Select a DNA file → Open With → OVE (can be set as the default)
- Save with **File > Save** or `cmd/ctrl+S` (all formats, including `.dna`)
- Command **Open Vector Editor: Open Demo Editor** (`oven.showEditor`) opens a
  scratch editor whose contents persist across tab switches

## Known issues

Inherited from upstream:

- Content in a file-backed editor does not persist when you switch to another tab; only
  the editor opened via `oven.showEditor` retains its contents.
- `.dna` files: primers in the file are displayed and preserved on save, but **new**
  primers created in the UI are not written back to `.dna`. Use `.gb` if you need that.
  (The Primer Cart is unaffected — it holds primers regardless of what the file can store.)

## Release notes

See [CHANGELOG.md](CHANGELOG.md).
