# Patches applied to the vendored bundles

`media/index.umd.js` (Open Vector Editor) and `media/bioparser2.umd.js` (Teselagen
bio-parsers) are prebuilt UMDs imported from the upstream VSIX — see the `vendor-1.2.0`
tag, which records a sha256 per imported file. There is no build-from-source path in this
repo, so the few fixes we need are applied to the bundles directly and recorded here.

## How these are managed

The changes live in three places, which have to agree:

| | |
|---|---|
| `media/*.umd.js` | the bundles, stored **already patched**, so a clone and `vsce package` both just work |
| `patches/*.patch` | the same changes as unified diffs — 220 reviewable lines instead of 8 MB |
| `patches/bundles.json` | sha256 of each patched bundle |

`node scripts/patches.js check` verifies all three agree, and runs in `pretest` and
`prepackage`. It reverse-applies each patch (proving the file contains exactly what the
diff describes) and checks the hash (catching any edit outside the patched regions, which
reverse-apply alone would wave through). Its three failure messages are distinct on
purpose, because the fixes differ:

- **checksum mismatch** — something changed the bundle outside the patches.
- **"patches are NOT applied"** — a pristine bundle was dropped in. Run
  `node scripts/patches.js apply`.
- **"patched regions do not match"** — a newer bundle, or a stale patch. Needs a human.

**After deliberately changing a patch**, run `node scripts/patches.js write` to regenerate
the diffs and hashes from the `vendor-1.2.0` baseline, or the three will disagree.

**After re-vendoring a bundle**, run `apply`, then re-run `node --test 'test/unit/*.test.js'`
and the browser checks in `test/browser/`. Every patch below is covered by a test that fails
if it goes missing — that is what turns a silent regression into a red suite.

---

# `media/index.umd.js`

## 1. Origin-spanning primers lost every base (`getStructuredBases`)

**Symptom.** A primer annotated across the origin — `join(4113..4130,1..17)` — rendered as
an empty hatched box with none of its letters, and the console filled with
`<text> attribute textLength: A negative value is not valid. ("-4")`.

**Cause.** `getStructuredBases` converts the row's slice of the annotation into an offset
within the primer's own bases:

```js
const aRange = {
  //tnr: this probably needs to be changed in case annotation wraps origin
  start: annotationRange.start - start2,
  end: annotationRange.end - start2
};
```

Upstream's own comment calls it. When the annotation wraps, `annotationRange.start` is
smaller than the annotation's `start`, so both offsets go negative — for the primer above,
`0 - 4112 = -4112`. `getSequenceWithinRange` bails on a negative range and returns `""`,
so the base list is empty and `charWidth * 0 - fudge - fudge2` lands at exactly `-4`.

**Fix.** Normalise both offsets modulo the sequence length. This is a no-op for any
non-wrapping annotation, where the offset is already in `[0, sequenceLength)`, so only the
broken case changes:

```js
const veWrapLen = sequenceLength > 0 ? sequenceLength : 0;
const veNormOffset = (v) => veWrapLen ? (v % veWrapLen + veWrapLen) % veWrapLen : v;
```

Also clamped the sibling `textLength` so an empty base list can never emit a negative
attribute again — matching the insert path a few lines below, which already clamps:

```js
const textLength = Math.max(0, charWidth2 * basesNoInsertsWithMetaData.length - fudge - fudge2);
```

**Not patched here:** the same wrapping annotation was also drawn *twice*, because
`mapAnnotationsToRows` maps an annotation once for its own span and again for each entry in
`locations`, and the parser expresses an origin wrap in both forms at once. That one is
handled in our own code instead — `dropRedundantWrapLocations` in `media/cartShared.js` —
so a genuine spliced join keeps rendering per exon. It is display-only and is undone by
`restoreWrapLocations` before anything is written back to disk; see
`test/unit/wrapLocations.test.js`.

## 2. A one-base difference was invisible in the summary strip (`Minimap.renderItem`)

**Symptom.** A single substitution left no visible mark; stroking the path to widen it made
the mark taller than its own lane and left ragged ends.

**Cause.** Each mismatch is drawn at its true width, which at minimap scale is a fraction of
a pixel for one base. The obvious CSS fix does not work: these subpaths are written as four
points with no closing `Z`, so a stroke traces an open polyline -- no left edge, visible
caps -- and expands vertically as well as horizontally.

**Fix.** Widen in the geometry instead, horizontally only and centred on the position:

```js
const w = Math.max(width2, 3);
const x = xStart - (w - width2) / 2;
```

## 3. Chromatogram height and scaling (`Chromatogram`)

**Symptom.** Each chromatogram was 100px tall with its own pair of scale buttons parked at a
sticky offset partway across the track, and started at a fixed scale of 0.05 regardless of
how tall that file's peaks were -- so several reads meant several controls in odd places and
traces that either crawled along the bottom or ran off the top.

**Fix.** Three changes, all in `Chromatogram`:

