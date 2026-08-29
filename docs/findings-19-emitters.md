# Findings 19 — Emitters for paint, images, links and SVG

**Status:** PASS — all four emitters wired; under 1 % pixel difference
**Date:** 2026-08-29

Run: `npm test`

---

## 1. What changed

`src/` held extractors for boxes, paint, images, links and SVG, but the code
that writes them into a PDF lived in the experiments. That is why the entry
point could only draw text and reported everything else as
`PDF_*_NOT_EMITTED`. `src/pdf/emit.js` promotes those emitters — from
`paint-gaps.js`, `images-links.js` and `svg-render.js`, the experiments that
validated them — rather than rewriting them.

They work in viewport pixels and are mapped to page points by a transform the
caller supplies, because in a paginated document the same element may land in
any column.

## 2. Result

Pixel difference against Chromium's own `printToPDF`, 150 dpi, worst-of-three
channels:

| Fixture | Differing > 32/255 | Mean abs |
| --- | --- | --- |
| `svg-basic` | **0.026 %** | 0.027/255 |
| `gate1-text` (text only, for scale) | 0.213 % | 0.199/255 |
| `paint-gaps` | **0.364 %** | 0.311/255 |
| `images-links` | **0.457 %** | 0.566/255 |

The text-only fixture is the useful control: the emitters add little on top of
the error already present in text placement.

Counts on the way through: 8 backgrounds, 5 gradients as native shadings, 2
background-images, 7 borders, 12 images, 16 SVG shapes, and **6 link
annotations against Chromium's 6**.

No text regression — 9 fixtures, 17/17 pages character-exact, on all four load
paths (loose modules, IIFE, ESM, standalone).

## 3. Two bugs worth recording

**`extractSvg` returns `{ shapes, unsupported }`, not an array.** The wiring
assumed a bare array and threw on every fixture. The same class of error as
findings 18's `identify()` — assuming an extractor's shape instead of reading
it. Third time in this programme.

**Pages were derived from text columns only.** `paint-gaps.html` and
`svg-basic.html` contain no text, so the page list came back empty and nothing
was drawn at all — reported as `PDF_NO_CONTENT` while the emitters sat idle.
The page set is now the union of every column that any content type landed in,
with a floor of one page. A document of nothing but boxes still has pages.

## 4. Still not emitted

- **`box-shadow`** — no PDF primitive. The raster fallback exists (findings 08,
  and Chromium takes the same route) but is not wired into the entry point.
- **canvas, form controls, blend modes, filters.**
- **SVG `<text>`, `<use>`, patterns, masks** — reported as
  `PDF_SVG_UNSUPPORTED` / `PDF_SVG_PARTIAL`, not silently skipped.
- **WebP / AVIF** — re-encoded to PNG through a canvas, which inflates the file
  and reports `PDF_IMAGE_REENCODED`.
