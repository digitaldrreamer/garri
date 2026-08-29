# PeeDeeEff

Turn a DOM element into a real PDF — selectable text, embedded fonts, vectors —
entirely in the browser. No server, no second Chromium, no rasterising.

```html
<script src="dist/peedeeeff.standalone.js"></script>
<script>
  await PeeDeeEff.download(document.getElementById('doc'), 'report.pdf');
</script>
```

That's it. Fonts are picked up from the page's own `@font-face` rules.

## Install

```
npm install                # dev only; the SDK itself has no runtime install step
npm run build              # writes dist/
npm run demo               # http://127.0.0.1:8080/demo/ — exercises every feature

`demo/`, `docs/` and the test harnesses live in the repository, not in the npm
package — the package ships only `src/`, `dist/` and the licence files.
```

## Builds

| File | Gzipped | Use |
| --- | --- | --- |
| `dist/peedeeeff.standalone.js` | 575 KB | **Start here.** pdf-lib + fontkit included. One tag, nothing to wire. |
| `dist/peedeeeff.js` | 42 KB | You already load pdf-lib and fontkit yourself. |
| `dist/peedeeeff.mjs` | 42 KB | `import { render } from 'peedeeeff'` |

For the two small builds, load `pdf-lib` and `@pdf-lib/fontkit` first (they are
`peerDependencies`), or pass them as `options.pdfLib` / `options.fontkit`.

## API

```js
PeeDeeEff.render(element, options?)        // -> { bytes, pages, diagnostics, stats }
PeeDeeEff.renderToBlob(element, options?)  // -> Blob
PeeDeeEff.download(element, filename?, options?)
PeeDeeEff.open(element, options?)          // new tab
PeeDeeEff.discoverFonts()                  // what it found in the CSSOM
```

### Options

| Option | Default | |
| --- | --- | --- |
| `fonts` | discovered from `@font-face` | `[{ family, src, weight?, style? }]` |
| `page` | read from `@page` | `{ widthMm, heightMm, marginMm }` |
| `columns` | `24` | max pages per named-page run |
| `generatedContent` | `true` | materialise `::before` / `::after` / counters |
| `forms` | `'fields'` | `'fields'` fillable AcroForm · `'flatten'` draw values as text · `'none'` |
| `onDiagnostic` | — | called per diagnostic as it happens |
| `pdfLib`, `fontkit` | globals | only needed for the non-standalone builds |

## Getting good output

1. **Render at page width.** `position: fixed` resolves against the viewport;
   in print it resolves against the page box. A4 at 96 dpi is **794 px**. Match
   them and placement is exact — measured at 0.00 pt error, versus 227 pt at a
   1400 px viewport. You get `PDF_VIEWPORT_MISMATCH` if they differ.
2. **Declare `@font-face`.** A system font has no bytes to embed, so it falls
   back to a standard PDF font (`PDF_FONT_SUBSTITUTED`). Positions stay correct
   — every word is placed from the browser's own measurements — but glyph
   shapes differ.
3. **Use `@page` for headers and footers.** Margin boxes and `counter(page)`
   work, are page-anchored by definition, and are exact here. Prefer them over
   `position: fixed`.
4. **Set `@page { size: … }`** so page geometry comes from CSS rather than the
   default A4.

## Diagnostics

Nothing is dropped silently. `render()` returns `diagnostics[]`, each with a
`code`, a `message` and a `count`:

`PDF_VIEWPORT_MISMATCH` · `PDF_FONT_SUBSTITUTED` · `PDF_GLYPH_UNAVAILABLE` ·
`PDF_COLUMN_BUDGET_EXCEEDED` · `PDF_FIXED_ANCHOR_AMBIGUOUS` ·
`PDF_IMAGE_REENCODED` · `PDF_RESOURCE_INACCESSIBLE` · `PDF_PAINT_UNSUPPORTED` ·
`PDF_SVG_UNSUPPORTED` · `PDF_SVG_PARTIAL` · `PDF_SHADOW_NOT_EMITTED` ·
`PDF_CANVAS_TAINTED` · `PDF_FILTER_NOT_EMITTED` · `PDF_FORM_NOT_EMITTED`

## Scope — what works today

Full matrix, with diagnostics and caveats for every row: **[FEATURES.md](FEATURES.md)**.

**Renders:** text with embedded fonts and correct baselines · complex scripts
(Arabic, Hebrew, Devanagari) · pagination via Chromium's own fragmentation ·
repeating `<thead>`/`<tfoot>` · `position: fixed` furniture · `@page` margin
boxes with page counters · named pages with per-run geometry · `::before` /
`::after` and counters · **backgrounds, gradients (native PDF shadings),
background-images, borders including dashed and dotted, `clip-path`** ·
**images** (PNG/JPEG byte-for-byte, `object-fit`, rounded clipping) ·
**link annotations** · **SVG** (geometry, transforms, strokes, fill rules,
paint servers, clipping, `<use>` / `<symbol>`) · **`box-shadow`** (rasterised,
as Chromium's own export does) · **`mix-blend-mode`** (native PDF `/BM`) ·
**`<canvas>`** · **form controls as fillable AcroForm fields**.

Pixel difference against Chromium's own `printToPDF`, 150 dpi:

| Fixture | Differing > 32/255 |
| --- | --- |
| SVG | 0.026 % |
| backgrounds, gradients, borders, shadow | 0.117 % |
| SVG `<use>` / `<symbol>` | 0.157 % |
| text only *(control)* | 0.213 % |
| shadow, blend mode, canvas | 0.388 % |
| images and links | 0.457 % |

**Not supported:** CSS `filter` (no PDF equivalent, and a DOM subtree cannot be
rasterised from inside the page) · inset `box-shadow` · SVG `<text>`, patterns
and masks · vertical writing modes · `<input type=file|range|color>` and
multi-select, which have no AcroForm equivalent. WebP and AVIF are re-encoded to
PNG, which inflates them. A cross-origin-tainted `<canvas>` cannot be read back
and reports `PDF_CANVAS_TAINTED`.

Only the small builds omit the emitters; there you get `PDF_*_NOT_EMITTED`
instead.

Verified against Chromium's own `printToPDF` on every fixture — 18/18 pages
character-exact across eleven fixtures, plus 7/7 AcroForm fields, on all four
load paths. See `docs/` for the
full record, and `docs/feasibility-verdict.md` for what is measured versus
assumed.

**Status: `0.1.0-alpha.1`.** One browser, one platform. Read
`docs/evidence-classes.md` before relying on any specific number.

## Licence

MIT — see [`LICENSE`](LICENSE).

The fonts in `fixtures/` are third-party test material under their own terms
(Roboto under Apache-2.0; Noto Sans and Tinos under the SIL OFL 1.1), and the
standalone bundle vendors `pdf-lib` and `@pdf-lib/fontkit`, both MIT. See
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
