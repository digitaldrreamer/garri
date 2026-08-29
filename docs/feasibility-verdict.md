# Feasibility verdict

**Deliverable 9 (plan §46).**
**Date:** 2026-08-29
**Verdict: GO WITH SCOPE.**

The architecture is sound. For controlled document rendering, Chromium's
already-rendered DOM is a sufficient layout oracle to reconstruct a native,
searchable, vector-oriented PDF entirely client-side.

None of the plan's five critical failure conditions (§38) holds.

---

## 1. Evidence

All five gates now have measured results, each scored against the PDF the same
Chromium instance produced for the same page.

| Gate | Verdict | Measurement |
| --- | --- | --- |
| 1 — Text geometry | **PASS** | baseline error **0.0000 px** mean and max (n=18); left edge 0.0078 px max; 381/381 chars round-trip; ink pixels identical to Chromium (26926 vs 26926) |
| 2 — Text shaping | **PASS** (core claim) | browser-measured word positions give 0.053 pt mean width error; complex-script **glyph selection confirmed** across Latin ligatures, Arabic cursive joining, Hebrew, Devanagari conjuncts and bidi — 0.302 % pixels differing (findings 05). Devanagari *extraction order* still wrong |
| 3 — Paint reconstruction | **PASS** | paint order exact **17/17**; box decoration 0.239 % pixels differing, 0.12 % ink delta |
| 4 — Pagination | **PASS** | **100 %** page assignment (109/109); 0.00 px vertical error on unaffected pages; 4 enumerated divergences |
| 5 — PDF backend | **PASS — complete** | native text, subset fonts, paths, transforms, opacity, multi-page; SVG at **0.161 %** pixel difference including gradients and clipping; **native image passthrough** (PNG/JPEG original bytes) and **link annotations matching Chromium 6/6** (findings 07) |

And the thesis itself, verified end to end:

| Client-side pipeline | Result |
| --- | --- |
| PDF built entirely inside the browser | 7.7 KB, 12 runs, **85 ms** total in-page |
| Text recoverable from those bytes | 381 chars, exact |
| Delivery without a server | `Blob` + object URL confirmed |
| Client bundle | 539 KB gzipped (pdf-lib 202, fontkit 332, ours 5) |

No Puppeteer, server Chromium, or native helper is involved in producing the
document. Node's only role in the harness is driving the browser and holding
the ground truth.

---

## 2. The five critical failure conditions

**A — "browser text positioning cannot be recovered with sufficient precision."**
Refuted. `Range rect.top + fontBoundingBoxAscent` reproduces Chromium's baseline
*exactly*, because a Range's client rect for text is the **font box**, not the
line box — `rect.height == ascent + descent` regardless of line-height. It
survives per-glyph font fallback, mixed fonts on one line, and `vertical-align`
shifts, all at 0.000 px.

**B — "identical fonts and HarfBuzz still produce unresolvable placement
differences."** Avoided rather than refuted, which is better. Positioning each
word at its *browser-measured* x makes kerning, shaping, justification and
`word-spacing` divergence **structurally impossible** rather than merely
handled. Width error fell from 33.75 pt to 0.305 pt.

**C — "correct paint order requires hidden browser information."** Refuted.
Order is exactly recomputable from computed style: 17/17, including negative
z-index, z-index trapped inside an `opacity` stacking context, and an in-flow
block painting *before* an earlier positioned sibling.

**D — "common page fragmentation cannot be reproduced without implementing much
of Blink."** Refuted, and this was the big one. A multicolumn container whose
column height equals the page content height makes **Blink do the fragmenting**;
we read back which column each line landed in. `break-inside: avoid`,
`break-after: avoid`, orphans, widows and forced breaks all reproduce exactly.

**E — "no practical browser-side PDF backend."** Refuted for text and vectors.
pdf-lib + fontkit produced correct output at 539 KB gzipped.

---

## 3. What is proven, assumed, and untested

Stated plainly, because the gates above are easy to over-read.

