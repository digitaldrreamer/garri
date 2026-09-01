# Garri

Garri is a browser-native document compiler. It turns rendered HTML, CSS, and
DOM semantics into native PDF objects: text, embedded fonts, vectors, images,
links, annotations, and interactive fields.

It uses the browser as the layout authority, but not the browser's printing API.
Garri measures what the browser laid out and reconstructs it as a programmable
PDF entirely inside the page—without a print dialog, headless Chromium, or a
PDF-generation server.

> Use Garri when your application must own the generated PDF, not merely ask
> the user to print the page.

## Status

Garri is currently **`0.1.0-alpha.3`**. See
[COMPATIBILITY.md](COMPATIBILITY.md) for the tested environments.

Garri's rendering API requires a browser page and a live DOM. It does not turn
HTML into PDF inside Node.js, and it does not launch a browser for you. Use it
where you can validate the generated documents and inspect the returned
diagnostics.

## Why Garri?

| Approach | Trade-off |
| --- | --- |
| `window.print()` | Gives control to the user and never returns the file to the application |
| Chromium `printToPDF` | Returns the file, but requires privileged browser automation |
| Screenshot-based libraries | Run client-side, but produce image-like PDFs rather than useful documents |
| Traditional PDF libraries | Produce native PDFs, but require developers to recreate their HTML layout manually |
| **Garri** | Returns PDF bytes to the application while reusing the HTML the browser already rendered |

## Documentation

- [Supported features](FEATURES.md)
- [Compatibility](COMPATIBILITY.md)
- [Garri vs Chromium on Kami demos](COMPARISON.md)
- [Contributing](CONTRIBUTING.md)

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

## When Garri fits

Garri is most useful when the PDF is an application artifact rather than merely
a printout, including:

- Dashboard reports containing charts and analysis
- Invoices, receipts, statements, and certificates
- Survey or application forms that should remain fillable
- Documents that will be uploaded, emailed, archived, or sent for signing
- Privacy-sensitive documents that should remain on the user's device
- Offline-capable or resource-constrained applications
- Products that cannot justify operating a Chromium service

Use Garri when you control or can test the document template, need `Uint8Array`
or `Blob` output in client-side JavaScript, cannot show a print dialog, and care
about native PDF behavior or avoiding server infrastructure.

Choose another tool when:

- The user is happy to select **Save as PDF** manually; use `window.print()`.
- Pixel-exact rendering of arbitrary websites matters more than client-side
  generation; use Chromium `printToPDF`.
- Generation must run unattended, on a schedule, or on a server; use a backend
  renderer.
- You need professional publishing features such as footnotes,
  cross-references, bleed, or crop marks; use a dedicated paged-media engine.
- Arabic or Indic shaping is critical; Garri's cluster shaping is not reliable
  yet.

## What Garri renders

Garri currently supports:

- Selectable text, embedded subset fonts, and letter spacing
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
- Advanced SVG text positioning, patterns, masks, and filters
- Vertical writing modes
- Tagged PDF structure, accessibility metadata, bookmarks, or outlines
- File, range, color, and multi-select form controls

Arabic and Devanagari fonts can be embedded, but cluster shaping is not yet
reliable; joined letters, conjuncts, and vowel marks may overlap.

Cross-origin resources must allow the page to read their bytes. Garri may be
unable to embed an image, font, stylesheet font rule, or tainted canvas that the
browser can display but JavaScript cannot access.

System fonts do not expose embeddable font bytes. Garri substitutes a standard
PDF font and reports `PDF_FONT_SUBSTITUTED`. Latin-script text positions remain
based on the browser's measurements, but glyph shapes still differ. Declare an
`@font-face` when exact glyphs matter.

## Diagnostics

Garri returns diagnostics for unsupported or degraded output it can detect.
Each call to `render`, `download`, or `open` resolves with a result containing:

```js
{
  bytes,        // Uint8Array
  pdfDocument,  // live pdf-lib PDFDocument used to produce bytes
  pages,        // number
  diagnostics,  // [{ code, message, count, detail? }]
  stats,
}
```

### Inspect or extend the PDF

`render`, `download`, and `open` return the live pdf-lib `PDFDocument`. Use it
to inspect pages, resources, forms, and the object structure Garri constructed:

```js
const result = await render(invoice, { pdfLib: PDFLib, fontkit });

console.log(result.pdfDocument.getPages());
console.log(result.pdfDocument.context.enumerateIndirectObjects());
```

`getPages()` is part of pdf-lib's public API. Direct `context` access is the
lower-level pdf-lib object model and follows pdf-lib's own compatibility rules.

Use `onPdfDocument` when a change must be included in the returned bytes. The
hook runs after Garri constructs the document and before pdf-lib serializes it:

```js
const result = await render(invoice, {
  pdfLib: PDFLib,
  fontkit,
  onPdfDocument(pdfDocument) {
    pdfDocument.setTitle('Quarterly report');
    pdfDocument.setAuthor('Acme');
  },
});
```

Changing `result.pdfDocument` after `render()` resolves does not change the
already-created `result.bytes`; call `await result.pdfDocument.save()` to
serialize later changes.

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

You can also preflight the computed-style omissions Garri can detect without
generating a PDF:

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
| `unhandledContent(element)` | Preflights detectable computed-style omissions |
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
| `onPdfDocument` | None | Receives the completed pdf-lib document before it is saved |
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

Garri is tested against Chromium's own `printToPDF` output. Eleven text
fixtures produce nineteen character-exact pages; a twelfth, one-page form
fixture produces seven fillable fields. The same assertions run through the
loose modules, browser bundle, ES module, and standalone build.

### Results of testing ten HTML documents from the Kami demo

Comparison of Chromium vs Garri when tested on native PDF generation of ten
[Kami demo documents](https://github.com/tw93/Kami/tree/main/assets/demos).
All ten paginate to Chromium's page count. See
[COMPARISON.md](COMPARISON.md) for the methodology and results.

## Development

```bash
npm install
npm run build
npm test
npm run demo
```

The demo is available at `http://127.0.0.1:8080/demo/` after `npm run demo`.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and test
expectations.

## License

Garri is available under the [MIT License](LICENSE).

The standalone bundle includes `pdf-lib` and `@pdf-lib/fontkit`, both under the
MIT License. Test fonts and other third-party materials retain their original
licenses. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Looking to reformat an existing PDF?

Garri turns HTML into native PDFs. If you already have a PDF and want to turn
it into a cleaner, themed, accessible web reading experience, take a look at
Abass's [MDF](https://github.com/azeezabass2005/mdf). It supports readable
fonts and themes, along with scrolling and page-by-page reading modes.