- the canvas is `OVE_CHROM_HEIGHT` (58) rather than a hardcoded `100`;
- scale is held in one module-level store shared by every chromatogram in the view, seeded
  by `oveFitScale` so the file's tallest peak just reaches the top of the track;
- `window.OveChromScale` exposes `set` / `nudge` / `reset` for a single control in the panel
  chrome. The per-track buttons still work -- they move all traces together now -- and are
  hidden in `media/alignView.css`.

An explicit `scalePct` prop still wins, so the linear editor keeps its own behaviour.

## 3a. A wide trace drew nothing at all (`Chromatogram`, `drawTrace`)

**Symptom.** Reads crossing the origin of a 10 kb plasmid showed no chromatogram — no error,
no warning, an empty track. Reads on the same plasmid that did *not* cross the origin drew
normally.

**Cause.** `drawTrace` sized one canvas to the whole track:

```js
const maxWidth = seqLengthWithGaps * charWidth2;
peakCanvas.width = maxWidth;
```

`seqLengthWithGaps` is the read's **column span**, not its base count. A read crossing the
origin has its two ends at opposite ends of the reference, so its span is the entire
plasmid: 10,327 columns at 12px a base is ~124,000px. A canvas dimension cannot exceed
**65,535px**, and past it the canvas silently produces nothing.

That is also why it looked specific to origin-crossing reads. On the same four reads, the
one that did not cross spanned 5,169 columns — 62,028px, about 3,500px under the limit.
Any read spanning more than ~5,460 columns hits this, origin or no origin, and zooming in
lowers that number.

**Fix.** Lay several canvases side by side, each a slice of the span:

- `Chromatogram` works out `oveSliceCount` from the total width and renders that many
  canvases, the first keeping the existing `marginLeft`;
- `drawTrace` takes `xOffset` and `canvasWidth`, sizes the canvas to its slice, and
  translates by `-xOffset` **after** setting the width, which resets the context;
- both draw loops skip bases outside their slice, with one base of overlap each side so a
  base on the join is drawn on both rather than clipped from each.

Slices are 32,768px — half the limit, so a zoom step cannot cross it. A read needing one
slice renders exactly as before.

The container also gets `whiteSpace: "nowrap"`. The slices are inline-blocks, so without it
they wrap once they pass the container width, and the tail of a trace is drawn back
underneath its own start — one trace that reads as two stacked ones.

`test/browser/wideTrace.mjs`, against `AlignDemo.html?wide`, covers it: that reference is
6,000 bp, which puts the origin-crossing read at ~71,600px. It asserts no canvas exceeds the
limit, that the slices lie end to end on one line, and that the trace is drawn at **both**
ends — the far piece is the one that used to vanish. A middle slice may legitimately be blank, since that is the arc the read never
covered.

## 3b. The name column could not be resized, and cut long names off (`HorizontalPanelDragHandle`, `alignmentTrackName`)

**Symptom.** The drag handle at the right edge of the alignment view's track-name column did
nothing — the column twitched and sprang back. Names longer than the column were cut off with
no way to read the rest, which is every real Sanger filename: they carry plate, well and
direction.

**Cause, the handle.** `HorizontalPanelDragHandle` keeps its move handler in a ref:

```js
const resize = reactExports.useRef((e2) => {
  const dx = xStart.current - e2.clientX;
  onDrag({ dx });                       // the FIRST onDrag, forever
  xStart.current = e2.clientX;
});
```

A ref's initial value is kept for the life of the component, so that closure holds the
`onDrag` from the first render — which closes over the starting `nameDivWidth` of 140. Each
move also resets `xStart`, so `dx` is only the last few pixels. Every event therefore set the
width to *140 plus a nudge* instead of accumulating. Dragging 120px right actually took the
column from 137px to 37px.

**Cause, the names.** `.alignmentTrackName` was `whiteSpace: "nowrap"` with
`overflow: hidden`.

**Fix.**

- the handle holds `onDrag` in a ref reassigned every render, so the move handler calls the
  current one;
- `document.removeEventListener("mousemove", mouseup.current)` — the listener was added as
  `"mouseup"`, so it was never removed and another was added on every drag;
- a floor of 40px on the width, or the column could be dragged away entirely, taking the
  handle with it;
- `whiteSpace: "normal"` and `overflowWrap: "anywhere"` on the column. `anywhere` rather than
  `break-word` because these names are one unbroken token, and `break-word` only breaks where
  there is whitespace.

`test/browser/trackNames.mjs` covers both: a 42-character name must take more than one line
and not run past the column edge, and the handle must move the column by what it was dragged
and back again. Unpatched it fails with "drawn on 1 line" and "137 -> 37".

## 3c. A command run from a menu left the editor unable to take a hotkey (`genericCommandFactory`)

**Symptom.** Select Inverse from the Edit menu highlighted the inverse selection, and then
`cmd+C` copied nothing — nor did any of the copy variants. The selection was drawn and
looked live; the editor was inert.

**Cause.** The menu closes and hands focus back to nobody, so `document.activeElement` ends
up as `document.body`. Open Vector Editor's hotkeys are bound to the editor element, so
nothing reaches them. Every menu command has this — Select All too — but it only bites on
the ones whose point is to set up a selection you then act on.

