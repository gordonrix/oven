# Change Log

All notable changes to the "openvectoreditor" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## 1.20.0

**The primer search table is yours to configure.** A **Columns** dropdown sits between
"100% match" and the filter box. Two kinds of column are offered:

- computed from the match — `Anneal bp` (was `Anneal`), `Tm`, `Tail`
- **every column of your inventory file**, under its own header

That second half is new. Before, only a column named `Alias` and one named `Description`
could ever reach the table; a spreadsheet's `Date ordered`, `Dissolved in` or
`Designed by` were read past and discarded. Now every header that is not the name or the
sequence is available.

`Pos`, `Str`, `Name` and the **Attach** button cannot be turned off — a table without them
is not shorter, it is broken. The choice persists across files and sessions, and **Reset to
defaults** restores it.

The default is `Anneal bp`, `Tm`, `Tail` and your **alias** column — deliberately the alias
rather than the first extra column, because a real inventory's first extra column is
usually `Length` or a date.

The filter box now searches every inventory column, including ones you are not showing.

**Melting temperature defaults to SantaLucia.** Open Vector Editor ships Breslauer as the
default; the unified SantaLucia (1998) parameters are what NEB's calculator uses, so the
stock default had the status bar disagreeing with every other number on the bench. Still
switchable from the popover, and a choice you have already made still wins.

Column widths are now keyed by column rather than by position, since which columns exist
depends on the inventory file. Any widths saved by an earlier version are discarded once.

The README has been cut roughly a third and rewritten for someone who has never seen the
extension: implementation notes, upstream-bug archaeology and settings that no longer exist
are gone, and everything about how this differs from upstream is confined to one section.

## 1.19.1

**Fixed: the status bar showed a melting temperature for selections that cannot have
one.** Selecting a single base read `-294.7`, a whole 6 kb plasmid read `102.4`, and
selecting nothing at all read a confident `0`. Outside 8–100 bp the status bar now shows
`—`.

This was a regression in 1.18.0. The bounds lived in `media/selectionTm.js`, which that
release deleted along with our own Tm calculation — Open Vector Editor's `calculateNebTm`
has no length guard of its own and its status bar renders `Number(tm) || 0`, so every
out-of-range selection got a number anyway. The guard is now patched into OVE's
`MeltingTemp` instead, where it cannot be separated from the thing it guards, and
`test/browser/nativeTm.mjs` walks 1, 5, 8, 20, 100, 101 and 2000 bp plus the empty
selection on every run.

The lower bound matches the one used by the analysis scripts, so both refuse the same
sequences.

## 1.19.0

**Adding reads to an alignment no longer depends on drag-and-drop.** Right-click any
`.ab1`/`.gb`/`.gbk`/`.fa`/`.fasta`/`.dna` files in the Explorer — a multi-selection is fine —
and choose **Add to Alignment**. If several alignment panels are open it goes to the one you
are looking at, or asks. You can also copy files in Finder and paste into the panel with
`Cmd+V`.

Both exist because dragging is not ours to fix. The moment a drag enters the VS Code window
over any part of the editor chrome, the workbench lays a drop overlay across the whole editor
area and opens what you drop as a new tab; the webview underneath never sees it. Holding
**⇧ Shift** while dragging dismisses that overlay, which is why a drop can work in a
full-screen window — where the pointer can reach the panel without crossing anything else —
and fail in a smaller one. The drop hint in the panel now says so.

**Renamed to OVEN — Open Vector Editor with New Features.** All of the identifiers moved
at once, which is only safe because nothing is published yet:

| was | is |
|---|---|
| extension ID `gordonrix.ove-vscode-primer-cart` | `gordonrix.oven` |
| settings `oveCart.*` | `oven.*` |
| commands `oveCart.*` | `oven.*` |
| custom editor viewType `oveCart.editor` | `oven.editor` |

**If you used an earlier build, two things need re-pointing by hand:** any `oveCart.*`
entries in your `settings.json` (rename the prefix), and any
`workbench.editorAssociations` mapping to `oveCart.editor`. Cart sessions and the
cut-site filter live in the extension's own storage, which is keyed by extension ID, so
those start empty — there is no migration, deliberately, since publishing an ID is
irreversible and doing this afterwards would have stranded real users.

Command palette entries are now all under one **OVEN:** category, instead of the mix of
"Primer Cart:" and "Open Vector Editor:" prefixes that had accumulated. The GitHub repo
moved to `gordonrix/oven` — the old URL redirects.

