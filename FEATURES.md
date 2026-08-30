# Supported features

What PeeDeeEff does and does not turn into PDF, with the evidence for each.

**Legend**

| | |
| --- | --- |
| ✅ | Emitted natively, verified against Chromium's own `printToPDF` |
| 🟡 | Emitted with a stated caveat |
| 🖼 | Rasterised — correct output, but not vector |
| ❌ | Not emitted. Reported as a diagnostic, never dropped silently |

Every ❌ produces a diagnostic code in `render().diagnostics`, so a document
that hits one tells you rather than quietly losing content.

Measured on Chrome for Testing 152, macOS arm64. See
[`docs/evidence-classes.md`](docs/evidence-classes.md) for which claims are
spec-mandated, which are confirmed in Blink source, and which are measured on
one machine only.

---

## Text

| Feature | | Notes |
| --- | --- | --- |
| Selectable text | ✅ | Real text operators, not outlines |
| Embedded, subset fonts | ✅ | From `@font-face`; discovered automatically |
| Baseline placement | ✅ | `top + ascent`, confirmed in Blink source; platform-invariant |
| Per-word positioning | ✅ | Positions come from the browser's own measurements, so shaping divergence cannot accumulate |
| `letter-spacing` | ✅ | `Tc` |
| `text-transform` | ✅ | Applied per character, so positions stay aligned with the measured glyphs |
| Complex scripts — Arabic, Hebrew | ✅ | RTL word extents measured across every character |
| Devanagari | 🟡 | Glyphs and positions correct; text *copies out* reordered. Needs `/ActualText` |
| Per-glyph font fallback | ✅ | Metrics from the primary family, glyphs from the first family that covers the character |
| System fonts (no `@font-face`) | 🟡 | No bytes to embed → standard PDF font, `PDF_FONT_SUBSTITUTED`. Positions stay correct (measured Δx −0.10 pt, Δy −0.20 pt) but glyph *widths* differ by ~2 pt, which is the largest single source of pixel difference against Chromium. The same document measured 1.32 % with an embeddable font against 4.12 % on system fonts |
| Missing glyph | ✅ | `PDF_GLYPH_UNAVAILABLE` rather than a silent `U+0000`. Coverage is checked per character against the declared family list, so a word mixing scripts is drawn as several segments, each at its own measured x — and a character no declared family covers is omitted and reported, not written as glyph 0 |
| Vertical writing modes | ❌ | Untested and unimplemented |
| `::first-line`, `::first-letter` | ❌ | Untested |

## Layout and pagination

| Feature | | Notes |
| --- | --- | --- |
| Page fragmentation | ✅ | Chromium's own, via a multicolumn container. CSS Fragmentation defines page and column boxes as the same kind of container, so this is spec-mandated rather than a trick |
| `break-before` / `break-after` / `break-inside` | ✅ | Honoured by Blink, not reimplemented |
| `orphans` / `widows` | ✅ | Same |
| `@page { size, margin }` | ✅ | Read from the CSSOM |
| `@page` margin boxes | ✅ | 16 slots; running headers and footers |
| `counter(page)` / `counter(pages)` | ✅ | Document-global, not per run |
| `@page :first` / `:left` / `:right` | ✅ | Cascade applied per margin slot. This is the complete set Blink implements — confirmed in `css_selector.cc` |
| Named pages (`page: name`) | ✅ | One oracle pass per run, each with its own geometry; nested runs included |
| `@page :blank` | ❌ | A genuine Chromium gap: the selector fails to parse, so the whole rule is dropped from the CSSOM |
| `break-before: <page-name>` | ❌ | Not valid CSS — css-break-3 admits keywords only. Chromium is conformant; use a page context |

## Page furniture

| Feature | | Notes |
| --- | --- | --- |
| Repeating `<thead>` | ✅ | Re-issued per page, height reserved so rows still land correctly |
| Repeating `<tfoot>` | ✅ | Reserved at the opposite end |
| `position: fixed` | 🟡 | Repeats per page. **Render at page box width** (794 px for A4) or placement is wrong — `PDF_VIEWPORT_MISMATCH` |
| `position: sticky` | ✅ | Correctly treated as *flow*, not furniture |
| Nested repeating contexts | ✅ | Outer and inner tables both repeat |

## Paint

| Feature | | Notes |
| --- | --- | --- |
| `background-color` | ✅ | |
| `linear-gradient` | ✅ | Native PDF axial shading (type 2) |
| `radial-gradient` | ✅ | Native radial shading (type 3); ellipses via a scale about the centre |
| Gradients with alpha stops | ❌ | Needs a soft mask. `PDF_PAINT_UNSUPPORTED` |
| `background-image: url()` | ✅ | With `cover` / `contain` / explicit size and position |
| `background-repeat` | ❌ | Painted once, not tiled |
| Borders, solid | ✅ | Each side a mitred trapezoid, so non-uniform widths and colours work |
| Borders, dashed / dotted | ✅ | Dash constant, gap stretched to fit — derived from Chromium's own output, including its thin-border special case |
| Borders, other styles | ❌ | `groove`, `ridge`, `inset`, `outset`, `double` |
| `border-radius` | ✅ | Single scale factor across the whole box, per css-backgrounds-3 §4.5 |
| `clip-path` (`circle`, `polygon`, `inset`) | ✅ | |
| `clip-path: url(#…)` | ❌ | SVG-referenced clips on HTML elements |
| `overflow` clipping | ✅ | Including inherited ancestor clips |
| `opacity` | ✅ | `ExtGState` |
| `mix-blend-mode` | ✅ | Native PDF `/BM` — the CSS and PDF name sets match |
| `box-shadow`, outer | 🖼 | Rasterised. Chromium's own export rasterises it too |
| Root / `<body>` background | ✅ | Propagates to the canvas and fills the whole page, margins included |
| `box-shadow`, inset | ❌ | `PDF_SHADOW_NOT_EMITTED` |
| `filter` | ❌ | No PDF equivalent, and unlike a shadow there is no shape to redraw — rasterising would mean rendering an arbitrary DOM subtree, which a page cannot do to its own canvas |

