# Supported features

What Garri does and does not turn into PDF, with the evidence for each.

**Legend**

| | |
| --- | --- |
| ✅ | Emitted natively |
| 🟡 | Emitted with a stated caveat |
| 🖼 | Rasterised — correct output, but not vector |
| ❌ | Not emitted |

Every detectable ❌ logs/returns a diagnostic code in `render().diagnostics`.
Browser-discarded CSS such as `@page :blank` cannot be detected after parsing.

The test environment is documented in [COMPATIBILITY.md](COMPATIBILITY.md).

---

## Text

| Feature | | Notes |
| --- | --- | --- |
| Selectable text | ✅ | Real text operators, not outlines |
| Embedded, subset fonts | ✅ | Discovered automatically from accessible `@font-face` rules and subset by default |
| OpenType/CFF (`.otf`) outlines | ✅ | Rebuilt as TrueType before embedding. Cubic outlines are converted to quadratics |
| WOFF2 with transformed `glyf` | ✅ | Rebuilt from decoded outlines and reported as `PDF_FONT_RECONSTRUCTED`. Composite glyphs are flattened, variation axes use the default instance, and hinting instructions are omitted |
| Baseline placement | ✅ | `top + ascent`, confirmed in Blink source; platform-invariant |
| Per-word positioning | ✅ | Word origins come from the browser's own measurements, limiting drift across a line |
| Per-character correction | 🟡 | Re-anchors text when embedded-font advances drift more than 0.12 pt. It currently works at Unicode code-unit boundaries, which can split complex shaping clusters |
| `letter-spacing` | ✅ | `Tc` |
| `text-transform` | ✅ | Applied per character, so positions stay aligned with the measured glyphs |
| Complex scripts — Arabic, Hebrew | 🟡 | Fonts are embedded and RTL word extents are measured, but Arabic joining can be split by per-character correction and overlap in the PDF |
| Devanagari | 🟡 | Conjuncts and vowel marks can be split and overlap; copied text may also be reordered. Cluster-aware shaping is still required |
| Per-glyph font fallback | ✅ | Metrics from the primary family, glyphs from the first family that covers the character |
| System fonts (no `@font-face`) | 🟡 | No bytes to embed → standard PDF font, `PDF_FONT_SUBSTITUTED`. Positions stay correct (measured Δx −0.10 pt, Δy −0.20 pt) but glyph *widths* differ by ~2 pt, which is the largest single source of pixel difference against Chromium. The same document measured 1.32 % with an embeddable font against 4.12 % on system fonts |
| Substituted-font encoding | ✅ | The 14 standard fonts are WinAnsi-only — ASCII, Latin-1 **and the 0x80–0x9F block**, which holds the quotes, dashes and bullets real documents are full of. Characters outside it are dropped individually and reported, not the line they appear in |
| Text layer (`ToUnicode`) | ✅ | Whole-embedded faces map the strings actually drawn; subsetted faces use pdf-lib's map |
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
| `background-repeat` | 🟡 | Painted once rather than tiled; returns `PDF_PAINT_UNSUPPORTED` |
| Borders, solid | ✅ | Each side a mitred trapezoid, so non-uniform widths and colours work |
| Borders, dashed / dotted | ✅ | Dash constant, gap stretched to fit — derived from Chromium's own output, including its thin-border special case |
| Borders, other styles | ❌ | `groove`, `ridge`, `inset`, `outset`, `double` |
| `border-radius` | ✅ | Single scale factor across the whole box, per css-backgrounds-3 §4.5 |
| `clip-path` (`circle`, `polygon`, `inset`) | ✅ | |
| `clip-path: url(#…)` | ❌ | SVG-referenced clips on HTML elements |
| `overflow` clipping | ✅ | Including inherited ancestor clips — and text too: a label outside an `<svg>`'s viewBox is not drawn, because Chromium does not draw it either. Only text with no intersection at all is dropped |
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
| WebP, AVIF, GIF | 🟡 | Browser-decodable formats are re-encoded to PNG via canvas. PNG, JPEG, and WebP have automated fixtures; AVIF and GIF do not. `PDF_IMAGE_REENCODED` |
| `object-fit` / `object-position` | ✅ | All five values, validated against Chromium's own matrices |
| Rounded / overflowing images | ✅ | Clipped |
| `<canvas>` | 🖼 | Embedded as PNG — a canvas is only ever pixels |
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
| `<text>` | 🟡 | Drawn by the text pipeline like any DOM text, so labels are correct — including their size, which is scaled by the viewBox transform. Rotated and skewed text is drawn rotated, from the baseline origin and angle the SVG DOM reports; its advances come from the font rather than the browser, the only place in the pipeline where that is true. Anchors, `textLength` and per-glyph `rotate` are not honoured |
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

## Developer API

| Feature | | Notes |
| --- | --- | --- |
| pdf-lib document access | ✅ | `render()`, `download()`, and `open()` return the live `pdfDocument` used to construct the PDF |
| Pre-save customization | ✅ | `onPdfDocument` receives the completed document before `bytes` are serialized |

## Generated content

| Feature | | Notes |
| --- | --- | --- |
| `::before` / `::after` | ✅ | Materialised as real elements so the text pipeline measures them. An out-of-flow pseudo keeps `position` and its used insets, so the very common `li::before { position: absolute; left: 0 }` marker stays a marker instead of taking a line of its own |
| CSS counters | ✅ | `counter()`, `counters()`, nesting, `counter-reset` / `-increment`. An element's own increment applies before its `::before` is evaluated (css-lists-3 §4.3), so a list numbered by the item and printed by its marker reads 1, 2, 3 |
| List markers, numeric | ✅ | Placement derived from Chromium's own output: the marker's right edge sits one space-advance before the item's content box. Drawn immediately before the item's first line, which is where Chromium writes it |
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

Eleven text fixtures produce 19/19 character-exact pages. A twelfth, one-page
form fixture produces 7/7 AcroForm fields. The assertions run through all four
load paths: loose modules, IIFE, ESM, and standalone.

Reading order follows CSS 2.1 Appendix E step 8: runs are keyed by the tree
index of their nearest positioned ancestor, so a `position: relative` list is
written after a paragraph that follows it in the source — which is what
Chromium's export does. Across the ten third-party documents, 17 of 27 pages
extract in exactly Chromium's sequence as authored, 25 of 27 with fonts
equalised.

Results of testing ten HTML documents from
[tw93/Kami's demo set](https://github.com/tw93/Kami/tree/main/assets/demos) are
kept in [COMPARISON.md](COMPARISON.md).