**The primer search now has a description column.** `oven.inventoryDescriptionColumn` was
already able to name any column in your inventory, but whatever it found only ever showed
up in a tooltip. It is now the last column of the results, headed with the wording from
your own file — point it at `Purpose`, `Ordered by` or `Freezer box` and that is what the
header says. Files without such a column are unaffected: the column is not drawn at all
rather than sitting there empty.

Also in this release: a Marketplace icon.

## 1.18.0

**Our melting-temperature calculation is gone.** It carried the wrong nearest-neighbour
parameters for the GC dinucleotide — CG's values (−10.6 / −27.2) instead of GC's
(−9.8 / −24.4) — so it could not tell `GCGC…` from `CGCG…` and read 12 °C low on a
GC-alternating 20-mer.

Everything that showed a Tm — the cart, primer search, the status bar — now uses Teselagen's
`calculateNebTm`, ported into `media/cartShared.js` so the extension host and the webview share
one implementation. That is the NEB model as Teselagen implements it: a monovalent salt
correction applied to 1/Tm, **no Mg²⁺ term**, and `R·ln(Ct)` with a 500 nM default.

Removed with it: `media/selectionTm.js` (the status-bar override), `oveCart.useDesignTmCalculation`,
and the unit suite pinning the old calculation against its Python reference. The Tm type radio
is now a straight Breslauer/SantaLucia choice with no custom code behind it.

Expect primer Tms to read a little differently — that is the point.

## 1.17.0

- **The status bar shows Open Vector Editor's own melting temperature.** Cross-checked against
  20 sequences of 15–45 nt: at matched primer concentration ours ran about 1.2 °C from theirs,
  and the gap traced partly to a real error on our side — our nearest-neighbour table gives the
  **GC** dinucleotide the same ΔH/ΔS as **CG** (−10.6 / −27.2), where the published values are
  −9.8 / −24.4. On a GC-alternating 20-mer that is a 12 °C error.

  `oveCart.useDesignTmCalculation` now defaults off, so nothing overrides OVE. Turning it back
  on restores the previous behaviour.

## 1.16.0

- **The cart's copy button copies just names and sequences.** It emitted all nine columns —
  length, Tm, source file, coordinates, strand, inventory state, note — which meant deleting
  seven of them by hand after pasting into a two-column order form. Everything else is
  derivable or irrelevant once a primer is being ordered. The button now reads
  **Copy names + seqs**.

  The full set is still one click away as **Export CSV**, which is the path for archiving a
  cart rather than ordering from it — and the tests that pinned inventory state and origin-wrap
  coordinates moved there with it.

## 1.15.1

- The Tm type options read **Breslauer** and **SantaLucia**. They were "Default Tm (Breslauer)"
  and "NEB Tm (SantaLucia)" — "Default" stopped being true once SantaLucia became the seeded
  choice, and "NEB" invited comparison with NEB's own calculator, which applies a Q5-specific
  offset and different salt and concentration terms and so does not agree. The author names are
  the part that is accurate.

## 1.15.0

Melting temperature:

- **The "Choose Tm Type" radio does something now.** OVE's Tm popover offers Breslauer or
  SantaLucia and persists the choice, but this extension rewrote the number on every render
  regardless — so the radio changed the underlying value and nothing on screen ever moved. It
  looked broken because it effectively was.

  The two are lined up honestly instead: our figure *is* SantaLucia — NEB Q5, with the Mg²⁺ and
  primer concentrations the design pipeline uses — so it stands in for that option, and
  Breslauer is left to OVE. The radio moves the number both ways.
- **The choice persists across sessions.** OVE already stores it in localStorage; the fix was
  to stop ignoring it, so there is no second mechanism to keep in step. SantaLucia is seeded
  once on first run so the design Tm is still what you get out of the box — seeded once and
  remembered, because OVE writes `tmType: "default"` eagerly and "a value is present" cannot
  otherwise be told apart from someone deliberately choosing Breslauer.
- **No more negative melting temperatures.** The nearest-neighbour model is two-state and falls
  apart on short oligos — it read −0.5 °C at 6 nt and −161 °C at 2. Under 8 bp the status bar
  now declines instead of printing a number, the same way it already did over 100 bp.

  The guard is in the readout, not in `tmNebQ5`: that function is a faithful port of the
  reference implementation the primer pipeline designs against, and a unit test pins the two
  together down to a dinucleotide. Changing the calculation to fix a display problem would have
  broken that agreement, which is the more valuable property.

## 1.14.2

