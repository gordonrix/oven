# `.ab1` tags of 4 bytes or fewer are read from the wrong place

**Package:** `@teselagen/bio-parsers` (checked against `main`, 0.4.38)

## Summary

ABIF stores a directory entry's data **inside the offset field itself** when that data is
4 bytes or fewer, rather than elsewhere in the file. `getDataTag` always treats the field as
an offset, so any such tag is read from a garbage position — usually far outside the file,
which throws.

## Cause

`packages/bio-parsers/src/ab1ToJson.js`:

```js
const numEntries = inputArrayBuffer.getInt32(curElem + 16); // data size, in bytes
const entryOffset = inputArrayBuffer.getInt32(curElem + 20); // data offset -- or the data
output = this[inTag.typeToReturn](entryOffset, numEntries);
```

Per the ABIF specification, when the data size is ≤ 4 the value occupies those same four
bytes and there is no offset to follow.

`FWO_` is always inline — its `"GATC"` reads as the integer 1,195,463,747 — and on a very
short read `PBAS` and `PCON` are inline too, which is when this becomes fatal rather than
latent. It is currently masked only because `tagDict` happens not to include `FWO_`.

## Reproduction

A four-base trace makes `PBAS1` and `PCON1` exactly 4 bytes:

```js
await ab1ToJson(fourBaseAb1);
// -> RangeError: Offset is outside the bounds of the DataView
```

(Also requires the fix in the companion issue to get this far under Node.)

## Suggested fix

```js
const entryOffset =
  numEntries <= 4
    ? curElem + 20
    : inputArrayBuffer.getInt32(curElem + 20);
```

A patch against `main` is attached (`bio-parsers-ab1-fixes.patch`). It also adds a
tag-number fallback for `PBAS` and `PCON`, mirroring the one already present for `PLOC` —
instruments that only ever write the raw copy leave the `2` variants absent.

## Note on generating a fixture

A hand-built ABIF is a better test than a collected one, since the interesting cases are
structural and can be included deliberately. The generator we used builds a 30-base trace
plus a 4-base one — the short file is the only way to make a tag the parser actually reads
land inline.
