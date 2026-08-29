# Findings 06 — SVG as native vectors

**Status:** SVG PASS — geometry, paint servers and clipping all reproduce
**Updated:** gradients and `clipPath` wired in (see §8)
**Date:** 2026-08-29
**Chromium:** Google Chrome for Testing 152.0.7977.54 (arm64, headless)
**Scope:** plan §19, build-order item 3

SVG was the largest remaining *unknown* in the supported feature set — untested
in either direction. It reproduces natively.

Run: `node experiments/svg-render.js`

---

## 1. Result

16 shapes across four `<svg>` elements: `path`, `rect` (plain and rounded),
`circle`, `ellipse`, `line`, `polygon`; strokes with width, caps, joins and
dashes; cubic and smooth curves; `fill-rule: evenodd`; nested
`transform`/`viewBox`; group opacity; and two deliberately hard cases.

| Metric | first pass (14 shapes) | after §8 (all 16) |
| --- | --- | --- |
| Pixels differing > 32/255 | 0.183 % | **0.161 %** |
| Mean absolute difference | 0.225 / 255 | **0.194 / 255** |
| Ink delta | 0.27 % | **0.22 %** |
| Shapes painted | 14 of 16 | **16 of 16** |
| Declared unsupported | 2 | **none** |

That is the same sub-pixel band as text (findings 01) and boxes (findings 04).

Two shapes are **declined with diagnostics** rather than approximated:

```
e-grad       paint-server fill    url("#grad")
e-clipped    clip-path            url("#clip")
```

---

## 2. `getScreenCTM()` is the SVG coordinate oracle

SVG's hard part is not drawing primitives — it is coordinate resolution:
`viewBox`, `preserveAspectRatio`, nested `transform`, unit handling. Getting
that wrong is the usual reason SVG-to-PDF converters drift.

None of it is reimplemented. `SVGGraphicsElement.getScreenCTM()` returns the
fully resolved matrix from an element's user space to viewport pixels, with
`viewBox` and every ancestor transform already folded in. The backend just
concatenates it:

```
T = P · M          M = getScreenCTM()
                   P = viewport px -> PDF pt (including the y-flip)
```

This is the same move as `Range` rects for text and multicolumn for pagination,
applied to a third subsystem — and it is why a nested
`transform="translate(30,110) rotate(-12) scale(1.3)"` inside a `viewBox`-scaled
SVG needed no special handling at all.

A useful side effect: because the matrix carries the scale, `stroke-width`,
dash arrays and miter limits are emitted in user units and scale correctly for
free.

---

## 3. Owning the path emitter was necessary

The first version delegated to pdf-lib's `drawSvgPath`. Two measured failures
made that untenable, and both are fixed by `src/pdf/svgPath.js` — our own
SVG-path-to-PDF-operator emitter (~180 lines, including endpoint-to-centre arc
conversion).

### 3.1 No control over fill rule

`drawSvgPath` always fills nonzero. The `evenodd` test — two nested rectangles
that should render as a ring — came out **solid**, with the hole filled in.

PDF expresses fill rule in the paint *operator*, not the graphics state, so it
must be chosen at emit time. pdf-lib can emit `f*` internally but exposes no
option for it. Emitting operators directly gives the full set:

| fill | stroke | nonzero | evenodd |
| --- | --- | --- | --- |
| yes | yes | `B` | `B*` |
| yes | — | `f` | `f*` |
| — | yes | `S` | `S` |

### 3.2 Smooth curves disagreed with Chromium

`S` and `T` reflect the previous control point through the current point.
pdf-lib's parser got this wrong; ours reflects explicitly:

```
M 20 100 C 40 20, 90 20, 110 100 S 180 180, 200 100
                                   -> reflected control point = (130, 180)
```

Owning the emitter also removes future dependence on a third-party parser for
the one primitive SVG is actually made of.

---

## 4. The finding that was not obvious: SVG viewports clip

The curve test overshot Chromium at the bottom of its second hump, and the
cause was not the curve maths.

**An outer `<svg>` establishes a viewport that clips its content.** The
fixture's third SVG is 150 px tall; the curve reaches y ~ 160. Chromium clips
it; we were painting the overflow.

A renderer that ignores this puts ink on the page the browser never showed — and
it fails silently, because the SVG source looks perfectly reasonable. The fix is
a clip rectangle in page space, applied *before* the shape matrix:

```
x y w h re W n
```

The clip comes from the `<svg>` element's own bounding rect, gated on computed
`overflow !== 'visible'`.

---

## 5. Declining beats approximating

The first version reported `clip-path` as unsupported and then **painted the
shape anyway, unclipped**. That is worse than omitting it: it puts a full
rectangle where the author asked for a circle, and the diagnostic is easy to
overlook next to plausible-looking output.

The extractor now marks such shapes `skip` and the renderer paints nothing. The
visual diff then shows an honest hole rather than confidently wrong ink.

This is the plan's §26 raster-fallback case: such shapes should eventually be
rasterised per subtree, not dropped. Until that exists, silence is the correct
placeholder and the diagnostic is the product.

---

## 6. Not supported, and reported as such

| Feature | Status |
| --- | --- |
| `linearGradient` / `radialGradient` / `pattern` | declined — PDF shading dictionaries not implemented |
| `clip-path`, `mask` | declined — needs the clip path emitted before the shape |
| `filter` | declined — raster-fallback territory |
| SVG `<text>` | **untested** — should route through the text pipeline, not the path emitter |
| `<use>`, `<symbol>`, `<marker>` | untested |
| `matrix3d` / 3D transforms | explicitly unhandled |

Gradients and clipping are both tractable: PDF has native axial and radial
shadings, and clipping is `W n` with a path we can already emit. Neither is a
research question — they are implementation work with a known shape.

---

## 7. What this changes

SVG moves from *unknown* to *known*: geometry, transforms, strokes, fill rules
and viewport clipping all reproduce to sub-pixel, and the gaps are enumerated
with known remedies rather than open questions.

The largest remaining unknown in the supported feature set is now **images and
link annotations** (build-order item 4), followed by scale behaviour.


---

## 8. Update — gradients and `clipPath` wired in

The two features §6 declined are now implemented, using machinery built for CSS
paint in findings 08.

**SVG gradients.** `fill="url(#id)"` is dereferenced to the paint-server
element and turned into the same PDF shading used for CSS gradients. The SVG
specific part is units: `gradientUnits` defaults to **objectBoundingBox**, so
`x1/y1/x2/y2` are fractions of the shape's own `getBBox()` rather than user-space
lengths. `userSpaceOnUse` is handled too. Stop opacity is folded into the stop
colour, and a gradient with any transparent stop is still declared unsupported —
PDF shadings carry no alpha without a soft mask.

**SVG `clipPath`.** Each child of the referenced `<clipPath>` becomes a path via
the same emitter, applied as a clip before the shape's own matrix.

One PDF detail forced the shape of that code: a clip cannot be wrapped in
`q`/`Q`, because restoring the graphics state discards the clip along with the
transform. So each clip child's matrix is concatenated, the path emitted and
clipped, and then the **inverse matrix** concatenated to restore the coordinate
system while leaving the clip in force.

Result: **16 of 16 shapes painted, nothing declared unsupported**, whole-fixture
difference 0.161 %.

Still out of scope here: SVG `<text>`, `<use>`/`<symbol>`/`<marker>`, patterns,
masks, filters, and gradients with alpha stops.