- **A primer's arrowhead is drawn past its last base, not carved out of it.** Upstream puts the
  tip at the annotation's width and the arrowhead's base *inside* it, so the last nucleotide or
  two sit in the taper with no background behind them — which reads as the primer stopping
  short of the bases it covers, and got worse as soon as the point was sharpened. The
  full-height box now runs the whole width and the point is added on. Features are unchanged.

## 1.14.1

**The ribbon is gone; primers keep OVE's arrowhead, sharpened.** 1.14.0's ribbon was more
trouble than it was worth. Instead, a primer's arrowhead goes from `arrowPointiness` 0.2 to
0.55 — upstream's value is so blunt the primer reads as a plain box and its direction is easy
to miss. Features sit at 1.0; this lands between the two, pointed enough to read at a glance
without making a primer look like a feature. One constant, no shape logic.

## 1.14.0 (superseded by 1.14.1)

**Primers are drawn with a ribbon instead of an arrowhead.** The body is a plain box; a thick
band leans up and to the left off its corner, and that band is what carries the direction. A
triangular arrowhead is easy to miss at a glance, and at low zoom it is only a few pixels wide.

- Reverse primers are a true 180° rotation, so their band leans down and to the right. OVE
  mirrors the forward path horizontally for reverse annotations, which would have put the band
  up-and-right instead — primers get `scale(-1,-1)` and a compensating translate.
- Only the two range types that actually draw an arrowhead are replaced: a primer that fits in
  one row, and the last row of one that does not. A first or middle row has no 3′ end on it and
  keeps OVE's continuation curves, so a primer crossing a row boundary still reads as
  continuing rather than sprouting a second band.
- Features and parts are untouched — they share the same renderer, so the change is keyed on
  the annotation type. The circular view has its own primer renderer and is unaffected.

## 1.13.3

- **Reverse-strand primers are spaced off the sequence.** Both primer tracks get the same 5px
  from OVE, but the forward one also has a labels container above it, so the bottom read as
  much tighter than the top. The reverse track — told apart by sitting after the letters
  rather than before them — now gets 9px.

  The margin goes on the track and not as padding on the letters, deliberately:
  `media/strandBar.js` derives the reverse strand-indicator bar's position from the letters'
  `offsetHeight`, so padding there would push the bar off the letters it is meant to hug.
  `!important` is needed because OVE writes the 5px as an inline style.

## 1.13.2

- The active Find match is a light grey wash rather than green. Green on a plasmid reads as an
  annotation colour rather than as "you are here".

## 1.13.1

- **A codon change can be undone.** It went through `updateEditor`, which replaces the editor's
  state wholesale — that is how a file is loaded, not how it is edited — so the change sat
  outside OVE's undo stack and `cmd+Z` did nothing to it. It now goes through OVE's own
  `updateSequenceData`, taken from the props handed to the right-click override, so undo and
  redo both work.

  That also removes the `stateTrackingId` bookkeeping 1.13.0 needed: a real edit action marks
  the document dirty by itself, so File > Save still greys out when clean and lights up after a
  change without being told to. If OVE ever stops handing that action to the override, the menu
  item is not offered at all rather than making an edit that cannot be taken back.

## 1.13.0

**Saving is now OVE's own File > Save, with its `cmd/ctrl+S` hotkey.** The bolted-on Save
button in the top-right is gone.

OVE has always had a Save item; it *hides* it unless an `onSave` prop is passed, and upstream
never passed one — which is why saving needed a button of our own. With it wired up, the item
also greys itself out when there is nothing to save, which the button could never do.

One wrinkle worth recording: OVE decides that from `sequenceData.stateTrackingId`, and treats an
`updateEditor` payload as a fresh load rather than an edit. So a programmatic edit — Change
Amino Acid is the only one — advances the id deliberately, or it would leave Save greyed out as
though nothing had changed.

Primer cart:

- **The toolbar button is "Primer Cart"** and opens both halves at once: the picker for the file
  you are in, and the cart panel beside it. It was "Add to Cart (N)", which opened only the
  picker and left the cart itself to be found from the command palette.
- **Select all is a tick box**, so it clears the selection as well as making it — it was a
  button that could only ever add. It follows the filter, and shows an indeterminate state when
  only some rows are picked.
- **Removing a primer no longer asks for confirmation.** It destroys nothing: the primer is
  still on the sequence and can be added again from the same file. Clearing a whole session
  still asks.

Primer search:

