# Findings 04 — Paint order and box decoration

**Status:** Gate 3 PASS
**Date:** 2026-08-29
**Chromium:** Google Chrome for Testing 152.0.7977.54 (arm64, headless)
**Scope:** plan §12 (paint order), §13 (paint properties), §37 Gate 3, §38 critical failure C

Gate 3 was the last untouched feasibility question. §38's critical failure C:
*"correct static painting order requires hidden browser information that cannot
reasonably be inferred from DOM/style state."*

It does not hold. Paint order is exactly recomputable, and box decoration
reproduces to sub-pixel.

Run: `node experiments/gate3-paint-order.js` · `node experiments/gate3-boxes.js`

---

## 1. Paint order — exact

**The measurement trick.** A PDF content stream is already in paint order. Give
every box a unique fill colour and Chromium's own operator list *is* its
painting sequence — so the ordering question can be answered without building a
renderer at all.

17 boxes exercising stacking contexts, z-index, floats, inline-blocks and
positioned elements. Our order is recomputed from computed style alone
(`src/capture/paintOrder.js`, CSS 2.1 Appendix E).

**Result: the sequences match exactly, 17/17.**

```
 #   chromium        ours
 1   a               a
 2   b               b
 3   c               c
 4   laterflow       laterflow
 5   flt             flt
 6   inl             inl
 7   sc1             sc1
 8   neg             neg
 9   mid             mid
10   pos2            pos2
11   pos5            pos5
12   opac            opac
13   trapped         trapped
14   trans           trans
15   intrans         intrans
16   posauto         posauto
17   inauto          inauto
```

The four orderings that DOM order alone cannot produce all agree:

| Rule | Chromium | Ours |
| --- | --- | --- |
| negative z-index paints below its parent's content | yes | yes |
| `z-index: 2` paints before `z-index: 5` | yes | yes |
| `z-index: 99` stays trapped inside an `opacity` stacking context | yes | yes |
| an in-flow block paints before an **earlier** positioned sibling | yes | yes |

The last one is the sharpest: `#laterflow` comes *after* `#posauto` in the DOM
but paints *before* it, because in-flow blocks are step 3 of the algorithm and
positioned elements are step 6. Any renderer walking the DOM in tree order gets
this wrong.

### This is the one place we deliberately reimplement Blink

Plan §40 says to reimplement only as a last resort. Paint order is that resort:
no Web API reports it, so it must be recomputed. But the *inputs* — `position`,
`z-index`, `opacity`, `transform`, `filter`, `isolation`, `mix-blend-mode`,
`contain`, `will-change` — are all readable from computed style, so what gets
reimplemented is an ordering algorithm over observable state, not layout.

`isStackingContext()` is the load-bearing function, and it is the likely site of
future bugs: the list of properties that silently create a stacking context is
long and grows with the platform.

---

## 2. Box decoration — sub-pixel

Nine boxes covering backgrounds, uniform borders, uniform and asymmetric
border-radius, opacity, a rotation transform, and z-index overlap. Extracted
from computed style, rendered with pdf-lib, rasterised at 120 dpi and diffed
against Chromium's own PDF.

| Metric | Result |
| --- | --- |
| Ink pixels | 86341 vs 86237 — **0.12 %** delta |
| Pixels differing > 32/255 | **0.239 %** |
| Mean absolute difference | 0.235 / 255 |
| Our PDF size | 1.8 KB |

Everything structural reproduces: fills, border bands, both radius forms,
`opacity: 0.45`, `rotate(-8deg)`, and the z-index overlap. What remains is a
thin sub-pixel seam on some bottom and right edges — the same class as the
0.48 px LayoutUnit drift recorded in findings 01, and invisible at any
reasonable zoom.

**Every error found here was in the renderer, not the extraction.** The
information needed was available in all cases; three implementation defects had
to be fixed to use it correctly.

---

## 3. Three renderer defects worth recording

### 3.1 A CSS border is a filled band, not a stroked centreline

