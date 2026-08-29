# Findings 18 — The entry point, and the viewport precondition

**Status:** assembled pipeline PASS — 14/14 pages character-exact across 6 fixtures
**Date:** 2026-08-29
**Chromium:** Google Chrome for Testing 152.0.7977.54 (arm64, headless)

Run: `npm test` (`node experiments/entry-point.js`)

---

## 1. What changed

Until now there was no library — only mechanisms. Eleven extractors, each
validated in isolation against `printToPDF`, and every experiment wiring the
pipeline by hand. `src/index.js` is the seam:

```js
const { bytes, pages, diagnostics } = await __pdf_render(document.body, {
  pdfLib: PDFLib, fontkit,
  fonts: [{ family: 'Sans', src: '/fonts/sans.ttf' }],
});
```

Two deliberate constraints. `pdf-lib` and `fontkit` are **injected**, not
imported, because these sources load as classic scripts and that is what the
whole regression suite consumes. And it renders only what there are **emitters**
for — `src/` has extractors for boxes, paint, images, links and SVG, but the
code that writes those into a PDF still lives in the experiments. Unhandled
content is reported, never silently dropped.

## 2. Result

| Fixture | Pages | Text |
| --- | --- | --- |
| `gate1-text` | 1/1 | exact |
| plain flow, 40 paragraphs | 3/3 | exact |
| repeating `<thead>` | 2/2 | exact |
| `position: fixed` | 2/2 | exact |
| `position: fixed`, centred | 2/2 | exact |
| named pages + margin boxes | 4/4 | exact |

Draw order matters and is now Chromium's own: **margin boxes → repeated table
sections → flow → fixed elements**. Getting this wrong does not lose content;
it reorders what a reader copies out of the PDF. All three of the first
furniture cases had complete text but wrong sequence before this was fixed.

## 3. The finding worth keeping: render at page width

`position: fixed` resolves against the **viewport**. In print it resolves
against the **page box**. If those differ, a fixed element is misplaced, and the
error is not recoverable after the fact:

| Layout viewport | Chromium | Ours | Error |
| --- | --- | --- | --- |
| 1400 px | 265.06 pt | 492.31 pt | **227.25 pt** |
| 794 px (A4 at 96 dpi) | 265.06 pt | 265.06 pt | **0.00 pt** |

At page width the error is zero and no correction is needed at all.

Two things this ruled out along the way:

- **`getComputedStyle` cannot tell you the authored side.** Chromium returns
  *used* values, so an element written `right: 0` reports `left: 1312.97px`.
  Resolving insets from the computed style is impossible in principle.
- **Re-anchoring cannot rescue a proportional offset.** Carrying an absolute
  edge gap onto a narrower page works for `right: 0`; it cannot work for
  `left: 50%`, whichever edge is chosen. `data-pdf-anchor` picks the *edge*, not
  the *offset*, so it does not help here — a fact worth stating plainly, because
  the escape hatch was built before it was measured and does less than intended.

So the pipeline now emits `PDF_VIEWPORT_MISMATCH` naming both widths whenever a
fixed element is laid out against a viewport that is not the page box. The
precondition is the fix; the heuristic is only a fallback.

## 4. Five bugs, and an honest split

Three were **not discoveries** — they were re-deriving what the experiments had
already settled, without reading them first:

1. `identify()` returns `{ fixed, tables }`. The entry point tested
   `furniture.length`, got `undefined`, and so **`reserve` silently never ran**.
2. `reserve` was given a callback that re-fragmented on every pass.
   `experiments/furniture.js:90-99` already had the correct shape — geometry
   applied once, live closures over the container.
3. `F.emit` was never called at all.

Two were genuine, and the existing suite **could not** have caught them. In
`experiments/furniture.js` the `emitted` column is a *count*: it verified that
furniture was produced for the right pages, never that it was drawn at the right
coordinates, because there was no emitter to draw with.

4. Fixed-element page anchoring (§3) — nothing had ever converted a fixed
   element's position into page space.
5. Content-stream ordering — every experiment compared page *membership*, none
   compared per-page text *sequence*.

The lesson is the one this programme keeps relearning, pointed at code rather
than at measurement: **integration is where the untested seams are, and reading
the working implementation costs less than rediscovering it.**

## 5. Packaging state

`package.json` now describes a library rather than a scratch directory:

- `0.1.0-alpha.1`, still `private: true` — publishing is a separate decision.
- `pdf-lib` and `@pdf-lib/fontkit` moved to **peerDependencies**: they are
  injected by the caller, never imported here.
- `puppeteer`, `pdfjs-dist`, `regenerator-runtime` are **devDependencies** —
  they are the test oracle, not the product. Shipping puppeteer would have put a
  browser download in every consumer's install.
- `harfbuzzjs` removed; it was never referenced.
- `sideEffects: true`, because every module installs a global. A bundler told
  otherwise would tree-shake the entire pipeline away.

## 6. Bundles

`node build.js` — no bundler dependency. The sources are already self-contained
classic scripts that install `globalThis.__pdf_*`, so a bundle is an ordered
concatenation; rollup or esbuild would buy tree-shaking that pure-side-effect
modules cannot use.

| Output | Raw | Gzipped | For |
| --- | --- | --- | --- |
| `dist/peedeeeff.js` | 67.2 KB | **21.7 KB** | `<script>` tag; installs the globals |
| `dist/peedeeeff.mjs` | 67.6 KB | **21.8 KB** | `import { render } from 'peedeeeff'` |

Both are **proved, not merely built**: `npm run test:bundle` runs the same six
fixtures through each and gets the same 14/14 character-exact pages as the loose
sources.

```
--load=modules   14/14 exact
--load=iife      14/14 exact
--load=esm       14/14 exact
```

The ESM test calls the *named export* rather than the global the bundle also
installs, so it would fail if the export were missing.

The sources are deliberately **not** converted to ES modules. Every experiment
here — the whole regression suite — loads them as classic scripts via
`addScriptTag`. Converting would break all of it to gain what a build step
already provides. The `.mjs` reads the globals back out after evaluation: a
little impure, and honest about what these modules are.

**A deployment requirement found while testing:** `.mjs` must be served with a
JavaScript MIME type. Served as `application/octet-stream` the browser refuses
to execute it and reports only `Failed to fetch dynamically imported module`,
which names the wrong cause.

Importing the package outside a browser does not throw — build tools (Vite,
Next, webpack) import it during SSR and analysis passes, and a module that
touched `document` at module scope would break the consumer's build before
reaching a browser. All five exports resolve; they need a real DOM to do
anything, which is correct for a browser target.

Still missing before this is honestly alpha-usable by anyone else: a README
stating the supported scope, and emitters for the extractors that have none.
