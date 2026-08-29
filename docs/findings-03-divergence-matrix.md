# Findings 03 — Page-vs-column divergence matrix

**Status:** oracle validated on 5 fragmentation rules; 4 divergences enumerated
**Date:** 2026-08-29
**Chromium:** Google Chrome for Testing 152.0.7977.54 (arm64, headless)
**Scope:** the open question left by findings 02

Findings 02 established the multicolumn oracle and found one divergence —
repeating `<thead>` — **by accident**. That was the worrying part: an unknown
number of others could be lurking.

This harness looks for them deliberately. Ten probes, each isolating one
fragmentation feature, each fragmented twice: once as pages
(`Page.printToPDF`, ground truth) and once as columns (the oracle). Then diffed.

Run it: `node experiments/divergence-matrix.js`

---

> **LayoutUnit confirmed at source 2026-08-29.**
> [`layout_unit.h`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/platform/geometry/layout_unit.h)
> defines `using LayoutUnit = FixedPoint<6, int32_t>;` with
> `kFixedPointDenominator = 1 << kFractionalBits` → 64. No `#ifdef` on OS or
> architecture anywhere in the instantiation, so the 31/64 px screen-vs-print
> drift recorded here is invariant across platform *and* CPU by construction.
> Only a Chromium version change could move it.

## 1. The matrix

Page size 120 × 90 mm, 10 mm margins — small pages so each probe fragments in a
few lines.

| Probe | pages | cols | page assignment | max Δy | Verdict |
| --- | --- | --- | --- | --- | --- |
| control, plain flow | 2 | 2 | 18/18 | 0.00 px | **MATCH** |
| `break-before: page` | 2 | 2 | 17/17 | 0.38 px | **MATCH** |
| `break-inside: avoid` | 2 | 2 | 17/17 | 0.00 px | **MATCH** |
| `break-after: avoid` | 2 | 2 | 15/15 | 0.00 px | **MATCH** |
| `orphans: 3; widows: 3` | 2 | 2 | 15/15 | 0.00 px | **MATCH** |
| `table-header-group` | 2 | 2 | 49/49 | 21.50 px | DIVERGE — extra content |
| `table-footer-group` | 2 | 2 | **22/28** | 21.50 px | DIVERGE — extra content *and* assignment |
| `position: fixed` | 2 | **3** | **0/4** | 0.00 px | DIVERGE — fragment count |
| list `::marker` | 2 | 2 | 16/16 | 0.00 px | *extraction gap, not fragmentation* |
| named pages | **3** | 2 | 6/18 | 0.00 px | DIVERGE — fragment count |

**The five core fragmentation rules match exactly.** `break-inside: avoid`,
`break-after: avoid`, orphans and widows, forced breaks and plain flow all
reproduce with 100 % page assignment and 0.00 px vertical error. That is the
result that matters: the rules a document actually relies on are all honoured
by column fragmentation.

The divergences cluster in a narrow, enumerable band.

---

## 2. The four real divergences

### 2.1 `table-header-group` — repeats per page, not per column

Confirmed from findings 02, now with a cleaner measurement. Page assignment is
still perfect (49/49); the header is simply absent from the oracle's second
fragment, and every row below it sits 21.50 px high — exactly the header row's
height.

```
print has extra: "Ref"    print=2 oracle=1
print has extra: "Name"   print=2 oracle=1
print has extra: "Amount" print=2 oracle=1
```

### 2.2 `table-footer-group` — the same, but worse

New. `<tfoot>` also repeats per page, and it is the more damaging of the two
because the footer is placed at the **bottom** of every page, consuming space
the oracle never reserved.

Unlike the header case, this **changes page assignment**: 22/28, with 6 body
rows landing on the wrong page.

```
misassigned col2 -> page1: "TOTAL"       (the repeated footer)
misassigned col1 -> page2: "008"         (a row pushed over by it)
misassigned col1 -> page2: "Item number 8"
```

This is the case findings 02 predicted in the abstract — "a table row near a
boundary can legitimately land on a different page than the oracle predicts. It
did not happen here, but it can." It happens here.

### 2.3 `position: fixed` — repeats per page, and pollutes column indexing

New, and the most disruptive of the four.

- In **paged** media a fixed element repeats on every page (2 occurrences).
- In **column** layout it does not repeat, and worse, it positions relative to
  the *viewport* rather than the container — so it landed at an x that maps to
  **column 5**, inventing a fragment that does not exist and pushing the
  reported column count from 2 to 3.

Page assignment scored 0/4. A fixed element must be lifted out of the oracle's
measurement entirely and handled as per-page furniture, not flowed content.