### Proven by measurement

**Scale to 83 pages** (1.9 s, 727 KB, 112 MB peak, better-than-linear) ·
text baselines and advances · line-fragment recovery · paint order · box
backgrounds, uniform borders, border-radius (both forms), opacity, 2D
transforms · page fragmentation for the five core CSS rules · native text
extraction · font subsetting and embedding · complex-script glyph selection ·
SVG geometry, transforms, strokes, fill rules and viewport clipping ·
native image passthrough and object-fit · link annotations ·
CSS gradients as native shadings, clipping, non-uniform borders, and a working
raster fallback for box-shadow · **generated content and list markers** ·
fully in-browser assembly.

### Assumed, and load-bearing

- **Controlled inputs.** Fonts registered explicitly; assets same-origin or
  CORS-readable. The plan's §41 constraint is doing real work.
- **One Chromium, one platform.** *Every* number in this programme comes from
  Chrome for Testing 152.0.7977.54 on macOS arm64. Nothing has been checked
  across versions or platforms, and several findings are rounding rules that
  could plausibly differ.
- **Documents, not arbitrary web pages.** No fixture resembles a real
  third-party site.

### Untested — no evidence either way

- CMYK JPEGs, ICC profiles, EXIF orientation; internal (`/Dest`) link targets
- Devanagari **extraction order** — glyphs and positions are right, but
  pre-base vowel signs copy out reordered (findings 05 §5)
- Multi-face words — no fixture produced one; sub-run positioning untested
- Vertical scripts, Thai, Khmer
- `border-style` beyond `solid`/`dashed`/`dotted` — i.e. `double`, `groove`,
  `ridge`, `inset`, `outset`
- `background-repeat` tiling; `repeating-*-gradient`; gradients with alpha stops
- `::first-line`, `::first-letter`, `open-quote`, `content: url()`
- `@page` rules inside `@media print`; nesting deeper than two levels
- The 10 non-edge `@page` margin slots (corners and sides); margin-box
  `border`/`background`/`padding`
- SVG `<text>`, `<use>`, `<symbol>`, `<marker>`, patterns, masks, filters
  (SVG gradients and clipping are now implemented — findings 06 §8)
- Canvas, forms, blend modes, filters
- Documents past ~100 pages; scale with images, SVG, tables or furniture (only
  uniform text was measured); timings on other hardware.

---

## 4. Known divergences and defects

Enumerated rather than vague — each has a named cause and a bounded fix.

