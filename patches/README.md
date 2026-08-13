# Patches applied to the vendored OVE bundle

`media/index.umd.js` is a prebuilt Open Vector Editor UMD imported from the upstream
VSIX (see the `vendor-1.2.0` tag, which records a sha256 per imported file). There is no
build-from-source path in this repo, so the few fixes we need are applied to the bundle
directly and recorded here.

**If the bundle is ever re-vendored, re-apply everything below**, then re-run
`node --test 'test/unit/*.test.js'` and the browser checks in `test/browser/`.

---

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