### 2.4 Named pages — not expressible in columns at all

New. `@page wide { size: 160mm 90mm }` with `page: wide` on a block makes
Chromium switch page geometry mid-document, producing 3 pages of two different
sizes. A multicolumn container has one fixed column geometry and cannot express
this.

The oracle produced 2 columns against 3 pages. This is not a bug to fix but a
scope boundary: named pages need the document split into runs of uniform page
geometry, each fragmented by its own oracle pass.

---

## 3. One non-divergence, correctly classified

**List markers are an extraction gap, not a fragmentation divergence.**

```
print has extra: "1."  print=1 oracle=0
print has extra: "2."  print=1 oracle=0
```

Page assignment was 16/16 with 0.00 px error — the *fragmentation* is perfect.
The markers are missing because `::marker` is generated content, and the
extractor walks text nodes only. This belongs to findings 01's territory
(pseudo-elements and generated content, plan §22), and it will affect
`::before` / `::after` / `counter()` identically.

Worth stating plainly because the harness reports it in the same column as real
divergences, and conflating the two would send the fix to the wrong subsystem.

---

## 4. Corrections to earlier findings

Two things found here invalidate claims made in findings 02. Both were caught
because this harness used a *different* page geometry, which is precisely why
varying the fixture matters.

### 4.1 Margin rounding is to whole pixels, not whole points

Findings 02 stated Chromium rounds `@page` margins to whole **points**. That
fit its single data point by coincidence:

| margin | in px | in pt | Chromium uses |
| --- | --- | --- | --- |
| 20 mm | 75.59 | 56.69 | **76 px** = 57 pt exactly — fits both rules |
| 10 mm | 37.795 | 28.35 | **38 px** = 28.5 pt — only the pixel rule fits |

With the point rule, every matching probe carried a constant 0.67 px (= 0.5 pt)
error. With the pixel rule, `Math.round(mm / 25.4 * 96)`, they go to **0.00 px**.

Findings 02 has been corrected in place.

### 4.2 A latent column-indexing bug that could have invalidated Gate 4

The oracle computes a run's column as `floor((left − origin) / columnWidth)`,
and the first version used the column width it *asked for* rather than the one
Chromium *used*. Chromium rounds the container's used width — a 6062.08 px
request became 6062 px, so the real pitch was 378.875 px against an assumed
378.88 px.

The 0.005 px shortfall put every column-2 run at `floor(0.99998) = 0`. The
entire matrix collapsed to one column and reported nonsense on all ten probes.

**Gate 4 was re-run after the fix and its result is unchanged** (109/109,
100 %). It had not been affected — but only because that geometry's rounding
happened to fall the other way. The fix is to measure the pitch:
`container.getBoundingClientRect().width / columnCount`.

### 4.3 Sub-pixel width differences change line breaking

The `orphans-widows` probe initially mismatched on 2 of 15 lines. The cause was
not fragmentation: the probe pinned `#doc` to `100mm` (377.95 px) while the
real print content box was 377.54 px. The 0.4 px difference moved one word
("it") across a line break.

Pinning both modes to an identical explicit content width took the probe to
15/15 at 0.00 px.

The general lesson, consistent with findings 02's 0.82 px incident: **the
oracle's column width must match Chromium's print content width to sub-pixel
precision.** It affects line breaking, not merely page assignment.

---

## 5. What this changes

The oracle is stronger than findings 02 could claim — five fragmentation rules
now verified exactly rather than one fixture's worth of evidence — and the
divergences are bounded and named rather than unknown.

All four share one shape: **content that paged media repeats or re-geometries
per page, which column fragmentation has no concept of.** That is a coherent
category, not a scattering of special cases, which suggests the hybrid
controller from findings 02 §5 can address them as one mechanism: identify
per-page furniture, remove it from the oracle's flow, reserve its height, and
re-emit it on each fragment.

### Still unprobed

`@page` margin boxes (`@top-center` etc. — Chromium's support is limited),
`break-inside: avoid` on table rows specifically, images and replaced elements
at a boundary, nested fragmentation contexts, `page-break-*` legacy aliases,
and `position: sticky`.

---

## 6. Next

1. **Per-page furniture controller** — one mechanism covering repeated `thead`,
   `tfoot`, and fixed elements. This is now well-specified by the matrix.
2. **Generated content in the extractor** — `::marker`, `::before`, `::after`,
   `counter()`. Findings 01 scope, and now demonstrated to matter.
3. **Font registry with loud diagnostics** — still the most dangerous
   outstanding behaviour: a missing glyph became `U+0000` silently.
4. **Gate 3 — boxes and paint order**, still untouched.
