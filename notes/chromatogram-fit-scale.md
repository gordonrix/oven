# `oveFitScale` fits to the dye front, not to the sequence

**Scope:** our own patch, not upstream — `patches/index.umd.js.patch` (the `oveFitScale`
block), landed in `ad6b2fe`. Bundled at `media/index.umd.js:147903`, documented in
`patches/README.md` under the chromatogram fix.

Found while rendering synthetic `.ab1` chromatograms written by a separate tool. Those
render as a wall of
full-height spikes. Chasing that turned up a second failure that affects real instrument
files, which is the more important half of this report.

## Summary

`oveFitScale` seeds the shared scale from **the single tallest sample in the trace**:

```js
scale = OVE_CHROM_HEIGHT / max(every sample in every channel)
```

In a real Sanger `.ab1` that maximum is almost never a base peak. It is the dye front /
primer blob near the start of the run. Measured over 10 real Sanger files from a
commercial sequencing provider:

| | |
|---|---|
| where the global max sits | **1.4 %–18 %** into the run, i.e. the lead-in |
| global max ÷ median called-base peak | **3.4× – 80×** |
| median called-base peak | 163 – 571 counts |

So the track height is being allocated to an artifact, and the sequence gets whatever is
left. Usually that is ~20 % of the track, which happens to look right — that is why this has
not been noticed. But when the dye front saturates the detector it is catastrophic:

| file | global max | median called peak | median peak drawn at |
|---|---|---|---|
| `CP-HIF-2-M13-40FOR.ab1` | 32767 (clipped) | 497 | **0.9 px** of 58 |
| `SP-LacZ-M13-40FOR.ab1` | 32767 (clipped) | 411 | **0.7 px** of 58 |
| `SP-LacZ-M13-48REV.ab1` | 10627 | 390 | 2.1 px of 58 |

Those three render as an essentially flat line. Pressing `+` fixes it by hand, but the
seeded default is wrong, and because the scale is a single module-level store shared by
every track, **one such file in an alignment squashes every other read in the view.**

The synthetic-`.ab1` case is the same bug from the other end: those traces have no dye
front, and every confident base sits at exactly 100 % frequency, so the tallest sample *is*
an ordinary peak. Every peak is then drawn at the full 58 px — a picket fence with no
headroom.

## Cause

`media/index.umd.js:147903`. The scan is over raw samples, so it cannot tell a base peak
from a lead-in artifact:

```js
for (let i = 0; i < traces.length; i += step) {
  const bp = traces[i];
  if (!bp) continue;
  for (const k of ["aTrace", "tTrace", "gTrace", "cTrace"]) {
    const arr = bp[k] || [];
    for (let j = 0; j < arr.length; j++) if (arr[j] > peak) peak = arr[j];
  }
}
return peak > 0 ? OVE_CHROM_HEIGHT / peak : 0.05;
```

`baseTraces[i]` is already the per-base window and `baseCalls[i]` is the base called there,
so the height of the *called* base at each position is one `max` away — and that, not the
global sample maximum, is the quantity the scale should be built from.

Switching to called-base heights is not by itself enough, because the lead-in overlaps real
base positions rather than sitting before them. In `SP-LacZ-M13-40FOR.ab1` the 32767 sample
is at index 894, which falls in the window of base 72 — the blob inflates ~28 of 549 called
peaks. What discards it is the **percentile**: those inflated positions land in the tail
above p95 (937), so p95 tracks the real sequence. Taking `max` over called peaks instead
would reproduce the current bug.

## Suggested fix

Take the peak of the called base at each position, discard the outer 10 % of the read, and
scale from a high percentile of what is left with a headroom factor:

```js
/** Scale at which a typical called-base peak sits comfortably inside the track. */
function oveFitScale(chromData) {
  const traces = (chromData && chromData.baseTraces) || [];
  const calls  = (chromData && chromData.baseCalls)  || [];
  const chan = { A: "aTrace", T: "tTrace", G: "gTrace", C: "cTrace" };
  const lo = Math.floor(traces.length * 0.10);
  const hi = traces.length - lo;
  const heights = [];
  const step = Math.max(1, Math.floor(traces.length / 2000));
  for (let i = lo; i < hi; i += step) {
    const bp = traces[i];
    const key = chan[(calls[i] || "").toUpperCase()];
    if (!bp || !key || !bp[key] || !bp[key].length) continue;
    let m = 0;
    for (let j = 0; j < bp[key].length; j++) if (bp[key][j] > m) m = bp[key][j];
    if (m > 0) heights.push(m);
  }
  if (heights.length < 10) return 0.05;
  heights.sort((a, b) => a - b);
  const p95 = heights[Math.min(heights.length - 1, Math.floor(heights.length * 0.95))];
  return p95 > 0 ? OVE_CHROM_HEIGHT / (p95 * 1.6) : 0.05;
}
```

Ambiguity codes fall out of `chan` and are skipped, which is fine — they are the positions
where no single channel is the height anyway.

### Why not clip the ends and scale from the maximum

That is the intuitive fix — the artifact is a lead-in, so trim it and use the max of what
remains — but measured on these files it does not hold up, in two ways.

