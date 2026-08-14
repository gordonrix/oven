# Upstream: what to report to Teselagen

Drafts for filing against [TeselaGen/tg-oss](https://github.com/TeselaGen/tg-oss). Nothing
here has been submitted — these are ready for you to review and post.

Checked against tg-oss `main` as of 2026-08-14: **bio-parsers 0.4.38**, **ove 0.8.42**.

## The finding that matters most

**Our vendored bundles are old, and upstream has already fixed two of the things we patch.**
The bundles came from the sanekun v1.2.0 VSIX, which carries roughly OVE 0.7.x; upstream is
now 0.8.42. Specifically:

| our patch | upstream `main` |
|---|---|
| `getStructuredBases` origin wrap | **already fixed** — there is now an explicit `wrapsOrigin` branch |
| ab1 `PLOC` tag-number fallback | **already fixed** — `peakLocationsUser` with a fallback |
| ab1 inline tag data | still broken |
| ab1 Node `ArrayBuffer` handling | still broken |
| ab1 `PBAS`/`PCON` fallback | still missing (ours only needed `PLOC`, so this is robustness) |
| minimap 1 bp mark, chromatogram height/scale | unchanged; these are design choices, not bugs |

So **upgrading the vendored bundles is worth considering on its own merits** — it would
retire two patches without us doing anything. It is not free: 0.7.x → 0.8.x is a minor
version jump across a viewer we depend on heavily, and the current bundle came from a
published VSIX rather than a known commit, so "what changed" is not knowable without
diffing. That is a separate piece of work from this one.

## Ready to file

### 1. `.ab1` files cannot be parsed under Node at all — `issue-1-ab1-node-arraybuffer.md`

The strongest of the three: reproducible in four lines, affects every caller in a Node
process, and the fix is contained. This is what stopped our extension reading trace files.

### 2. Tags whose data is 4 bytes or fewer are read from the wrong place — `issue-2-ab1-inline-tag-data.md`

A plain spec violation. Latent for most files, fatal for short reads.

### Both fixes: `bio-parsers-ab1-fixes.patch`

Applies to tg-oss `main` with `git apply`. Also includes the `PBAS`/`PCON` tag-number
fallback, mirroring the `PLOC` one already there.

**Not verified by a build.** Applying it and running the bio-parsers test suite is the
remaining step before this becomes a pull request — we deliberately did not take on the
tg-oss build toolchain. The changes are small and the reasoning is checked against the ABIF
spec and against real files, but treat the patch as reviewed-not-run.

## Deliberately not filed

- **Minimap 1 bp mismatch invisibility** and **chromatogram height/scale**. Real usability
  complaints, but they are design opinions about someone else's viewer rather than defects,
  and ours are tuned to this extension's layout. Worth raising as a discussion if you want
  them upstream, not as a bug.
- **The quality-score histogram filling the track.** We no longer patch this at all — it is
  switched off through OVE's own `showChromQualScores` toggle.
