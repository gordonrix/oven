# `ab1ToJson` cannot read any file under Node: "Offset is outside the bounds of the DataView"

**Package:** `@teselagen/bio-parsers` (checked against `main`, 0.4.38)

## Summary

`ab1ToJson` throws for every input in a Node process, before it reads a single tag. The
resulting `DataView` is zero bytes long, so the first read in `abConverter` is out of range.

## Reproduction

```js
const fs = require("fs");
const { ab1ToJson } = require("@teselagen/bio-parsers");

// any valid .ab1 file
ab1ToJson(fs.readFileSync("trace.ab1")).catch(e => console.log(e.message));
// -> RangeError: Offset is outside the bounds of the DataView
```

Passing a `Uint8Array` or a bare `ArrayBuffer` fails the same way.

## Cause

`getArrayBufferFromFile` imports `Buffer` from the `buffer` package rather than using
Node's global, so `Buffer.isBuffer(nodeBuffer)` is `false`:

```js
import { Buffer } from "buffer";
...
return toArrayBuffer(Buffer.isBuffer(file) ? file : file.buffer || file);
```

Execution therefore falls through to `file.buffer`, handing an **`ArrayBuffer`** to
`toArrayBuffer`, which sizes its output from `.length`:

```js
function toArrayBuffer(buffer) {
  const ab = new ArrayBuffer(buffer.length);   // undefined on an ArrayBuffer
```

`new ArrayBuffer(undefined)` is zero bytes, so everything downstream is out of bounds.

There is a second, quieter bug in the same expression. Node pools small allocations, so for
a Buffer under 8 KB `file.buffer` is the **whole pool** — unwrapping to it discards
`byteOffset` and `byteLength`, and the parser reads unrelated bytes either side of the file.

## Suggested fix

Take raw bytes directly in either environment, and make `toArrayBuffer` handle an
`ArrayBuffer` and any typed-array view, honouring `byteOffset`:

```js
export default function getArrayBufferFromFile(file) {
  if (file instanceof ArrayBuffer || ArrayBuffer.isView(file)) {
    return Promise.resolve(toArrayBuffer(file));
  }
  if (!isBrowser) {
    ...
```

```js
function toArrayBuffer(buffer) {
  if (buffer instanceof ArrayBuffer) return buffer;
  if (ArrayBuffer.isView(buffer)) {
    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    );
  }
  ...
```

A patch against `main` is attached (`bio-parsers-ab1-fixes.patch`).

## Suggested regression test

Worth covering all three input shapes, plus a pooled Buffer, since only the last catches
the `byteOffset` half:

```js
const bytes = fs.readFileSync(fixture);
const pool = Buffer.alloc(bytes.length + 64, 0xab);
bytes.copy(pool, 32);
await ab1ToJson(pool.subarray(32, 32 + bytes.length)); // must equal the direct read
```
