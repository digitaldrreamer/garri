# Garri

Generate native PDFs from HTML in the browser, with selectable text, embedded
fonts, and vector graphics. No server, headless browser, or page-sized
screenshot.

Garri turns a DOM element into a PDF using the browser's computed layout. Unlike
screenshot-based HTML-to-PDF tools, it writes text as text and emits supported
CSS and SVG as PDF drawing operations. The result can be searched, selected,
copied, linked, and filled in where form fields are used.

## Status

Garri is currently **`0.1.0-alpha.1`**. It has been validated with Chrome for
Testing 152 on macOS arm64. Other browsers and platforms are not yet verified.

Garri's rendering API requires a browser page and a live DOM. It does not turn
HTML into PDF inside Node.js, and it does not launch a browser for you. Use it
where you can validate the generated documents and inspect the returned
diagnostics.

## Install

```bash
npm install garri
```

Garri uses `pdf-lib` and `@pdf-lib/fontkit` as peer dependencies. Current npm
versions install them with Garri. If your package manager does not, install all
three explicitly:

```bash
npm install garri pdf-lib @pdf-lib/fontkit
```

Garri ships as an ES module, a CommonJS build, and a browser script, with
TypeScript declarations for all three.

## Quick start

Import the download helper and supply the two PDF dependencies:

```js
import fontkit from '@pdf-lib/fontkit';
import * as PDFLib from 'pdf-lib';
import { download, render } from 'garri';

const invoice = document.querySelector('#invoice');

const result = await download(invoice, 'invoice.pdf', {
  pdfLib: PDFLib,
  fontkit,
});

console.log(`Created ${result.pages} page(s)`);
console.table(result.diagnostics);
```

Garri discovers fonts from the page's accessible `@font-face` rules. No font
configuration is needed when those rules point to font files the page can
fetch.

## Page setup

Define page size and margins with CSS:

```css
@page {
  size: A4;
  margin: 18mm;
}

@font-face {
  font-family: "Inter";
  src: url("/fonts/inter-regular.woff2") format("woff2");
  font-weight: 400;
}

#invoice {
  font-family: "Inter", sans-serif;
}
```

You can also override page geometry when rendering:

```js
const result = await render(invoice, {
  pdfLib: PDFLib,
  fontkit,
  page: {
    widthMm: 210,
    heightMm: 297,
    marginMm: 18,
  },
});
```

For predictable output:

1. Set page geometry with `@page` or the `page` option.
2. Declare downloadable fonts with `@font-face` when exact glyph shapes matter.
3. Render at the page width when using `position: fixed`. A4 is approximately
   794 CSS pixels wide at 96 pixels per inch.
4. Prefer `@page` margin boxes for running headers, footers, and page numbers.
5. Check `diagnostics` after every render.

## What Garri renders

Garri currently supports:

- Selectable text, embedded subset fonts, letter spacing, and complex scripts
- CSS pagination, page breaks, named pages, page counters, and margin boxes
- Repeating table headers and footers
- Background colors and images, gradients, borders, clipping, opacity, and
  blend modes
- PNG, JPEG, WebP, AVIF, GIF, and canvas content
- SVG geometry, transforms, strokes, gradients, clipping, and symbols
- Link annotations
- Fillable text fields, text areas, selects, checkboxes, and radio buttons
- Generated content, CSS counters, and list markers

Supported content is emitted natively where the PDF format allows it. Images
remain images. Canvas content and outer box shadows are rasterized. WebP, AVIF,
and GIF images are converted to PNG.

See [FEATURES.md](FEATURES.md) for the complete support matrix, caveats, and the
evidence behind each claim.

## Known limitations

Garri does not currently emit:

- CSS filters and inset box shadows
- SVG text, patterns, masks, and filters
- Vertical writing modes
- Tagged PDF structure, accessibility metadata, bookmarks, or outlines
- File, range, color, and multi-select form controls

Cross-origin resources must allow the page to read their bytes. Garri may be
unable to embed an image, font, stylesheet font rule, or tainted canvas that the
browser can display but JavaScript cannot access.

System fonts do not expose embeddable font bytes. Garri substitutes a standard
PDF font and reports `PDF_FONT_SUBSTITUTED`. Text positions remain based on the
browser's measurements, but the glyph shapes may differ. This is the largest
single source of difference against Chromium's own output, and it cannot be
fixed from inside a page: declare an `@font-face` when exact glyphs matter.

## Diagnostics

Garri reports unsupported or degraded output instead of silently dropping it.
Each call to `render`, `download`, or `open` resolves with a result containing:

```js
{
  bytes,        // Uint8Array
  pages,        // number
  diagnostics,  // [{ code, message, count, detail? }]
  stats,
}
```

Handle diagnostics as they occur with `onDiagnostic`:

```js
const result = await render(invoice, {
  pdfLib: PDFLib,
  fontkit,
  onDiagnostic(diagnostic) {
    console.warn(diagnostic.code, diagnostic.message);
  },
});
```

You can also inspect likely omissions without generating a PDF:

```js
import { unhandledContent } from 'garri';

console.table(unhandledContent(invoice));
```

Common diagnostic codes include `PDF_VIEWPORT_MISMATCH`,
`PDF_FONT_SUBSTITUTED`, `PDF_GLYPH_UNAVAILABLE`,
`PDF_RESOURCE_INACCESSIBLE`, `PDF_PAINT_UNSUPPORTED`,
`PDF_SVG_UNSUPPORTED`, `PDF_CANVAS_TAINTED`, and
`PDF_FORM_NOT_EMITTED`.