- **A close control on the panel.** OVE offers no way to dismiss a panel it did not add, so the
  search panel carries its own — and un-splits the view rather than leaving an empty half
  beside the sequence.

## 1.12.4

- The four fields in a codon cell are labelled — Codon, AA, Frac., Freq. — under the leftmost
  block only, since the columns repeat. The labels are centred over their columns rather than
  following the alignment of the values beneath, which is left for codons and right for numbers.

- **README: a "What this fork adds" summary.** The fork notice listed four changes and had not
  been touched since v1.3, so it mentioned none of the primer search, alignment, chromatogram,
  Change Amino Acid or correctness work. Grouped by what each thing is for rather than by
  release, since the changelog already covers release order.

## 1.12.3

- **The E. coli codon table was wrong about stop codons.** Kazusa has several E. coli entries;
  the obvious one, K-12 (taxid 83333), is built from too few CDSs to contain an amber stop and
  reports TAG at a fraction and frequency of exactly zero — which reads as "E. coli never uses
  TAG". Replaced with W3110, the same organism from 4,332 CDSs, where TAG is 0.07 and 0.2 per
  thousand. The source link points at that table.

  This slipped through because it passes a fractions-sum-to-one check: the other two stops
  absorb the missing share. `test/unit/codonUsage.test.js` now checks every table against an
  independently built genetic code, for family sums, and that **no codon is reported as never
  used** — which is what catches a table too sparse to ship. The other three organisms were
  re-checked and are clean.
- The codon cells are a very light grey rather than the printed table's tan, with 2px rules
  around each block of four carried through the axis headers so the divisions line up with the
  letters that name them.

## 1.12.2

- **Change Amino Acid is laid out as a genetic-code table.** First base down the side, second
  across the top, third within each block, T/C/A/G throughout rather than alphabetical — so an
  amino acid's codons are the block they sit in. Every codon keeps its own amino-acid label:
  printed tables bracket a block and name the residue once, which is compact on paper but
  leaves a row meaning nothing on its own, and here every row is something you click.
- **An edited codon is written in the case that stands out from its neighbours**, so it can be
  found in the sequence afterwards. The case comes from the codons either side, not from the
  bases being replaced: flipping a codon's own case works until two adjacent codons are both
  edited, at which point the second flips relative to the first and the pair ends up in
  opposite cases with neither reading as the edit. Neighbours that disagree, or an edit with
  nothing cased around it, give upper. Nothing downstream reads case.

## 1.12.1

- **Change Amino Acid shows the whole genetic code.** 1.12.0 listed only the synonymous codons
  for the residue you clicked, which makes the dialog a codon-optimisation tool and nothing
  else — the common case is mutating the residue itself, and that was unreachable. All 64
  codons are now laid out as a printed codon table is: four columns, one per middle base,
  alphabetical within each, ruled into blocks of four so an amino acid's codons sit together
  and the wobble position is the one that varies.
- Three-letter / single-letter is a pair of radio buttons; the organism dropdown carries full
  species names; the source line links to the specific Kazusa table for the organism showing.
  Fractions and frequencies print without trailing zeros, as the published tables do, and stop
  stays an asterisk in both notations rather than becoming "Stop" in a column of residue codes.

## 1.12.0

**Change Amino Acid.** Right-click a residue in a translation and pick a different codon for
it, with codon usage for the organism you are expressing in shown alongside: *S. cerevisiae*,
*E. coli*, *H. sapiens*, *M. musculus*, from the Codon Usage Database (Nakamura et al. 2000).
Codons are listed commonest first with their fraction and per-thousand frequency, the one in
use is marked, and there is a three-letter/single-letter toggle. Choosing one rewrites those
three bases; **Save** writes it to the file, as with any other edit.

- **DNA base editing is now on by default** (`oveCart.allowSequenceEditing`). It has to be —
  the menu entry would otherwise appear and silently do nothing.
- The strand and origin arithmetic is in `media/codonEdit.js`, apart from the dialog and unit
  tested. That is where the danger is: a reverse-strand CDS displays the reverse complement of
  what is stored, so a codon picked in reading orientation has to be complemented back before
  it lands, and on a circular plasmid a codon can straddle the origin, where `codonRange.start`
  is greater than its `end` and a plain slice silently takes bases from the wrong place. Both
  round-trip in the tests.
- OVE hands a right-click the whole translation rather than the residue, so the residue is read
  from the element under the cursor. If it cannot be read, the menu entry is not offered at all
  rather than offered pointing at the wrong codon.