## Media

| Feature | | Notes |
| --- | --- | --- |
| PNG, JPEG | ✅ | Original bytes passed through, not re-encoded |
| WebP, AVIF, GIF | 🟡 | Re-encoded to PNG via canvas — lossless but larger. `PDF_IMAGE_REENCODED` |
| `object-fit` / `object-position` | ✅ | All five values, validated against Chromium's own matrices |
| Rounded / overflowing images | ✅ | Clipped |
| `<canvas>` | ✅ | Embedded as PNG — a canvas is only ever pixels |
| Cross-origin tainted `<canvas>` | ❌ | Cannot be read back. `PDF_CANVAS_TAINTED` |
| Inaccessible image bytes | ❌ | `PDF_RESOURCE_INACCESSIBLE` — the browser may display it, a PDF needs the bytes |

## SVG

| Feature | | Notes |
| --- | --- | --- |
| `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon` | ✅ | Via `getScreenCTM()` as the coordinate oracle |
| Transforms | ✅ | Composed into the page matrix |
| Fill rules (`nonzero`, `evenodd`) | ✅ | `f` / `f*` / `B` / `B*` |
| Strokes: width, cap, join, miter, dash | ✅ | |
| Gradient paint servers | ✅ | Native shadings |
| `<clipPath>` | ✅ | Each child applied in page space, then the matrix inverted |
| Viewport clipping | ✅ | An outer `<svg>` clips its content by default |
| `<use>` / `<symbol>` | ✅ | Resolved by inlining a clone and letting the browser compute the CTM |
| `<text>` | ❌ | |
| Patterns, masks, filters | ❌ | Need tiling patterns and soft masks. `PDF_SVG_UNSUPPORTED` |

## Interactive

| Feature | | Notes |
| --- | --- | --- |
| Links | ✅ | Real annotations, one rect per line fragment, plus replaced descendants that `getClientRects()` alone would miss |
| `<input type=text\|email\|url\|tel\|number\|date\|…>` | ✅ | Fillable AcroForm text fields |
| `<textarea>` | ✅ | Multiline field |
| `<select>` | ✅ | Dropdown |
| `<input type=checkbox>` | ✅ | |
| `<input type=radio>` | ✅ | Grouped into one PDF field with several widgets |
| `<input type=file\|range\|color>`, multi-select | ❌ | No AcroForm equivalent. `PDF_FORM_NOT_EMITTED` |
| Bookmarks / outline | ❌ | Not implemented |
| Tagged PDF / accessibility | ❌ | Not implemented |

**Note:** by default form controls become *fillable fields*, which is a
deliberate divergence from a browser's own print — that flattens them to drawn
text. Use `forms: 'flatten'` to match the browser, or `'none'` to omit.

## Generated content

| Feature | | Notes |
| --- | --- | --- |
| `::before` / `::after` | ✅ | Materialised as real elements so the text pipeline measures them |
| CSS counters | ✅ | `counter()`, `counters()`, nesting, `counter-reset` / `-increment` |
| List markers, numeric | ✅ | Placement derived from Chromium's own output |
| List markers, bullets | 🟡 | Exact at 16 px; the placement rule is not linear in em, so other sizes are approximate |

---

## Fidelity

Pixel difference against Chromium's own `printToPDF`, 150 dpi, worst-of-three
channels, share of pixels differing by more than 32/255:

| Fixture | |
| --- | --- |
| SVG geometry and paint servers | 0.026 % |
| Backgrounds, gradients, borders, shadow | 0.117 % |
| SVG `<use>` / `<symbol>` | 0.157 % |
| Text only *(control)* | 0.213 % |
| Shadow, blend mode, canvas | 0.388 % |
| Images and links | 0.457 % |

12 fixtures, 19/19 pages character-exact for text, 7/7 AcroForm fields, on all
four load paths (loose modules, IIFE, ESM, standalone).

Against ten third-party documents we did not write — [tw93/Kami](https://github.com/tw93/Kami)'s
demo set — every one paginates to exactly Chromium's page count, the worst
single page differs by 8.01 %, and the mean is 3.84 %. Forcing an embeddable
face on both sides takes the mean to 2.17 %, so 43 % of that difference is font
substitution rather than rendering. See [`kami/COMPARISON.md`](kami/COMPARISON.md).

## Scale

83 pages in 1.9 s, 727 KB, 112 MB peak heap — linear or better, since fixed
startup cost amortises. Throughput plateaus at ~98 500 chars/second. Drawing,
not extraction, is 56 % of the time.

## Known limits of the evidence

One browser (Chrome for Testing 152), one platform (macOS arm64). A two-build
version check (m148 vs m152) moved nothing. Windows is unverified and the docs
say so rather than implying a matrix that never ran.