## API

The ES module, the CommonJS build, and `globalThis.Garri` in the browser builds
all expose the same public surface. The build fails if they diverge.

| Export | Description |
| --- | --- |
| `render(element, options?)` | Returns PDF bytes, page count, diagnostics, and statistics |
| `renderToBlob(element, options?)` | Returns an `application/pdf` Blob |
| `download(element, filename?, options?)` | Generates a PDF and starts a download |
| `open(element, options?)` | Generates a PDF and opens it in a new tab |
| `discoverFonts()` | Returns accessible fonts found in `@font-face` rules |
| `unhandledContent(element)` | Reports content that the current build would not emit |
| `version` | The installed Garri version |

### Options

| Option | Default | Description |
| --- | --- | --- |
| `fonts` | Discovered from `@font-face` | Explicit font specifications |
| `page` | Read from `@page` | Page width, height, and margin in millimetres |
| `columns` | `24` | Maximum pages per named-page run |
| `generatedContent` | `true` | Materialize pseudo-elements and CSS counters |
| `forms` | `"fields"` | Emit `"fields"`, `"flatten"`, or `"none"` |
| `subset` | `true` | Subset embedded fonts |
| `onDiagnostic` | None | Called when each distinct diagnostic is first raised |
| `pdfLib` | `globalThis.PDFLib` | `pdf-lib` namespace for non-standalone builds |
| `fontkit` | `globalThis.fontkit` | Fontkit instance for non-standalone builds |

Lower-level exports are available for callers that need to drive the pipeline
directly:

```js
import {
  emit,
  extractTextRuns,
  FontRegistry,
  furniture,
  materializeGenerated,
} from 'garri';
```

These are fully typed, down to individual line fragments, page rules, and
furniture. They may still change within the `0.x` series: anything that changes
is marked `@deprecated` for at least one minor release before it moves or is
removed. The rendering API above is settled for `0.x`.

## Browser script

The standalone build includes Garri, `pdf-lib`, and fontkit in one file. Copy it
into your application's public assets:

```bash
cp node_modules/garri/dist/garri.standalone.js public/vendor/garri.js
```

Load it with a script tag:

```html
<script src="/vendor/garri.js"></script>
<script>
  const invoice = document.querySelector('#invoice');
  Garri.download(invoice, 'invoice.pdf');
</script>
```

The smaller `dist/garri.js` browser bundle requires `pdf-lib` and fontkit to be
loaded first as `globalThis.PDFLib` and `globalThis.fontkit`.

## Builds

| File | Intended use |
| --- | --- |
| `dist/garri.mjs` | ES module for applications and bundlers, with PDF dependencies supplied by the caller |
| `dist/garri.cjs` | CommonJS build, so `require("garri")` returns the API object |
| `dist/garri.js` | Browser script when PDF dependencies are already global |
| `dist/garri.standalone.js` | Browser script with PDF dependencies included |

Package exports resolve `import` to the ES module and `require` to the
CommonJS build. `garri/bundle` resolves to the plain browser script.

## Validation

Garri is tested against Chromium's own `printToPDF` output. The current suite
covers twelve fixtures and twenty rendered pages. All nineteen pages in the
text comparison set have character-exact extracted text, and the form fixture
contains seven fillable fields. The suite exercises the loose-module,
browser-bundle, ES-module, and standalone loading paths.

### Against documents we did not write

The suite above is ours, and a fixture only proves a mechanism works. Garri is
also run against [tw93/Kami](https://github.com/tw93/Kami)'s ten demo
documents — written by someone else, for their own tool:

| | Worst page | Median | Mean |
| --- | ---: | ---: | ---: |
| As authored | 8.01 % | 3.38 % | 3.57 % |
| With an embeddable font | **5.15 %** | **1.07 %** | **1.49 %** |

All ten paginate to exactly Chromium's page count. The second row forces one
embeddable face on both sides, which separates *does Garri reproduce the
browser's layout* from *could Garri read the font at all* — **forcing an
embeddable face removes 58 % of the mean difference**, and that share is font
substitution rather than rendering. 21 252 of the 21 358 characters Chromium
extracts come out of Garri's PDFs too, in Chromium's own order on 17 of 27
pages as authored and 25 of 27 with fonts equalised; the missing 106 are
characters no font the document declares actually contains.

Those ten documents found twenty defects, more than the previous twenty
findings combined — including one that had been losing text silently: 5 814 characters
across the suite were being written as `U+0000` with no diagnostic, 61 of them
in a document rendered exactly as its author wrote it. That count is now zero.

See [`kami/COMPARISON.md`](kami/COMPARISON.md) for the page-by-page images and [`docs/findings-21-real-documents.md`](docs/findings-21-real-documents.md)
for what broke and why our own fixtures never caught it.

These results come from one browser and one platform. Read
[the evidence classes](docs/evidence-classes.md) before relying on a specific
number, and see [the feasibility verdict](docs/feasibility-verdict.md) for the
full validation record.

## Development

```bash
npm install
npm run build
npm test
npm run demo
```

The demo is available at `http://127.0.0.1:8080/demo/` after `npm run demo`.

## License

Garri is available under the [MIT License](LICENSE).

The standalone bundle includes `pdf-lib` and `@pdf-lib/fontkit`, both under the
MIT License. Test fonts and other third-party materials retain their original
licenses. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
