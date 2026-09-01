/**
 * Generated content — ::before, ::after, counters and list markers.
 *
 * Verifies that pseudo-elements, which are invisible to ordinary DOM text
 * traversal, are materialised for the text pipeline.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.ttf': 'font/ttf', '.js': 'text/javascript' };

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

const dense = (s) => s.replace(/\s+/g, '');

async function main() {
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page]', m.text()); });
  await page.setViewport({ width: 1200, height: 1600 });
  await page.goto(`${base}/fixtures/generated-content.html`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);

  // Ground truth BEFORE any DOM mutation.
  const chromiumPdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  fs.writeFileSync(path.join(ROOT, 'out', 'gencontent-chromium.pdf'), chromiumPdf);

  await page.addScriptTag({ url: `${base}/node_modules/regenerator-runtime/runtime.js` });
  await page.addScriptTag({ url: `${base}/node_modules/pdf-lib/dist/pdf-lib.min.js` });
  await page.addScriptTag({ url: `${base}/node_modules/@pdf-lib/fontkit/dist/fontkit.umd.min.js` });
  await page.addScriptTag({ url: `${base}/src/capture/generated.js` });
  await page.addScriptTag({ url: `${base}/src/capture/textRuns.js` });

  const result = await page.evaluate(async (b, pageBox) => {
    const { PDFDocument, rgb, PDFOperator } = PDFLib;
    const PT = 72 / 96, MARGIN = Math.round((10 / 25.4) * 96);

    // Materialise first: markers are read before the DOM changes, and the text
    // extractor then sees ::before/::after as ordinary inline content.
    const gen = globalThis.__pdf_materializeGenerated(document.body);
    const extracted = globalThis.__pdf_extractTextRuns(document.body);

    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const fontBytes = await (await fetch(`${b}/fixtures/font.ttf`)).arrayBuffer();
    const font = await doc.embedFont(fontBytes, { subset: true });
    const pg = doc.addPage([pageBox.w, pageBox.h]);
    const n = (v) => (Math.abs(v) < 1e-6 ? '0' : String(+v.toFixed(4)));
    const raw = (s) => pg.pushOperators(PDFOperator.of(s, []));
    const parseCol = (s) => {
      const m = String(s).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      return m ? rgb(+m[1] / 255, +m[2] / 255, +m[3] / 255) : rgb(0, 0, 0);
    };

    // --- text, including the materialised pseudo-elements
    for (const run of extracted.runs) {
      const yPt = pageBox.h - (MARGIN + run.baselineCandidates.topPlusFontAscent) * PT;
      for (const w of run.words) {
        pg.drawText(w.text, {
          x: (MARGIN + w.left) * PT, y: yPt,
          size: run.font.size * PT, font, color: parseCol(run.color),
        });
      }
    }

    // --- list markers, placed by the derived rule
    const ctx = document.createElement('canvas').getContext('2d');
    for (const mk of gen.markers) {
      const li = mk.li;
      const r = li.getBoundingClientRect();
      const cs = getComputedStyle(li);
      const asc = (() => {
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        return ctx.measureText('H').fontBoundingBoxAscent;
      })();
      const baseline = r.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0) + asc;
      const yPt = pageBox.h - (MARGIN + baseline) * PT;

      if (mk.kind === 'text') {
        const sizePt = mk.fontSize * PT;
        const wPt = font.widthOfTextAtSize(mk.text, sizePt);
        // right-aligned: the rule derived from Chromium's own output
        pg.drawText(mk.text, {
          x: (MARGIN + mk.right) * PT - wPt, y: yPt, size: sizePt, font, color: parseCol(mk.color),
        });
      } else {
        const rad = (mk.size / 2) * PT;
        const cx = (MARGIN + mk.right) * PT - rad;
        const cy = yPt + rad;
        const K = 0.5523 * rad;
        const c = parseCol(mk.color);
        raw(`${n(c.red)} ${n(c.green)} ${n(c.blue)} rg`);
        raw(`${n(cx - rad)} ${n(cy)} m`);
        raw(`${n(cx - rad)} ${n(cy + K)} ${n(cx - K)} ${n(cy + rad)} ${n(cx)} ${n(cy + rad)} c`);
        raw(`${n(cx + K)} ${n(cy + rad)} ${n(cx + rad)} ${n(cy + K)} ${n(cx + rad)} ${n(cy)} c`);
        raw(`${n(cx + rad)} ${n(cy - K)} ${n(cx + K)} ${n(cy - rad)} ${n(cx)} ${n(cy - rad)} c`);
        raw(`${n(cx - K)} ${n(cy - rad)} ${n(cx - rad)} ${n(cy - K)} ${n(cx - rad)} ${n(cy)} c`);
        raw(mk.shape === 'disc' ? 'h f' : 'h S');
      }
    }

    const bytes = await doc.save();
    return {
      bytes: Array.from(bytes),
      materialised: gen.count,
      markers: gen.markers.map((m) => ({ kind: m.kind, text: m.text || m.shape, right: m.right })),
      diagnostics: gen.diagnostics,
      runs: extracted.runs.length,
      pseudoTexts: [...document.querySelectorAll('[data-pdf-pseudo]')].map((e) => e.textContent),
    };
  }, base, { w: 594.96, h: 841.92 });

  await browser.close();
  server.close();

  const bytes = Uint8Array.from(result.bytes);
  fs.writeFileSync(path.join(ROOT, 'out', 'gencontent-ours.pdf'), bytes);

  console.log('=== MATERIALISED PSEUDO-ELEMENTS ===');
  console.log(`  ${result.materialised} injected, text runs now ${result.runs}`);
  for (const t of result.pseudoTexts) console.log(`    ${JSON.stringify(t)}`);

  console.log('\n=== LIST MARKERS ===');
  for (const m of result.markers) {
    console.log(`  ${m.kind.padEnd(6)} ${JSON.stringify(m.text).padEnd(10)} right edge at ${m.right.toFixed(2)}px`);
  }

  console.log('\n=== DIAGNOSTICS ===');
  if (!result.diagnostics.length) console.log('  (none)');
  for (const d of result.diagnostics) console.log(`  ${d.code} ${d.selector ?? ''}\n    ${d.message ?? d.detail}`);

  // ---- does every string Chromium shows also appear in ours? --------------
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const textOf = async (data) => {
    const doc = await pdfjs.getDocument({ data: data.slice(), useSystemFonts: false }).promise;
    const tc = await (await doc.getPage(1)).getTextContent();
    return dense(tc.items.map((i) => i.str).join(''));
  };
  const ours = await textOf(bytes);
  const theirs = await textOf(chromiumPdf);

  console.log('\n=== TEXT COVERAGE vs CHROMIUM ===');
  const probes = ['→', '✓', '[', ']', '(fromanattribute)',
    'Step1:', 'Step2:', 'Step3:', 'NOTE', '1.', '2.', 'I.', 'II.'];
  let hit = 0;
  for (const p of probes) {
    const a = ours.includes(dense(p)), t = theirs.includes(dense(p));
    if (a) hit++;
    console.log(`  ${JSON.stringify(p).padEnd(22)} ours=${a ? 'yes' : 'NO '}  chromium=${t ? 'yes' : 'NO '}`);
  }
  console.log(`\n  ${hit}/${probes.length} generated strings present in our PDF`);
  console.log(`  our chars: ${ours.length}   chromium: ${theirs.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
