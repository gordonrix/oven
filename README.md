# Open Vector Editor + Primer Cart

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

Changes made in this fork:

- **Primer Cart** — a sidebar panel that accumulates primers across plasmid files, with
  copy-as-TSV, copy-sequences, and CSV export, plus optional cross-referencing against
  your own primer inventory spreadsheet.
- **The editor is no longer read-only by default.** Upstream never overrode OVE's
  `readOnly` default of `true`, which hid every item in the **Create** menu — so
  "Create → New Primer" appeared as an empty popup. Base editing stays locked separately
  via `oveCart.allowSequenceEditing`, so annotations work without risking the sequence.
- Removed ~10 MB of dead artifacts (a superseded bio-parser bundle, a duplicate
  stylesheet, two committed `.vsix` files) and an unused `react` dependency.
- Renamed the extension identity and custom-editor `viewType` so it can be installed
  alongside, or instead of, the Marketplace original.

## Installation

Not published to the Marketplace. Build and sideload:

```sh
npm install
npm run package
code --install-extension ove-vscode-primer-cart-1.3.0.vsix --force
```

If you have the original `sanekun.openvectoreditor` installed, uninstall it — otherwise
both will offer to open `.gb` files and "Reopen Editor With…" will show two OVE entries.

## Using the Primer Cart

1. Open a plasmid file. Select a region and use **Create → New Primer**, or use an
   existing primer already annotated in the file.
2. Click **Cart** in the top-right of the editor to pick primers to add. Primers you
   create are added automatically (`oveCart.autoAddCreatedPrimers`).
3. Repeat in as many plasmid files as you like — the cart is global and persists across
   restarts.
4. Click **Open cart** at the top of that picker (or run **Primer Cart: Show Cart**) to
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
Commands: **Primer Cart: New Session**, **Primer Cart: Switch or Manage Sessions**.

### Cross-referencing an existing inventory

Point `oveCart.inventoryPath` at an `.xlsx` or `.csv` of primers you have already
ordered and each cart row is flagged green (already in inventory, with its ID) or orange
(new). By default the first column is the name and the second is the sequence; override
with `oveCart.inventoryNameColumn` / `oveCart.inventorySequenceColumn`. Matching is by
exact sequence, ignoring case and whitespace.

If the inventory cannot be read, every row shows a grey **unknown** badge rather than
orange — a primer is never labelled "new" on the strength of a failed lookup.

The `.xlsx` reader is dependency-free and deliberately minimal (it reads two columns of
text). If it ever fails on a workbook, converting that sheet to `.csv` is the fastest
workaround.

## Primer search and attach

Click **Primer Search** in the editor, or right-click the sequence (or a selection) and
choose **Search primers**. It matches your inventory against the open plasmid and lists
every primer that binds, sorted by position:

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

Configure the inventory with `oveCart.inventoryPath` (or **Primer Cart: Choose Primer
Inventory File…**, also offered inline the first time you search). Tuning:
`oveCart.searchMinAnneal` (default 15), `oveCart.searchFullLengthOnly`,
`oveCart.searchMaxHits`, and optional `oveCart.inventoryAliasColumn` /
`inventoryDescriptionColumn` (auto-detected from `Alias` / `Description` headers).

## Other features

- Supports `.dna`, `.fa`, `.fasta`, `.gb`, `.gbk`
- Select a DNA file → Open With → OVE (can be set as the default)
- Save with the custom Save button (all formats, including `.dna`)
- Command **Open Vector Editor: Open Demo Editor** (`oveCart.showEditor`) opens a
  scratch editor whose contents persist across tab switches

## Known issues

Inherited from upstream:

- Content in a file-backed editor does not persist when you switch to another tab; only
  the editor opened via `oveCart.showEditor` retains its contents.
- `.dna` files: primers in the file are displayed and preserved on save, but **new**
  primers created in the UI are not written back to `.dna`. Use `.gb` if you need that.
  (The Primer Cart is unaffected — it holds primers regardless of what the file can store.)

## Release notes

See [CHANGELOG.md](CHANGELOG.md).