The first version stroked a path down the middle of the border. That is not what
CSS paints: a border is the *filled region between the border box and the
padding box*. With a radius the two differ visibly, and `#roundborder` showed a
clear double outline.

The fix is an outer clockwise path followed by an inner counter-clockwise path,
filled with nonzero winding — the second subpath cuts the hole:

```js
const ring = roundedRectPath(w, h, radii) + ' ' +
             roundedRectPath(w, h, radii, borderWidth, /* reverse */ true);
```

### 3.2 CSS does not clamp each corner to half its side

The first version clamped every radius to half the box's width/height. CSS
instead computes **one scale factor for the whole box** — the tightest ratio of
any side's length to the sum of the two radii on it — and scales every radius by
it (CSS Backgrounds §5.5). **Confirmed verbatim at source 2026-08-29** —
[css-backgrounds-3 §4.5](https://www.w3.org/TR/css-backgrounds-3/#corner-overlap):
"Let f = min(Li/Si), where i ∈ {top, right, bottom, left}" and "If f < 1, then
**all** corner radii are reduced by multiplying them by f" — including the
single-`f`-for-the-whole-box part the derivation had to infer:

```js
f = min(1,
        w / (tl.x + tr.x),   h / (tr.y + br.y),
        w / (br.x + bl.x),   h / (tl.y + bl.y));
```

`border-radius: 40px 8px 40px 8px` on a 170 × 64 box exposed it. Per-corner
clamping cut the 40 px vertical radii to 32; the correct factor is 1, because
40 + 8 = 48 ≤ 64 on both vertical sides. Fixing this removed the visible arcs
entirely.

### 3.3 The page box has its own rounding, separate from the margins

Chromium does **not** emit nominal A4. For `size: 210mm 297mm` it wrote:

```
Chromium : 594.960 x 841.920 pt
nominal  : 595.276 x 841.890 pt
```

Enough that the two PDFs rasterised to different pixel widths (993 vs 992),
putting every comparison a half-pixel out. This is a *second*, independent
rounding from the margin rule in findings 03, and it is not yet characterised —
the experiment currently adopts Chromium's page box rather than deriving it.

**Open item:** derive the page-box rule the way the margin rule was derived, by
probing several `@page` sizes.

---

## 4. A correction to the harness

`experiments/pngdiff.py` compared only the **red channel**. That was harmless
for findings 01, which diffed black text on white, but wrong the moment coloured
boxes appeared — two colours differing only in green and blue scored as
identical.

It now compares the worst of the three channels and uses luma to decide which
side holds the ink. Every pixel figure in this document is from the corrected
version; findings 01's figures were re-checked and are unaffected, being
greyscale content.

---

## 5. Not tested

Deliberately out of scope for this pass, and unproven:

- **non-uniform borders** — differing widths, colours or styles per side, and
  the mitre joins between them
- `border-style` other than `solid`
- `box-shadow` and `text-shadow`
- gradients
- `overflow: hidden` clipping and `clip-path`
- nested transforms and 3D (`matrix3d` is explicitly unhandled)
- `background-image`, `background-size`, `background-clip`
- blend modes and filters — expected raster-fallback territory (plan §26)

---

## 6. Gate status — all five now answered

| Gate | Status | Basis |
| --- | --- | --- |
| 1 — Text geometry | **PASS** | 0.0000 px baselines; findings 01 |
| 2 — Text shaping | **PASS** (core claim) | sidestepped via measured word positions; complex-script glyph selection **confirmed** in findings 05. Devanagari *extraction order* still wrong |
| **3 — Paint reconstruction** | **PASS** | order exact 17/17; decoration 0.239 % pixel difference |
| 4 — Pagination | **PASS** | 100 % page assignment; 4 enumerated divergences; findings 02–03 |
| 5 — PDF backend | **PASS for text and vectors** | native text, subset fonts, paths, transforms, opacity. Images and links still untested |

None of §38's critical failures A–E has held. See `docs/feasibility-verdict.md`.
