# Findings 20 — Shadows, canvas, blend modes, forms, SVG `<use>`

**Status:** PASS — every remaining emitter wired except those with no PDF equivalent
**Date:** 2026-08-29

Run: `npm test`

---

## 1. Result

| Fixture | Pixel diff vs Chromium | |
| --- | --- | --- |
| `svg-basic` | 0.026 % | |
| `paint-gaps` | **0.117 %** | was 0.364 % — the shadow now renders |
| `svg-use` | 0.157 % | new |
| `gate1-text` (control) | 0.213 % | |
| `canvas-blend-shadow` | 0.388 % | new |
| `images-links` | 0.457 % | |

11 fixtures, 18/18 pages character-exact, plus 7/7 AcroForm fields, on all four
load paths.

## 2. What was added

**`box-shadow`** — rasterised, promoted from findings 08. Chromium's own export
rasterises it too, so this matches rather than approximates. The shape is drawn
*with* its shadow then erased: keeping everything on-canvas avoids the
off-screen-offset trick, which fails because geometry outside the surface is
culled before the shadow is generated. `shadowBlur` and `shadowOffset` are
device units and ignore the canvas transform, so they are scaled by hand —
missing that silently shrinks the blur by the supersampling factor.

**`mix-blend-mode`** — a direct mapping. PDF's `/BM` blend-mode names are the
same set as CSS's, capitalised, so this needed a lookup table rather than a
fallback.

**`<canvas>`** — the one element where rasterising is not a fallback but the
only correct answer: its content exists only as pixels. A cross-origin-tainted
canvas cannot be read back and reports `PDF_CANVAS_TAINTED`.

**Form controls** — as real AcroForm fields, so the PDF stays *fillable*. Note
this is a deliberate divergence from Chromium, whose print flattens controls to
drawn text. `forms: 'flatten'` reproduces Chromium's behaviour; `'fields'` is
the default because throwing away the only thing that makes a control a control
is the worse default.

**SVG `<use>` / `<symbol>`** — resolved by inlining a real clone of the referent
and letting the browser compute the CTM, rather than composing the use's matrix
with the referent's by hand. The same move this project makes everywhere else:
ask the browser instead of reimplementing it. `<symbol>` is not itself rendered,
so its *children* are cloned.

## 3. What still has no emitter, and why

- **CSS `filter`** — no PDF equivalent, and unlike `box-shadow` there is no
  shape to redraw: rasterising would mean rendering an arbitrary DOM subtree,
  which a page cannot do to its own canvas. Reported as
  `PDF_FILTER_NOT_EMITTED`.
- **Inset `box-shadow`** — the erase-the-shape trick inverts for inset; not
  attempted.
- **SVG patterns and masks** — need PDF tiling patterns and soft masks.
- **`<input type=file|range|color>`, multi-select** — no AcroForm equivalent.
- **SVG `<text>`, vertical writing modes.**

## 4. Two things worth recording

**Form fields changed what "correct" means.** The text comparison reported
`forms` as 0/1 failing, because in `fields` mode the values live in fillable
fields rather than the text layer — the test was asserting the wrong thing, not
the renderer producing the wrong output. The case now asserts field count.
A test that fails for the right reason still needs its assertion fixed.

**`flatten` has the content but not the order.** All six values are drawn, but
after the flow text rather than interleaved in document order as Chromium does,
because forms are emitted in a separate pass. Content-complete, sequence-
divergent — stated rather than papered over.
