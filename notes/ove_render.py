"""Offline reimplementation of the ove-vscode-primer-cart chromatogram renderer.

Ports, faithfully:
  - convertBasePosTraceToPerBpTrace  (bioparser2.umd.js:26612)  -> per-base windows
  - oveFitScale                      (index.umd.js:147903)       -> 58 / global peak
  - drawTrace.drawPeaks              (index.umd.js:148062)       -> one window per charWidth

so a .ab1 can be checked against the real viewer without opening VS Code.
"""
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from Bio import SeqIO

OVE_CHROM_HEIGHT = 58
CORRECTION_AMOUNT = 3
COLORS = {"A": "green", "T": "red", "G": "black", "C": "blue"}


def read_chrom(path):
    rec = SeqIO.read(str(path), "abi")
    raw = rec.annotations["abif_raw"]
    fwo = raw["FWO_1"].decode()
    traces = {b: np.asarray(raw[f"DATA{9 + k}"], dtype=float) for k, b in enumerate(fwo)}
    return {
        "seq": str(rec.seq),
        "basePos": list(raw["PLOC2"]),
        "traces": traces,
        "qual": rec.letter_annotations["phred_quality"],
    }


def per_bp_windows(chrom):
    """Port of convertBasePosTraceToPerBpTrace: slice traces into per-base windows."""
    basePos = chrom["basePos"]
    trace_len = len(next(iter(chrom["traces"].values())))
    windows = []
    startPos = 0
    nextBasePos = basePos[1] if len(basePos) > 1 else None

    def end_pos(sp, nbp):
        return sp + -(-(nbp - sp) // 2) if nbp else trace_len

    endPos = end_pos(startPos, nextBasePos)
    for i in range(len(basePos)):
        windows.append((startPos, endPos + CORRECTION_AMOUNT))
        if i != len(basePos) - 1:
            startPos = endPos + CORRECTION_AMOUNT
            nextBasePos = basePos[i + 2] if i + 2 < len(basePos) else None
            endPos = end_pos(startPos, nextBasePos)
    return windows


def fit_scale(chrom, windows):
    """Port of oveFitScale: scale so the tallest sampled peak just fills the track."""
    step = max(1, len(windows) // 2000)
    peak = 0.0
    for i in range(0, len(windows), step):
        s, e = windows[i]
        for tr in chrom["traces"].values():
            seg = tr[s:e]
            if seg.size:
                peak = max(peak, seg.max())
    return OVE_CHROM_HEIGHT / peak if peak > 0 else 0.05


def render(path, start_bp, end_bp, char_width=14, scale=None, ax=None, title=None):
    """Draw exactly what drawTrace would paint onto its 58px-high canvas."""
    chrom = read_chrom(path)
    windows = per_bp_windows(chrom)
    scale_pct = fit_scale(chrom, windows) if scale is None else scale

    if ax is None:
        _, ax = plt.subplots(figsize=((end_bp - start_bp + 1) * char_width / 100, 1.9))

    for base, color in COLORS.items():
        tr = chrom["traces"][base]
        xs, ys = [], []
        for bi in range(start_bp, end_bp + 1):
            s, e = windows[bi]
            seg = tr[s:e]
            n = len(seg)
            if not n:
                continue
            x0 = (bi - start_bp) * char_width
            spacing = char_width / n
            for j, v in enumerate(seg):
                xs.append(x0 + spacing * j)
                # canvas y grows downward; drawTrace does scaledHeight - scale*value
                ys.append(OVE_CHROM_HEIGHT - scale_pct * v)
        ax.plot(xs, ys, color=color, lw=1.0)

    for bi in range(start_bp, end_bp + 1):
        ax.text((bi - start_bp + 0.5) * char_width, OVE_CHROM_HEIGHT + 11,
                chrom["seq"][bi], ha="center", va="center", fontsize=7,
                color=COLORS.get(chrom["seq"][bi], "purple"))

    ax.set_xlim(0, (end_bp - start_bp + 1) * char_width)
    ax.set_ylim(OVE_CHROM_HEIGHT + 18, -6)   # inverted: canvas coords, 0 = top
    ax.axhline(OVE_CHROM_HEIGHT, color="#ccc", lw=0.6)
    ax.axhline(0, color="#f0a", lw=0.6, ls=":")   # canvas ceiling
    ax.set_yticks([])
    ax.set_xticks([])
    for sp in ax.spines.values():
        sp.set_visible(False)
    if title:
        ax.set_title(title, fontsize=8, loc="left")
    return scale_pct


def called_peak_heights(chrom, windows):
    """Peak of the called base at each position — the quantity the scale should use."""
    heights = []
    for i, (s, e) in enumerate(windows):
        tr = chrom["traces"].get(chrom["seq"][i])
        if tr is None:
            continue
        seg = tr[s:e]
        if seg.size and seg.max() > 0:
            heights.append(seg.max())
    return np.asarray(heights)


def fit_scale_proposed(chrom, windows, headroom=1.6, clip=0.10):
    """Proposed replacement: p95 of called-base peaks over the middle of the read.

    Clipping alone is not enough — the lead-in artifact reaches base 13-136, past
    where quality trimming or a blunt end-clip gets to — so the percentile is what
    actually discards it. The headroom factor is what keeps a flat-topped synthetic
    trace (p95 == max) off the ceiling; no data-derived statistic can do that.
    """
    h = called_peak_heights(chrom, windows)
    lo = int(len(h) * clip)
    seg = h[lo:len(h) - lo] if lo and len(h) - 2 * lo >= 10 else h
    if not seg.size:
        return 0.05
    return OVE_CHROM_HEIGHT / (np.percentile(seg, 95) * headroom)


def main():
    import argparse
    ap = argparse.ArgumentParser(description="Render a .ab1 the way the viewer canvas would.")
    ap.add_argument("ab1")
    ap.add_argument("--start", type=int, default=300)
    ap.add_argument("--end", type=int, default=339)
    ap.add_argument("--char-width", type=float, default=22)
    ap.add_argument("--headroom", type=float, default=1.6)
    ap.add_argument("-o", "--out", default="ove_render.png")
    args = ap.parse_args()

    chrom = read_chrom(args.ab1)
    windows = per_bp_windows(chrom)
    start = max(0, min(args.start, len(windows) - 1))
    end = min(args.end, len(windows) - 1)
    cur = fit_scale(chrom, windows)
    prop = fit_scale_proposed(chrom, windows, args.headroom)
    h = called_peak_heights(chrom, windows)

    _, axes = plt.subplots(2, 1, figsize=((end - start + 1) * args.char_width / 100, 4.2))
    render(args.ab1, start, end, args.char_width, scale=cur, ax=axes[0],
           title=f"current   scale = 58/max            ({cur:.5f})")
    render(args.ab1, start, end, args.char_width, scale=prop, ax=axes[1],
           title=f"proposed  scale = 58/(p95*{args.headroom})   ({prop:.5f})")
    plt.tight_layout()
    plt.savefig(args.out, dpi=125)

    print(f"bases {len(windows)}   called peak: median {np.median(h):.0f}  "
          f"p95 {np.percentile(h, 95):.0f}  max {h.max():.0f}")
    print(f"  spread p95/median      {np.percentile(h, 95) / np.median(h):.2f}x")
    print(f"  median drawn, current  {np.median(h) * cur:5.1f} px of {OVE_CHROM_HEIGHT}")
    print(f"  median drawn, proposed {np.median(h) * prop:5.1f} px of {OVE_CHROM_HEIGHT}")
    print(f"  wrote {args.out}")


if __name__ == "__main__":
    main()