**Fix.** In `genericCommandFactory`, which is the single funnel for menu, toolbar and hotkey
invocations: remember the `.veVectorInteractionWrapper` that last held focus (a capturing
`focusin` listener on `document`), and after a command runs, hand focus back **only if it was
dropped** — that is, only if it lands on `document.body`.

Two details matter:

- it watches over several frames rather than checking once. The menu is still closing when
  the handler returns, so focus is on the menu item at that moment and only falls to the body
  a frame or two later. Checking immediately saw the menu item, concluded something else held
  focus, and did nothing.
- it never takes focus from something that wanted it. `Find…` opens a field and keeps it; a
  dialog that focuses its input a tick later wins anyway, because it runs after this.

**The status bar's own Select Inverse is a second path**, and fixing the menus did nothing
for it — which is the one people actually click. It is a `Button`, so it *keeps* focus when
clicked rather than dropping it: focus never reaches the body, so the rule above correctly
declines to act and waiting for it waits forever. Its `onClick` asks for the hand-back
outright, which is what `ovenGiveFocusBack(force)` is for.

`test/browser/menuFocus.mjs` covers both: Select Inverse from the Edit menu **and** from the
status bar must each leave focus on the editor with `cmd+C` copying exactly the inverted
range, and `Find…` must keep focus in its input. Unpatched they fail with "copied nothing
after Select Inverse" and "left focus on BUTTON.bp3-button".

---

## Deliberately NOT patched

**The chromatogram quality-score bars.** They filled the whole track, because the histogram
is normalised to the best base in the read and Sanger quality is near-uniform. That was
briefly patched to a 35% band, then dropped: the bars are simply switched off instead, from
`media/alignView.js`, by seeding OVE's own `showChromQualScores` localStorage flag. A
supported toggle beats a patch, and the eye menu can still turn them back on.

---

# `media/bioparser2.umd.js`

Three fixes, all in the ABIF (`.ab1`) reader, all hard throws. Together they are the
difference between the alignment tool opening a trace file and not. Pinned by
`test/unit/ab1.test.js` against generated fixtures — each patch has been checked to make
that suite fail when reverted.

## 4. Node input produced a zero-length DataView (`getArrayBufferFromFile`, `toArrayBuffer`)

**Symptom.** `ab1ToJson` threw `Offset is outside the bounds of the DataView` for *any*
input under Node, before reading a single tag.

**Cause.** The bundled `buffer` polyfill's `Buffer.isBuffer` does not recognise a real Node
Buffer, so the Node branch fell through to `file.buffer || file` and handed an `ArrayBuffer`
to `toArrayBuffer`, which sizes its output from `buffer2.length` — `undefined` on an
ArrayBuffer. `new ArrayBuffer(undefined)` is zero bytes, so every subsequent read was out
of bounds. Unwrapping to `.buffer` was also wrong for a pooled Buffer, whose ArrayBuffer
holds unrelated bytes either side of it.

**Fix.** Take raw bytes directly in either environment, and make `toArrayBuffer` handle an
`ArrayBuffer` and any typed-array view, honouring `byteOffset`/`byteLength`.

## 5. Trace tags numbered 1 only (`getTraceData`)

**Symptom.** `Cannot read properties of undefined (reading '1')` inside
`convertBasePosTraceToPerBpTrace`.

**Cause.** `tagDict` asks for `PBAS2`, `PLOC2` and `PCON2`. Tag number 2 is the *edited*
copy; plenty of instruments only ever write number 1. With `PLOC2` absent, `basePos` came
back `undefined` and the per-bp trace builder dereferenced it.

**Fix.** Add `baseCalls1`/`peakLocations1`/`qualNums1` to `tagDict` and fall back to them:
`this.getDataTag(tagDict.peakLocations) || this.getDataTag(tagDict.peakLocations1)`.

## 6. Tags stored inline (`getDataTag`)

**Symptom.** Latent rather than observed on the sample files, but the same out-of-bounds
throw for any file with a small tag.

**Cause.** ABIF stores a value **in the offset field itself** when its data is 4 bytes or
fewer; `getDataTag` always dereferenced that field. `FWO_` is always inline — its `"GATC"`
reads as the integer 1,195,463,747 — and on a very short read `PBAS`/`PCON` are inline too.

**Fix.**

```js
const entryOffset = numEntries <= 4
  ? curElem + 20                          // <= 4 bytes: the value IS the offset field
  : inputArrayBuffer.getInt32(curElem + 20);
```

**Known limitation, deliberately not fixed:** the DATA channel → base mapping is hardcoded
as `DATA9=G, DATA10=A, DATA11=T, DATA12=C` rather than read from `FWO_`. That matches every
file seen so far, and `test/unit/ab1.test.js` asserts the called base is the tallest channel
so a mismatch would be caught, but an instrument writing a different `FWO_` order would
render correctly-parsed bases with wrongly coloured peaks.