**Quality trimming does not reach far enough.** Mott trimming (Biopython `abi-trim`) removes
only 14–23 bases from the start of these reads, while the tallest sample sits at base 13–136.
The artifact survives the trim in **8 of 10 files**, and `58 / max(trimmed)` still leaves
`SP-LacZ-M13-40FOR` at 4.5 px of 58 — still a flat line.

**Blunt fractional clipping does not either.** Median called peak, mean across the 10 real
files, with the worst file in brackets:

| clip each end | `58 / max` | `58 / p95` |
|---|---|---|
| 0 % | 10.1 px  (4.2) | 22.8 px  (9.7) |
| 5 % | 10.3 px  (4.4) | 23.3 px (10.2) |
| 10 % | 11.5 px  (4.4) | **25.0 px (10.3)** |
| 15 % | 14.4 px  (6.9) | 27.5 px (10.6) |
| 20 % | 17.0 px  (7.0) | 29.0 px (13.0) |

Even discarding 40 % of the read, scaling from the max still leaves the worst file at 7 px.
The **percentile is what does the work**; clipping is a second-order improvement that lifts
the worst case from 9.7 px to ~10.3 px, and is worth keeping only because it is nearly free.
10 % is the sweet spot — beyond that you are throwing away real sequence for little gain.

### Why the headroom factor, and why the button still matters

The synthetic column is `58.0 px` for **every** rule in the table above — clipped or not,
max or percentile. That is not a tuning failure. Those traces have a called-peak spread
(p95 ÷ median) of **1.00×** against **2.81×** for real files: a consensus genuinely has the
same confidence at every clean base, so every peak genuinely is the same height, and no
statistic computed from the data can place them anywhere but at the top.

The `× 1.6` headroom is what keeps them off the ceiling — it is a deliberate constant, not
something derived from the trace. With it:

| | median drawn | tallest drawn |
|---|---|---|
| real files | 6–19 px | clips (that is fine — outlier peaks should clip) |
| synthetic | 36 px | 36 px, nothing clipped |

Past that, the remaining gap is a user preference, which is what the existing **Trace
height** control in the alignment panel is for (`media/alignView.js:286`, `−` / `+` / `⤢`).
Worth noting the `⤢` button calls `OveChromScale.reset()`, which re-seeds through
`oveFitScale` — so fixing this function also fixes what "fit" does.

`1.6` is the knob if the balance wants shifting; `2.0` favours the synthetic case at 29 px
and pulls real files down to ~11 px.

## Reproducing

Real files, including the two saturating ones: a local folder of provider `.ab1` reads.

Synthetic files: any `.ab1` written by the generator mentioned above.

There is a standalone Python reimplementation of the render path —
`convertBasePosTraceToPerBpTrace` → `oveFitScale` → `drawTrace.drawPeaks` — in
`notes/ove_render.py`. It draws what the canvas would draw, so a scaling change can be
checked against a set of files without launching VS Code. It reproduces both the picket
fence and the flat-line cases exactly.

```
python notes/ove_render.py path/to/file.ab1 --start 300 --end 339 -o out.png
```

## Not in scope, but noticed nearby

`oveFitScale` is seeded once into a module-level store and reused for every track
(`index.umd.js:147929`, `if (oveChromScale.value === null)`). Whichever chromatogram renders
first therefore sets the scale for the whole alignment, so the view depends on track order.
With the percentile fix that matters much less, since files land in a similar range — but if
tracks should be independently scaled, that is a separate change.

---

## Measured after shipping: p95 is not low enough (1.11.2)

The rule above went in, and was then measured against **157** real provider reads rather than
the ten this report was written from — using the shipping code path (`media/bioparser2.umd.js`
→ the bundled `oveFitScale`) instead of the Python reimplementation, so there is no second
implementation to keep in step.

Median called peak, drawn in a 58px track:

| rule | mean | files under 5px | range |
|---|---|---|---|
| `58 / max` (original) | 12.5 px | **15** | 0.7 – 30.1 |
| `58 / (p95 × 1.6)` | 16.1 px | **5** | 1.6 – 24.3 |
| `58 / (p75 × 1.6)` | **24.5 px** | **0** | 5.8 – 31.0 |

p95 fixes the two saturating files this report singled out (0.7 → 15.9 px, 0.9 → 17.2 px) but
leaves a second, different failure untouched. Four `SP-LacZ-cl*-M13F*` reads have a called-peak
spread (p95 ÷ median) of **11.5× – 23.4×**, against 1.6× – 3.1× for the rest. At that spread
p95 is *itself* inside the dye front, so the sequence is still drawn at 1.6 – 3.2 px. The
percentile has to sit below the tail, not at the top of it.

The cost is clipping, and it is small: **4.3 %** of called peaks are drawn past the top of the
track on average (10 % in the worst file), against 0.4 % under p95. Peaks clipping at the top
of a chromatogram is what one is supposed to look like — a flat line is not.

A floor (`max(fitted, 14 / median)`) was measured too and also removes every unreadable file,
but it is a second rule patching over the first; changing the one constant does the same job.

The synthetic case is unaffected. A consensus trace has p75 = median = p95, so it still draws
at `58 / 1.6` = 36 px with nothing clipped, and the headroom factor is still what puts it there.
