/*
 * A minimal ABIF (.ab1) writer: four trace channels, base calls, peak
 * positions and qualities. Enough for OVE's parser, and nothing else.
 *
 * Shared by make-synthetic-ab1.mjs, which writes the test fixtures, and by
 * scripts/screenshots, which writes reads that look like reads.
 */

const CHAR = 2;
const SHORT = 4;

const bytesOf = (s) => Buffer.from(s, 'latin1');
const shortsOf = (arr) => {
  const b = Buffer.alloc(arr.length * 2);
  arr.forEach((v, i) => b.writeInt16BE(v, i * 2));
  return b;
};
const numbersOf = (arr) => Buffer.from(arr.map((v) => v & 0xff));

/**
 * @param {{bases: string, traces: {A: number[], C: number[], G: number[], T: number[]},
 *          basePos: number[], quality: number[]}} read
 * @returns {{bytes: Buffer, inline: string[]}} the file, and which tags were
 *   small enough to be stored inline in the directory
 */
export function encodeAbif({ bases, traces, basePos, quality }) {
  /*
   * FWO_ declares which DATA channel holds which base. "GATC" means DATA9=G,
   * DATA10=A, DATA11=T, DATA12=C -- the order the parser assumes.
   */
  const entries = [
    { name: 'DATA', num: 9, type: SHORT, size: 2, data: shortsOf(traces.G) },
    { name: 'DATA', num: 10, type: SHORT, size: 2, data: shortsOf(traces.A) },
    { name: 'DATA', num: 11, type: SHORT, size: 2, data: shortsOf(traces.T) },
    { name: 'DATA', num: 12, type: SHORT, size: 2, data: shortsOf(traces.C) },
    { name: 'FWO_', num: 1, type: CHAR, size: 1, data: bytesOf('GATC') },
    { name: 'PBAS', num: 1, type: CHAR, size: 1, data: bytesOf(bases) },
    { name: 'PLOC', num: 1, type: SHORT, size: 2, data: shortsOf(basePos) },
    { name: 'PCON', num: 1, type: CHAR, size: 1, data: numbersOf(quality) }
  ];

  const HEADER = 128; // data starts here; the directory goes at the end
  let cursor = HEADER;
  const blocks = [];
  for (const e of entries) {
    // <= 4 bytes lives in the offset field itself, not in the file body.
    if (e.data.length <= 4) e.inline = true;
    else {
      e.offset = cursor;
      blocks.push(e.data);
      cursor += e.data.length;
    }
  }

  const dirLocation = cursor;
  const dir = Buffer.alloc(entries.length * 28);
  entries.forEach((e, i) => {
    const o = i * 28;
    bytesOf(e.name).copy(dir, o);
    dir.writeInt32BE(e.num, o + 4);
    dir.writeInt16BE(e.type, o + 8);
    dir.writeInt16BE(e.size, o + 10);
    dir.writeInt32BE(Math.floor(e.data.length / e.size), o + 12); // numelements
    dir.writeInt32BE(e.data.length, o + 16);                      // datasize
    if (e.inline) e.data.copy(dir, o + 20);
    else dir.writeInt32BE(e.offset, o + 20);
  });

  const head = Buffer.alloc(HEADER);
  bytesOf('ABIF').copy(head, 0);
  head.writeInt16BE(101, 4);
  bytesOf('tdir').copy(head, 6);
  head.writeInt32BE(1, 10);
  head.writeInt16BE(1023, 14);
  head.writeInt16BE(28, 16);
  head.writeInt32BE(entries.length, 18);       // read back from offset 18
  head.writeInt32BE(entries.length * 28, 22);
  head.writeInt32BE(dirLocation, 26);          // read back from offset 26

  return {
    bytes: Buffer.concat([head, ...blocks, dir]),
    inline: entries.filter((e) => e.inline).map((e) => e.name + e.num)
  };
}