| Issue | Effect | Status |
| --- | --- | --- |
| **Page furniture layer** | ~~not built~~ | **BUILT — findings 11/12**; four probes pass, plus margin boxes and page counters |
| ↳ `@page` margin boxes, `counter(page)`/`counter(pages)` | running headers/footers and page numbers | **implemented** — Δx 0.24 px, Δwidth 0.00 (findings 12) |
| ↳ `position: sticky` | ~~untested~~ | **not furniture** — verified, appears on 1 of 3 pages |
| ↳ nested repeating tables | ~~untested~~ | **works** — outer and inner headers both detected and repeated |
| ↳ `table-header-group` | ~~header missing on continuations~~ | fixed — 100 % assignment, 0 missing |
| ↳ `table-footer-group` | ~~changes page assignment (22/28)~~ | fixed — 100 % assignment, 0 missing |
| ↳ `position: fixed` | ~~invents a column; 0/4 assignment~~ | fixed — 2 columns, 18/18 |
| Named pages (`page:`) | ~~scope boundary~~ | **implemented** — findings 13–15; nested runs, pseudo-class cascade, all forced-break keywords |
| `@page :blank` | dropped from the CSSOM entirely | **unsupported by Chromium** — a real limit; [`css_selector.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/css/css_selector.cc) accepts only `first`/`left`/`right`, so the whole rule fails to parse |
| `break-before: <page-name>` | computes to `auto` | **not valid CSS** — [css-break-3](https://drafts.csswg.org/css-break-3/) admits keywords only; Chromium is conformant |
| blank verso for `break-before: left`/`right` | parsed and honoured as a plain break | **Chromium does not generate one** |
| `::marker` and generated content | ~~absent from extraction~~ | **implemented** — findings 09 |
| List bullets away from 16 px | placement rule is not linear in em; declared approximate | needs more calibration points |
| Dashed / dotted borders | ~~15.1 % off~~ | **fixed** — findings 10, 13/13 exact |
| CSS `background-image` | ~~untested~~ | **done** — findings 08 (0.35 % / 3.02 %) |
| Missing glyph coverage | ~~silently becomes `U+0000`~~ | **fixed** — findings 05 |
| Devanagari extraction order | pre-base vowel signs copy out reordered | needs `ActualText` at the right granularity |
| `@pdf-lib/fontkit` complex scripts | throws without a `regeneratorRuntime` polyfill; Latin never hits the path | load the polyfill up front |
| Screen vs print layout | sub-pixel drift, ~0.5 px (31/64 LayoutUnit) | inherent; invisible |
| Page-box rounding | Chromium emits 594.96 × 841.92 pt for A4, not 595.28 × 841.89 | rule not yet derived |
| SVG gradients / `clipPath` | **implemented** — findings 06 §8 | — |
| SVG masks / filters / patterns | declined with a diagnostic | raster fallback |
| SVG `<text>` | untested — must route through the text pipeline, not the path emitter | open |
| WebP images | not embeddable by the backend; re-encoded to PNG, 4.8× larger | needs a WebP-capable backend or JPEG transcode |
| `object-fit: contain` / `scale-down` | destination height differs ~0.75 px from Chromium's matrix; rendered extents agree to 1 px | cause not established |

---

### The page furniture layer

Pagination splits cleanly into two questions, and conflating them is what makes
the divergences in this table look like unrelated bugs:

```
Page
 ├── flow content      <- the multicolumn oracle answers WHERE fragmented
 │                        content goes
 └── furniture         <- answers WHAT must independently appear on each
      ├── fixed elements                        physical page
      ├── repeated table header
      ├── repeated table footer
      └── future running headers / footers
```

All four page-vs-column divergences in findings 03 are the same shape: content
that paged media repeats or re-geometries per page, which column fragmentation
has no concept of. One mechanism covers them — identify per-page furniture,
remove it from the oracle's flow, reserve its height, re-emit it on each
fragment — and it generalises to running headers, page numbers and watermarks
rather than needing a new patch each time.

**Built in findings 11.** Three responsibilities in order — *detach* furniture
before the oracle measures, *reserve* the height it will occupy so page
assignment is right and not merely appearance, and *emit* it per page. All four
divergence probes now pass, and the plain-flow control is unchanged.

---

## 5. Recommended scope for V1

**Support:** HTML text with explicitly registered web fonts; headings,
paragraphs, lists, tables; backgrounds, borders, radii, opacity, transforms;
flexbox and grid *results* via measurement; page sizes, margins, explicit page
breaks, and multi-page documents with `break-inside`/`break-after`/orphans/
widows.

**Support with fallback:** `box-shadow` (implemented — findings 08), canvas,
complex filters, masks, unusual blend operations, browser-native controls.

**Reject loudly:** unregistered fonts, glyphs outside registered coverage,
inaccessible cross-origin resources, cross-origin iframe internals. The
`missingFont: "error"` default from plan §16 is a correctness requirement, not a
preference. **Implemented in findings 05** — the registry checks coverage per
code point and emits `PDF_GLYPH_UNAVAILABLE` rather than the silent `U+0000`
that findings 01 exposed.

**Out of scope for V1:** arbitrary third-party web pages. (Named pages and
`@page` margin boxes are both implemented — findings 12 and 13.)

---

## 6. Recommended build order

1. ~~**Font registry with loud diagnostics.**~~ **Done — findings 05.** Coverage
   enforced per code point; `PDF_GLYPH_UNAVAILABLE` replaces the silent
   `U+0000`.
2. ~~**Complex-script validation.**~~ **Done — findings 05.** Moved ahead of SVG
   deliberately, because Gate 2 was the only gate with an unproven core claim.
3. ~~**SVG.**~~ **Done — findings 06.** Geometry, transforms, strokes, fill
   rules and viewport clipping at 0.183 % pixel difference. Gradients, clipping
   and SVG text remain, all with known remedies.
4. ~~**Images and link annotations.**~~ **Done — findings 07.** Gate 5 is
   complete.
5. ~~**Page furniture layer.**~~ **Done — findings 11.** Detach, reserve, emit;
   all four divergence probes pass.
6. ~~**Generated content in the extractor.**~~ **Done — findings 09.**
   `::before`/`::after` materialised, counters implemented, markers placed by a
   rule derived from Chromium's output.
7. ~~**Scale testing.**~~ **Done — findings 16.** 83 pages in 1.9 s, 727 KB,
   112 MB peak heap; linear or better, and the ~100k chars/s extrapolation held
   at 98 492.
8. **Cross-version validation.** ~~And cross-platform.~~ **Mostly retired —
   see [`evidence-classes.md`](evidence-classes.md).** A documentary pass moved
   nine claims from "measured on one machine" to spec- or source-confirmed,
   including the two that mattered most: the multicolumn oracle is a *single
   fragmentation model shared by page boxes and column boxes* (css-break-3), not
   an implementation coincidence; and the 1/64 px LayoutUnit drift is a
   compile-time constant with no platform `#ifdef`. What remains is a **version**
   sweep over the behavioural rules still in class `U` — the A4 page-box
   rounding, the dash/gap rule, bullet placement. A full sweep was dropped as
   not worth the download volume; a **two-build spot check** (m148 vs m152, four
   majors apart) moved nothing and both controls held — findings 17. That leaves
   those rules unrefuted over a narrow span, not established. Windows stays
   unverified, and this document says so rather than implying a matrix that
   never ran.
9. ~~**Remaining paint primitives and raster fallback.**~~ **Mostly done —
   findings 08.** Gradients, clipping, non-uniform borders and a working raster
   fallback. Dashed borders, SVG paint servers and SVG clips remain.

---

## 7. Confidence

**High** that the architecture works for the documents it targets — invoices,
reports, statements, certificates. The two problems that looked hardest going
in, baselines and pagination, both turned out to have exact solutions rather
than approximations.

**Moderate** on total feature coverage, and improving. Every feature a plain
document needs — text, boxes, pagination, SVG, images, links — is now measured.
What remains untested is mostly *variants*: `background-image`, SVG gradients
and text, non-uniform borders, shadows. The shape of that work is known; none of
it is an open research question.

**Low** on cross-environment stability, because it has not been examined at all.
The programme has repeatedly found rounding rules — margins to whole pixels, a
separate page-box rounding, LayoutUnit drift, used-width rounding — that were
each discovered only when a second geometry was tried. That pattern is a warning
about the ones not yet found.

### On the reliability of these findings

Five measurement bugs in this programme produced confident, wrong numbers before
being caught, and two initially looked like findings about Chromium:

- ground truth captured *after* a DOM mutation (reported 2 pages instead of 3)
- `y % pageHeight` as a pagination model (inflated errors to ~19 px)
- assumed rather than measured column pitch (0.005 px collapsed every column)
- a pixel differ comparing only the red channel
- **a single PDF text extractor treated as ground truth.** This one shipped:
  findings 01 concluded that Chromium's PDF loses Arabic text and that we could
  be "strictly better" than Chrome. Poppler recovers the source Unicode from the
  same bytes — it was a pdf.js artifact. **Retracted**; round-trip claims now
  run against two independent extractors, and the harness prints their
  disagreement.

Each was caught by a result that was too clean or too strange to believe. That
is the right instinct to keep: the numbers in this document are good, but they
are good because they were attacked, not because they were produced.
