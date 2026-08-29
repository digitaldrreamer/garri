# Findings 10 — Dashed and dotted borders

**Status:** PASS — 13/13 rows match Chromium exactly
**Date:** 2026-08-29
**Chromium:** Google Chrome for Testing 152.0.7977.54 (arm64, headless)

Run: `node experiments/paint-gaps.js dashed-borders` then
`node experiments/dash-rule.js dashed-borders-ours.pdf`

---

## 1. Chromium emits no dash operator

PDF has `d` for dash patterns. Chromium does not use it: the operator histogram
for a dashed-border page contains **zero** dash operators and 91
`constructPath` ops. **Every dash is a separate filled rectangle.**

That is convenient — the pattern can be read straight out of the geometry,
exactly, instead of being measured off a raster.

---

## 2. The rule, derived rather than assumed

The fixture varies border-width (1, 2, 3, 4, 6, 8 px) *and* side length
(100, 137, 200, 263, 300 px) so the two variables can be separated.

| | dash length | nominal period | count |
| --- | --- | --- | --- |
| dashed, `bw ≤ 2` | `3 × bw` | `5 × bw` | `ceil(side / period)` |
| dashed, `bw ≥ 3` | `2 × bw` | `3 × bw` | `ceil(side / period)` |
| dotted | `1 × bw` | `2 × bw` | `floor(side / period) + 1` |

and in every case the gap is whatever makes the run fit the side exactly:

```
gap = (side − n × dash) / (n − 1)
```

Two things worth noting:

- **The dash length is constant; the gap stretches.** Across sides of 100, 137,
  200 and 263 px at the same 4 px border, the dash stayed at 8.000 px while the
  gap moved 3.500 → 3.727 → 4.000 → 4.143. The pattern is fitted by adjusting
  the gaps, not by scaling the dashes.
- **Thin borders are special-cased.** At `bw ≤ 2` Chromium switches to a longer
  dash (3×) on a sparser period (5×). A rule derived only from 4 px would have
  been wrong at 1 px and 2 px.
- **Dashes and dots count differently.** `ceil` vs `floor+1` — they diverge
  precisely when the side is an exact multiple of the period, which is why a
  300 px side at 2 px dotted gives 76 dots and not 75.

---

## 3. Verification

The same geometry extractor was run against **our** output and Chromium's, and
the tables compared row by row:

| id | style | bw | side | n | dash | gap | match |
| --- | --- | --- | --- | --- | --- | --- | --- |
| w1 | dashed | 1 | 300 | 60 | 3.000 | 2.034 | ✓ |
| w2 | dashed | 2 | 300 | 30 | 6.000 | 4.138 | ✓ |
| w3 | dashed | 3 | 300 | 34 | 6.000 | 2.909 | ✓ |
| w4 | dashed | 4 | 300 | 25 | 8.000 | 4.167 | ✓ |
| w6 | dashed | 6 | 300 | 17 | 12.000 | 6.000 | ✓ |
| w8 | dashed | 8 | 300 | 13 | 16.000 | 7.667 | ✓ |
| L100 | dashed | 4 | 100 | 9 | 8.000 | 3.500 | ✓ |
| L137 | dashed | 4 | 137 | 12 | 8.000 | 3.727 | ✓ |
| L200 | dashed | 4 | 200 | 17 | 8.000 | 4.000 | ✓ |
| L263 | dashed | 4 | 263 | 22 | 8.000 | 4.143 | ✓ |
| t2 | dotted | 2 | 300 | 76 | 2.000 | 1.973 | ✓ |
| t4 | dotted | 4 | 300 | 38 | 4.000 | ~4.00 | ✓ |
| t8 | dotted | 8 | 300 | 19 | 8.000 | ~8.22 | ✓ |

y position and border height match exactly on every row. Whole-page raster
difference **0.520 %**, ink delta 0.25 %.

---

## 4. Two measurement bugs on the way

**Subpaths were collapsed.** A single `constructPath` carries *all* the dashes
of one side as separate subpaths. Taking one bounding box over the whole path
reported each dashed border as a single 300 px rectangle, which looked like
"Chromium draws dashed borders solid." Splitting on `moveTo` fixed it.

**Rows were labelled by assumption.** The first table mapped PDF rows to fixture
elements by index. One row was missing, so every label after it was off by one —
and the derived rule was nonsense. Matching rows to elements by their measured
`y` fixed it. This is the third time in the programme that an assumed row
mapping produced a confident wrong table.

**`y > 0` hid the 1 px case.** The dash filter excluded `y = 0`, which is exactly
where the first fixture row sits. That produced "Chromium draws no dashes at
1 px", from which I nearly concluded it renders thin dashed borders as solid. It
does not — it dashes them at 3.000 × 1.000 on a 5.034 period.
