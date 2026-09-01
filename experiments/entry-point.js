/**
 * The entry point, checked the same way everything else here was: against
 * Chromium's own printToPDF, captured BEFORE any DOM mutation.
 *
 * Tests src/index.js as a whole rather than an individual extractor, asking
 * the two primary questions of an
 * assembled pipeline: does it produce the right number of pages, and does the
 * right text land on each one.
 *
 *   node experiments/entry-point.js
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// .mjs MUST be served with a JavaScript MIME type or the browser refuses to
// execute it as a module — a real deployment requirement, not just a test detail.
const MIME = {
  '.html': 'text/html', '.ttf': 'font/ttf',
  '.js': 'text/javascript', '.mjs': 'text/javascript',
};
const dense = (s) => s.replace(/\s+/g, '');

function serve(dir) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const f = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
  });
}

// How to load the pipeline: as loose source modules (the development path), or
// via one of the built bundles. The SAME cases run either way, so the bundles
// are proved against Chromium rather than merely built.
const LOAD = (process.argv.find((a) => a.startsWith('--load=')) || '--load=modules').split('=')[1];

const MODULES = [
  'src/capture/paintOrder.js',
  'src/capture/textRuns.js',
  'src/capture/generated.js',
  'src/capture/paint.js',
  'src/capture/images.js',
  'src/capture/canvas.js',
  'src/capture/forms.js',
  'src/capture/links.js',
  'src/capture/svg.js',
  'src/pdf/svgPath.js',
  'src/pdf/emit.js',
  'src/text/sfnt.js',
  'src/text/fontRegistry.js',
  'src/pagination/furniture.js',
  'src/index.js',
];

async function runCase(browser, base, pdfjs, { name, url, inject, assert: mode, expectFields }) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1400, height: 1400 });
  await page.goto(`${base}${url}`, { waitUntil: 'networkidle0' });
  if (inject) await page.evaluate(inject);
  await page.evaluate(() => document.fonts.ready);

  // --- ground truth FIRST, before the pipeline touches anything
  const truthBytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  const truthDoc = await pdfjs.getDocument({ data: new Uint8Array(truthBytes) }).promise;
  const truth = [];
  for (let i = 1; i <= truthDoc.numPages; i++) {
    const tc = await (await truthDoc.getPage(i)).getTextContent();
    truth.push(dense(tc.items.map((t) => t.str).join('')));
  }

  // --- our pipeline, entirely in the browser
  if (LOAD !== 'standalone') {
    await page.addScriptTag({ url: `${base}/node_modules/pdf-lib/dist/pdf-lib.min.js` });
    await page.addScriptTag({ url: `${base}/node_modules/@pdf-lib/fontkit/dist/fontkit.umd.min.js` });
  }
  if (LOAD === 'standalone') {
    // ONE script tag. No pdf-lib, no fontkit, no font registration.
    await page.addScriptTag({ url: `${base}/dist/garri.standalone.js` });
  } else if (LOAD === 'iife') {
    await page.addScriptTag({ url: `${base}/dist/garri.js` });
  } else if (LOAD === 'esm') {
    // import the ES module and call its NAMED export, not the global it also
    // installs — otherwise this would pass even if the export were missing.
    await page.evaluate(async (u) => {
      const m = await import(u);
      if (typeof m.render !== 'function') throw new Error('ESM bundle has no `render` export');
      globalThis.__pdf_render_esm = m.render;
    }, `${base}/dist/garri.mjs`);
  } else {
    for (const m of MODULES) await page.addScriptTag({ url: `${base}/${m}` });
  }

  const result = await page.evaluate(async (fontUrl, mode) => {
    try {
      if (mode === 'standalone') {
        // Zero configuration: fonts come from the page's own @font-face rules.
        let hookPages = null;
        const r0 = await globalThis.PeeDeeEff.render(document.body, {
          onPdfDocument(pdfDocument) {
            hookPages = pdfDocument.getPageCount();
            pdfDocument.setSubject('Garri pre-save hook');
          },
        });
        return { ok: true, bytes: Array.from(r0.bytes), pages: r0.pages,
          diagnostics: r0.diagnostics, stats: r0.stats,
          pdfDocumentPages: r0.pdfDocument.getPageCount(), hookPages,
          fontsFound: globalThis.PeeDeeEff.discoverFonts().length };
      }
      const entry = mode === 'esm' ? globalThis.__pdf_render_esm : globalThis.__pdf_render;
      let hookPages = null;
      const r = await entry(document.body, {
        pdfLib: PDFLib,
        fontkit,
        fonts: [
          { family: 'Sans', src: fontUrl },
          { family: 'Probe', src: fontUrl },
          { family: 'TestFont', src: fontUrl },
          // the named-pages fixture declares a generic family
          { family: 'sans-serif', src: fontUrl },
        ],
        onPdfDocument(pdfDocument) {
          hookPages = pdfDocument.getPageCount();
          pdfDocument.setSubject('Garri pre-save hook');
        },
      });
      return {
        ok: true,
        bytes: Array.from(r.bytes),
        pages: r.pages,
        diagnostics: r.diagnostics,
        stats: r.stats,
        pdfDocumentPages: r.pdfDocument.getPageCount(),
        hookPages,
      };
    } catch (e) {
      return { ok: false, error: e.message, stack: String(e.stack).split('\n').slice(0, 4).join('\n') };
    }
  }, `${base}/fixtures/font.ttf`, LOAD);

  await page.close();

  if (!result.ok) return { name, failed: result.error, stack: result.stack, errors };

  const bytes = Uint8Array.from(result.bytes);
  fs.writeFileSync(path.join(ROOT, 'out', `entry-${name}.pdf`), bytes);
  // Chromium's own output, for the pixel comparison.
  fs.writeFileSync(path.join(ROOT, 'out', `entry-${name}-chromium.pdf`), truthBytes);
  const ourDoc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const ourMetadata = await ourDoc.getMetadata();
  const ours = [];
  for (let i = 1; i <= ourDoc.numPages; i++) {
    const tc = await (await ourDoc.getPage(i)).getTextContent();
    ours.push(dense(tc.items.map((t) => t.str).join('')));
  }

  let annots = 0;
  for (let i = 1; i <= ourDoc.numPages; i++) {
    annots += (await (await ourDoc.getPage(i)).getAnnotations()).length;
  }
  let truthAnnots = 0;
  for (let i = 1; i <= truthDoc.numPages; i++) {
    truthAnnots += (await (await truthDoc.getPage(i)).getAnnotations()).length;
  }
  return { name, truth, ours, diagnostics: result.diagnostics, stats: result.stats,
    bytes: bytes.byteLength, errors, annots, truthAnnots, mode, expectFields,
    pdfDocumentPages: result.pdfDocumentPages, hookPages: result.hookPages,
    hookSaved: ourMetadata.info?.Subject === 'Garri pre-save hook' };
}

const CASES = [
  // SVG <use> / <symbol>, resolved by inlining and letting the browser measure.
  { name: 'svg-use', url: '/fixtures/probes/svg-use.html' },
  // Form controls as real AcroForm fields.
  // In the default 'fields' mode the values live in fillable AcroForm fields,
  // NOT in the text layer, so a text comparison is the wrong assertion here.
  { name: 'forms', url: '/fixtures/probes/forms.html', assert: 'fields', expectFields: 7 },
  // box-shadow raster fallback, mix-blend-mode, and <canvas>.
  { name: 'shadow-blend-canvas', url: '/fixtures/probes/canvas-blend-shadow.html' },
  // Non-text emitters: backgrounds, gradients, borders, clipping.
  { name: 'paint', url: '/fixtures/paint-gaps.html' },
  // Images (PNG/JPEG passthrough, object-fit) and link annotations.
  { name: 'images-links', url: '/fixtures/images-links.html' },
  // SVG geometry, paint servers, clipping.
  { name: 'svg', url: '/fixtures/svg-basic.html' },
  // Furniture: a repeating <thead> must appear on every continuation page, and
  // its height must be RESERVED or rows land on the wrong page entirely.
  { name: 'repeating-thead', url: '/fixtures/probes/table-header-group.html' },
  // position: fixed repeats per page and corrupts column indexing if not detached.
  { name: 'position-fixed', url: '/fixtures/probes/position-fixed.html' },
  // A centred fixed element: the heuristic cannot resolve it, so the anchor
  // is declared with data-pdf-anchor rather than guessed.
  { name: 'fixed-centred', url: '/fixtures/probes/position-fixed-centred.html' },
  // Margin boxes: running headers/footers and counter(page).
  { name: 'named-pages', url: '/fixtures/probes/named-pages-furniture.html' },
  { name: 'single-page', url: '/fixtures/gate1-text.html' },
  {
    name: 'multi-page',
    url: '/fixtures/scale-shell.html',
    inject: () => {
      const d = document.getElementById('doc');
      for (let i = 0; i < 40; i++) {
        const p = document.createElement('p');
        p.textContent = `Paragraph ${i + 1}. The quick brown fox jumps over the lazy dog, `
          + `and continues far enough that this paragraph wraps onto a second line.`;
        d.appendChild(p);
      }
    },
  },
];

async function main() {
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({ headless: true });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  console.log(`loading pipeline as: ${LOAD}`);
  let failed = false;

  for (const c of CASES) {
    const r = await runCase(browser, base, pdfjs, c);
    console.log(`\n===== ${r.name} =====`);
    if (r.failed) {
      failed = true;
      console.log(`  THREW: ${r.failed}`);
      console.log(`  ${r.stack}`);
      if (r.errors.length) console.log('  page errors:', r.errors.slice(0, 3));
      continue;
    }
    console.log(`  pages   chromium ${r.truth.length}   ours ${r.ours.length}`
      + `   ${r.truth.length === r.ours.length ? 'MATCH' : 'DIFFER'}`);
    if (r.truth.length !== r.ours.length) failed = true;
    const documentOk = r.pdfDocumentPages === r.ours.length
      && r.hookPages === r.ours.length && r.hookSaved;
    console.log(`  pdf-lib document: ${r.pdfDocumentPages} pages; pre-save hook: ${r.hookPages} `
      + `${r.hookSaved ? 'saved' : 'not saved'} ${documentOk ? 'OK' : 'MISMATCH'}`);
    if (!documentOk) failed = true;
    if (r.mode === 'fields') {
      const got = r.stats.emitted ? r.stats.emitted.formFields : 0;
      console.log(`  AcroForm fields: ${got}/${r.expectFields} `
        + `${got === r.expectFields ? 'OK' : 'MISMATCH'}`
        + '   (values are in fillable fields, not the text layer — by design)');
      if (got !== r.expectFields) failed = true;
      if (r.diagnostics.length) {
        console.log('  diagnostics:');
        for (const d of r.diagnostics) console.log(`    ${d.code}: ${d.message}`);
      }
      continue;
    }
    let exact = 0;
    for (let i = 0; i < Math.max(r.truth.length, r.ours.length); i++) {
      const t = r.truth[i] ?? '', o = r.ours[i] ?? '';
      const same = t === o;
      if (!same) failed = true;
      if (same) exact++;
      const label = same ? 'exact' : `chromium ${t.length} chars / ours ${o.length}`;
      console.log(`    page ${String(i + 1).padStart(2)}: ${label}`);
      if (!same && t && o) {
        let k = 0; while (k < Math.min(t.length, o.length) && t[k] === o[k]) k++;
        console.log(`               first difference at ${k}: `
          + `${JSON.stringify(t.slice(k, k + 28))} vs ${JSON.stringify(o.slice(k, k + 28))}`);
      }
    }
    console.log(`  page text exact: ${exact}/${r.truth.length}`);
    console.log(`  size ${(r.bytes / 1024).toFixed(1)} KB   ${r.stats.runs} runs   ${r.stats.totalMs.toFixed(0)} ms`);
    if (r.stats.emitted) {
      const e = r.stats.emitted;
      console.log(`  emitted: bg ${e.backgrounds} grad ${e.gradients} bgimg ${e.bgImages} `
        + `borders ${e.borders} images ${e.images} svg ${e.svg} links ${e.links} `
        + `shadows ${e.shadows || 0} blends ${e.blends || 0} canvas ${e.canvases || 0}`);
    }
    console.log(`  annotations: ours ${r.annots}, chromium ${r.truthAnnots}`
      + (r.stats.emitted && r.stats.emitted.formFields ? `  (form fields ${r.stats.emitted.formFields})` : ''));
    if (r.diagnostics.length) {
      console.log('  diagnostics:');
      for (const d of r.diagnostics) console.log(`    ${d.code}: ${d.message}`);
    }
    if (r.errors.length) console.log('  page errors:', r.errors.slice(0, 3));
  }

  await browser.close();
  server.close();
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
