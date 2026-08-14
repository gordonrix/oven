# Patches applied to the vendored bundles

`media/index.umd.js` (Open Vector Editor) and `media/bioparser2.umd.js` (Teselagen
bio-parsers) are prebuilt UMDs imported from the upstream VSIX — see the `vendor-1.2.0`
tag, which records a sha256 per imported file. There is no build-from-source path in this
repo, so the few fixes we need are applied to the bundles directly and recorded here.

**If either bundle is ever re-vendored, re-apply everything below**, then re-run
`node --test 'test/unit/*.test.js'` and the browser checks in `test/browser/`.

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

---

# `media/bioparser2.umd.js`

Three fixes, all in the ABIF (`.ab1`) reader, all hard throws. Together they are the
difference between the alignment tool opening a trace file and not. Pinned by
`test/unit/ab1.test.js` against generated fixtures — each patch has been checked to make
that suite fail when reverted.

## 2. Node input produced a zero-length DataView (`getArrayBufferFromFile`, `toArrayBuffer`)

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

## 3. Trace tags numbered 1 only (`getTraceData`)

**Symptom.** `Cannot read properties of undefined (reading '1')` inside
`convertBasePosTraceToPerBpTrace`.

**Cause.** `tagDict` asks for `PBAS2`, `PLOC2` and `PCON2`. Tag number 2 is the *edited*
copy; plenty of instruments only ever write number 1. With `PLOC2` absent, `basePos` came
back `undefined` and the per-bp trace builder dereferenced it.

**Fix.** Add `baseCalls1`/`peakLocations1`/`qualNums1` to `tagDict` and fall back to them:
`this.getDataTag(tagDict.peakLocations) || this.getDataTag(tagDict.peakLocations1)`.

## 4. Tags stored inline (`getDataTag`)

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
