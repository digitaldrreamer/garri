# Findings 08 — Gradients, clipping, and the first raster fallback

**Status:** gradients, clipping, background-image and non-uniform borders PASS · raster fallback built
**Date:** 2026-08-29
**Chromium:** Google Chrome for Testing 152.0.7977.54 (arm64, headless)
**Scope:** the "untested" list from findings 04/06/07, plus plan §26

Run: `node experiments/paint-gaps.js`

---

## 1. Result

Per-feature pixel difference against Chromium, measured over each element's own
rect (regions derived from the live element geometry, not eyeballed off a grid):

| feature | difference | |
| --- | --- | --- |
| `linear-gradient(135deg, …)` 3 stops | **0.00 %** | native shading |
| `linear-gradient(to bottom, …)` | **0.01 %** | native shading |
| `radial-gradient(circle at …)` | **0.01 %** | native shading |
| `radial-gradient(ellipse …)` | **0.00 %** | native shading |
| `linear-gradient(90deg, …)` | 0.53 % | native shading |
| `overflow: hidden` clip | **0.00 %** | clip path |
| `clip-path: polygon(…)` | 0.01 % | clip path |
| `clip-path: circle(…)` | 0.49 % | clip path |
| `box-shadow` | **0.00 %** over the box; 1.56 % over the spill | **raster fallback** |
| non-uniform borders | 0.96 % | mitred quads |
| `background-image` contain | 0.35 % | image |
| `background-image` cover | 3.02 % | image |
| *dashed border* | 15.12 % | **not implemented** |
| *SVG gradient fill* | 100.00 % | **not implemented** |
| *SVG `clipPath`* | 25.55 % | **not implemented** |

Everything implemented lands in the sub-1 % band, except `background-image:
cover` at 3.02 % — the same scaled-image sub-pixel class as findings 07.

---

## 2. Gradients are native shadings, and so are Chromium's

CSS gradients map onto PDF shadings directly:

| CSS | PDF |
| --- | --- |
| `linear-gradient` | ShadingType 2 (axial) |
| `radial-gradient` | ShadingType 3 (radial) |
| 2 colour stops | FunctionType 2 (exponential) |
| 3+ colour stops | FunctionType 3 (stitching) over exponentials |

Two details CSS forces:

- **Implicit stop positions.** Computed style omits positions when the author
  did (`linear-gradient(90deg, A, B)` stays positionless), so stops must be
  distributed evenly between anchored ones before building `Bounds`.
- **Ellipses.** PDF radial shadings are circular only. An elliptical
  `radial-gradient` needs a scale about its centre, after which one construct
  covers both.

### A correction to my own inference

Our PDF is 7.6 KB against Chromium's 15.7 KB, and pdf.js reported
`shadingFill: 5` for ours and **0** for Chromium. I took that to mean Chromium
rasterises gradients.

**It does not.** Chromium's PDF contains `/PatternType` ×6 and `/ShadingType`
×6: it uses native shadings too, painted as *shading patterns* via `scn` rather
than through the `sh` operator, which is why pdf.js's `shadingFill` counter
stays at zero. Both outputs are vector.

That is twice now that a single signal — file size, then one operator counter —
would have produced a confident wrong claim about Chromium.

---

## 3. Clipping is inherited paint state

`overflow: hidden` clips *descendants*, so a clip is not a property of the
element that paints — it is state accumulated from ancestors. The extractor
walks up from each item collecting every ancestor with `overflow !== visible`,
and the backend applies them outermost-first before the element's own
`clip-path`.

Implemented shapes: `circle()`, `polygon()`, `inset()`. All are just paths, so
they reuse the same emitter as everything else.

---

## 4. The first raster fallback — and Chromium takes it too

PDF has no shadow primitive. Reading Chromium's operator list with the CTM
tracked showed **three** image paints: our two background images, and a third
at 141.6 × 89.3 pt on the shadow row — larger than the 150 × 80 px box, by
about the blur and offset.

**Chromium rasterises `box-shadow` into the PDF itself.** So plan §26's raster
fallback is not a concession; here it is what matching Chromium *means*.

Rather than approximate a Gaussian, the fallback uses the browser's own shadow
renderer on a canvas — the same "ask the browser" principle as `Range` rects,
multicolumn and `getScreenCTM()`. Two things had to be got right:

**Draw-then-erase, not draw-off-canvas.** The usual trick is to place the shape
far outside the surface and let a large `shadowOffsetX` bring only the shadow
back into frame. It fails: geometry that far outside is culled before the shadow
is generated, and the canvas comes back blank. Drawing the shape with its
shadow and then erasing the shape with `destination-out` keeps everything
on-surface — and is spec-correct anyway, since CSS clips an outer shadow out
from under its own box.

**Shadow parameters are in device units.** `shadowBlur`, `shadowOffsetX` and
`shadowOffsetY` are explicitly *not* affected by the canvas transform. With
`scale(3, 3)` for supersampling, a 14 px blur rendered as 14 device pixels —
a third of its intended size. The falloff sampled as a ~3 px edge against
Chromium's ~14 px:

```
x:    437    440    443    446    449
ours  217    197    238    250    255      <- blur shrunk 3x
chrome 167   180    196    201    206
```

After scaling the parameters by the supersampling factor:

```
ours  217    177    194    209    223
chrome 167   180    196    212    226      <- within 3 luma units
```

The shadow region went from 10.18 % to **1.56 %** differing.

---

## 5. Still not implemented

| feature | measured gap | note |
| --- | --- | --- |
| SVG gradient fill (`url(#…)`) | 100 % | the shading machinery now exists; it needs wiring to the SVG paint-server resolver |
| SVG `clipPath` (`url(#…)`) | 25.6 % | likewise — the clip machinery exists |
| dashed / dotted borders | 15.1 % | needs per-side dash emission |
| `repeating-linear-gradient` | — | declared, not emitted |
| gradients with alpha stops | — | needs a soft mask; declared |
| inset `box-shadow` | — | declared |
| `background-repeat` tiling | — | only `no-repeat`-equivalent placement is emitted |

The two SVG items are the notable ones: findings 06 declined them for lack of
machinery that now exists. They are wiring, not research.

---

## 6. What this changes

The paint surface a document actually uses is now covered: flat fills, borders
(uniform and not), radii, gradients, background images, clipping, transforms,
opacity, and shadows via a fallback that matches Chromium's own approach.

Plan §26's raster fallback has moved from an idea to a working mechanism with a
real first customer — which matters more than the shadow itself, because it is
the escape hatch every remaining unsupported effect will use.