- Only the fraction and frequency are stored per organism — which amino acid a codon encodes is
  derived from the genetic code, so the two cannot disagree. Every table was checked against
  that code, and each amino acid's fractions checked to sum to 1, before being written.

## 1.11.5

- **Filter Cut Sites is remembered between sessions.** OVE resets the enzyme filter to "Single
  cutters" on every mount, so a set of enzymes had to be re-picked for every file. The choice
  (and the and/or flag beside it) is kept in `globalState` — it follows you between projects,
  same reasoning as the cart — and applied in the boot script, so the filter is right on the
  first render rather than flickering through the default.

  The editor handle exposes only `getState`, with no store to subscribe to, so the client reads
  the filter shortly after any interaction that could have changed it and posts only when the
  value actually differs. A timer polling forever for a setting that changes a few times a day
  seemed the wrong trade.
- `media/codonUsage.js`: codon usage tables for *S. cerevisiae*, *E. coli*, *H. sapiens* and
  *M. musculus*, from the Codon Usage Database (Nakamura et al. 2000). Groundwork for the
  Change Amino Acid dialog; nothing loads it yet. Only the fraction and frequency are stored —
  which amino acid a codon encodes is derived from the genetic code, so the two cannot
  disagree — and every table was checked against that code, with each amino acid's fractions
  checked to sum to 1, before being written.

## 1.11.4

Alignment viewer:

- **The pinned reference is OVE's own, so there is one selection again.** 1.11.1 rendered a
  second one-track alignment view above the scroller. It looked right, but a second view
  carries its own redux store — so it had its own selection, and highlighting in one did
  nothing to the other. OVE already has this: `hasTemplate` renders track 0 into
  `.alignmentTrackFixedToTop` with its own scroll holder, keeps that holder in step
  horizontally, and offsets the virtualised list's indices so nothing is drawn twice. It was
  written for the template row in pairwise mode but is not pairwise-specific. Same view, same
  store, one selection — and about 90 lines of our own scaffolding deleted.
- OVE rules its template track in red, which is the mismatch colour everywhere else in this
  panel, on the one track that cannot mismatch. It is a plain divider now.
- **19px of white above every chromatogram is gone.** A literal `<br>` sits above each trace in
  OVE's markup, clearing the two scale buttons — which are hidden here, since the amplitude
  control in the top bar drives every track at once. With a dozen reads on screen that line box
  was taking more room than the traces. Each row is 62px now instead of 80px.

## 1.11.3

Main viewer:

- **Align / Primer Search / Add to Cart / Save are menu-bar items now**, not coloured pills:
  black text, no background, the same 14px Arial in a 30px box that File/Edit/View use, and
  Blueprint's own hover wash. They read as part of the editor rather than as a toolbar bolted
  on top of it.
- **The row is right-aligned to OVE's menu bar instead of to the window.** `position: fixed`
  measures from the webview viewport, and OVE's content stops short of it — there is a gutter
  down the right-hand side — so Save hung past the toolbar it is meant to sit in. The gutter is
  measured at runtime (`media/toolButtons.js`) and the row sits 12px inside the bar's edge.
- New `media/EditorDemo.html`: the first demo page that mounts OVE's actual editor, so its menu
  bar, right-click menus and redux state can be driven from the browser suite.

## 1.11.2

- **Chromatograms scale from the upper quartile of called-base peaks, not p95.** Measured over
  157 real Genewiz reads: p95 fixed the two files whose dye front saturates the detector, but
  left four failed reads — where the called-peak spread is 12×–23×, so p95 sits inside the dye
  front itself — drawn at 1.6–3.2px of 58. The typical peak now draws at 24.5px against 16.1px,
  no file is left under 5px (p95 left five), and 4.3% of peaks clip at the top of the track
  against 0.4% — which is what a chromatogram is supposed to look like. Working shown in
  `notes/chromatogram-fit-scale.md`.
- `scripts/patches.js check` now refuses a vendored bundle that does not parse. A hand edit
  that closes a comment in the wrong place does not fail loudly — the bundle silently stops
  publishing its exports — so it was worth catching at the patch gate rather than several
  steps downstream.

## 1.11.1

Alignment viewer:

- **The pinned reference actually stays pinned.** 1.11.0 used `position: sticky`, which
  cannot work here: OVE virtualises the track list, so once you are a few reads down the
  reference is not merely off screen, it is unmounted — there is no element left to stick,
  which is why the pin appeared to jump onto a read. It is now a second, one-track alignment
  view above the scroller, with its column position driven by the main view's.
