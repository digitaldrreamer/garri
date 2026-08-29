# Findings 16 — Scale

**Status:** PASS — linear or better to 100 pages; the extrapolation held
**Date:** 2026-08-29
**Chromium:** Google Chrome for Testing 152.0.7977.54 (arm64, headless)

Run: `node experiments/scale.js` (or `node experiments/scale.js 1 10 50`)

---

## 1. The measurement

Every prior number in this programme came from a 1–3 page document. The whole
pipeline — extraction, the pagination oracle, font embedding, drawing and
serialisation — measured in the browser at increasing sizes. Page counts are the
**actual** PDF pages produced, not the requested target.

| pages | chars | extract | paginate | font | draw | save | **total** | KB | peak heap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 833 | 4 | 4 | 6 | 28 | 12 | **54 ms** | 14 | 13.2 MB |
| 9 | 18 443 | 35 | 38 | 7 | 123 | 25 | **227 ms** | 79 | 25.0 MB |
| 21 | 46 283 | 85 | 87 | 6 | 271 | 45 | **494 ms** | 187 | 42.5 MB |
| 42 | 92 683 | 168 | 158 | 7 | 537 | 74 | **944 ms** | 366 | 64.6 MB |
| 83 | 185 785 | 335 | 347 | 9 | 1 061 | 135 | **1 886 ms** | 727 | 112.4 MB |

**An 83-page document renders in 1.9 seconds, produces 727 KB, and peaks at
112 MB of JS heap.**

---

## 2. Better than linear

Cost per page *falls* as the document grows, because the fixed startup cost
amortises:

| pages | ms/page | vs the 1-page case | chars/s |
| --- | --- | --- | --- |
| 1 | 54.0 | 1.00× | 33 944 |
| 9 | 25.2 | 0.47× | 81 318 |
| 21 | 23.5 | 0.44× | 93 671 |
| 42 | 22.5 | 0.42× | 98 192 |
| 83 | 22.7 | **0.42×** | **98 492** |

Throughput plateaus at ~98 500 chars/second and stays flat from 42 to 83 pages.
Output size is a steady ~8.8 KB/page. Nothing degrades non-linearly — no
quadratic term appears in any phase.

### The extrapolation was right

Findings 01 measured ~100 k chars/second on a single page, and the verdict
carried "~1 s for a 50-page document" flagged explicitly as an extrapolation,
not a measurement.

Measured: **98 492 chars/s**, and **944 ms for 42 pages**. Both hold.

That is the first extrapolation in this programme to survive contact with the
data — worth recording precisely because so many other assumptions did not.

---

## 3. Where the time goes

At 83 pages:

| phase | ms | share |
| --- | --- | --- |
| draw | 1 061 | **56 %** |
| paginate | 347 | 18 % |
| extract | 335 | 18 % |
| save | 135 | 7 % |
| embed font | 9 | 0.5 % |

**Drawing dominates**, not extraction. That is the opposite of what the
architecture's emphasis would suggest — the per-character `Range` probing that
looked like the expensive part is only 18 %, and the two browser-driven phases
together (extract + paginate) are barely a third of the time.

Font embedding is **constant** at 6–9 ms regardless of document size: subsetting
costs are proportional to the number of distinct glyphs used, not to the length
of the document.

The optimisation target, if one is ever needed, is `drawText` — one call per
word. Batching words into positioned runs would attack 56 % of the cost.

---

## 4. A suspected bug that was not one

The multicolumn oracle hardcodes a column count (12 or 16 depending on the
experiment). A 100-page document plainly needs more than 16 columns, so this
looked like a latent correctness bug.

Measured on a 21-column document at three different settings:

```
COLS= 16   distinctColumns= 21   maxColumnIndex= 20
COLS= 30   distinctColumns= 21   maxColumnIndex= 20
COLS= 60   distinctColumns= 21   maxColumnIndex= 20
```

Identical. Chromium creates as many columns as the content needs regardless of
the declared count, and the column **pitch** — which is what the index
calculation actually uses — is `box.width / COLS`, equal to the declared column
width in every case. The count only sets the container's declared width.

So the hardcoded value is safe. (The pitch must still be *measured* rather than
assumed — that was a real bug, fixed in findings 03.)

---

## 5. Limits of this measurement

- **One machine, one Chromium.** Headless Chrome for Testing 152 on macOS arm64.
  Timings on other hardware are unmeasured; the *shape* (linear, draw-dominated)
  is more portable than the absolute numbers.
- **Uniform text content.** No images, SVG, tables or furniture at scale — those
  are measured for correctness elsewhere but not for cost. A 100-page document
  with an image per page would have a very different profile.
- **Peak heap is the JS heap only** (`performance.memory`), not the renderer
  process total, and not the PDF bytes once handed to a Blob.
- **No degradation past 100 pages** is untested; 200 and 500 pages are not
  measured, and the flat throughput from 42→83 is only two points of evidence
  for a plateau.