- **One alignment window per reference**, titled with the reference name. Aligning against a
  different plasmid opens its own window instead of landing in one still holding the last
  reference's reads, and two references can be compared side by side. Pressing Align again on
  the same plasmid still reuses its window and keeps the results already on screen.
- **Traces with very few samples per base are smoothed.** Some writers emit four samples per
  base with square shoulders; drawn as straight lines that is a flat-topped rectangle rather
  than a peak. Traces with enough samples to describe their own shape are left untouched.

## 1.11.0

Alignment viewer, from using it:

- **The reference stays pinned** while you scroll through reads. Only the top is pinned, so
  it still scrolls sideways in step with them — a reference frozen in both axes would line
  its bases up against the wrong columns.
- **Two controls in OVE's own top bar, beside the eye.** A slider for the height of every
  chromatogram window, with an icon each side, and up/down/fit for peak amplitude next to a
  trace icon. Changing the window height re-fits the traces so they keep filling it. These
  replace the trace-height control that used to sit above the view.
- **Shift+scroll scrolls the alignment sideways.** The browser only does this for the
  document scroller, so inside OVE's own overflow container it did nothing.
- **The sequence list collapses**, showing "N sequences". It starts open, unlike the
  Add sequences picker.

## 1.10.1

- **Chromatogram quality-score bars removed.** They are switched off through OVE's own
  `showChromQualScores` toggle rather than patched, so this also deletes a bundle patch. The
  eye menu can turn them back on; the setting is seeded once, so doing that sticks.
- **Vendored-bundle patches are now managed rather than hand-applied.** The changes are kept
  as unified diffs in `patches/*.patch` — 220 reviewable lines instead of 8 MB — with a
  sha256 per bundle, and `node scripts/patches.js check` verifies all three agree. It runs
  in `pretest` and before packaging, so a re-vendored bundle now fails loudly instead of
  silently reverting every fix. `apply` re-applies them, `write` regenerates them.

## 1.10.0

- **A substitution inside a CDS now shows what it codes for.** The read gets a translation
  over just that codon, so the amino acid displayed is derived from the read's own bases --
  what the mutation actually makes, not what the reference said. Reading frame is taken from
  the correct end for a reverse CDS, origin-spanning CDS features are handled, and a codon
  broken by an indel is left alone rather than guessed. On the worked example: RFP
  CTG(L)→ATG(M) in one read, AraC CCG(P)→CAG(Q) in another.
- **The chromatogram track is shorter and the trace fills it.** It was a fixed 100 px with a
  fixed starting scale, so a trace either crawled along the bottom or ran off the top
  depending on the instrument. Now 58 px, with the scale seeded from the data so the tallest
  peak just reaches the top. Read rows dropped from 169 px to 115 px.
- **One trace-height control for every chromatogram**, in the panel chrome. Each track used
  to carry its own pair of buttons at a sticky offset partway across it, each moving only
  its own trace.
- **Fixed the mismatch marks in the summary strip**, which were too thick and ragged along
  the bottom. Widening them by stroking the path was wrong: those subpaths are never closed,
  so a stroke draws an open polyline and grows the mark past its own lane. Widened in the
  geometry instead — horizontally only, centred on the position.

## 1.9.5

- **Translations now show on the reference.** `translations` only covers translations that
  exist as their own annotations; the amino-acid track under a CDS is a separate toggle
  (`cdsFeatureTranslations`) and was still off, which is why a CDS showed no protein.
- **The coverage bars behind a chromatogram are confined to a band along the bottom.** They
  were normalised to the best base in the read, and Sanger quality is near-uniform across a
  good read, so nearly every bar filled the track and the peaks sat inside a solid grey
  slab. See [patches/README.md](patches/README.md); the trace itself is unchanged.
- Summary strip: lighter grey for the sequences, and a mismatch mark is stroked so a
  single-base difference is findable rather than one pixel wide.
- Reads are sorted by name, numerically where the name contains digits — so `_2` comes
  before `_10` instead of after `_1`.

## 1.9.4

- **Recoloured the summary strip.** Sequences are medium grey on light grey, and a mismatch
  is true red. Upstream drew the sequences light blue and washed the current viewport in
  translucent yellow with yellow rules top and bottom, which tinted everything beneath it --
  a red mismatch came out orange and the bars came out olive. The viewport is now marked
  with a neutral outline, so red is the only colour in the strip and means exactly one thing.

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
  origin — as a backbone primer with a 5' tail does.
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
