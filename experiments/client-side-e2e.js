/**
 * End-to-end, entirely in the browser.
 *
 * Verifies that extraction and PDF assembly both run in the page without a
 * server-side renderer.
 *
 * Here nothing but the fixture, the libraries and our own extractors are loaded
 * into the page; the PDF bytes are produced inside Chromium and only then
 * handed back for verification.
 *
 * Node's role is limited to driving the browser and checking the result.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MIME = {
  '.html': 'text/html', '.ttf': 'font/ttf', '.js': 'text/javascript',
};

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

async function main() {
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text()); });
  await page.setViewport({ width: 1200, height: 1600 });
  await page.goto(`${base}/fixtures/gate1-text.html`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);

  // Everything below this line executes inside the browser.
  await page.addScriptTag({ url: `${base}/node_modules/pdf-lib/dist/pdf-lib.min.js` });
  await page.addScriptTag({ url: `${base}/node_modules/@pdf-lib/fontkit/dist/fontkit.umd.min.js` });
  await page.addScriptTag({ url: `${base}/src/capture/textRuns.js` });
  await page.addScriptTag({ url: `${base}/src/capture/paintOrder.js` });
  await page.addScriptTag({ url: `${base}/src/capture/boxes.js` });

  const result = await page.evaluate(async (fontUrl) => {
    const t0 = performance.now();
    const { PDFDocument, rgb, setCharacterSpacing } = PDFLib;

    // 1. observe the browser's own layout
    const extracted = globalThis.__pdf_extractTextRuns(document.body);
    const tExtract = performance.now();

    // 2. fetch the same font bytes the page rendered with
    const fontBytes = await (await fetch(fontUrl)).arrayBuffer();

    // 3. build the PDF, in the browser
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(fontBytes, { subset: true });
    const A4 = { w: 595.276, h: 841.89 };
    const PT = 72 / 96;
    const MARGIN = 76;
    const pg = doc.addPage([A4.w, A4.h]);

    for (const run of extracted.runs) {
      const yPt = A4.h - (MARGIN + run.baselineCandidates.topPlusFontAscent) * PT;
      const ls = parseFloat(run.font.letterSpacing);
      const tc = Number.isFinite(ls) ? ls * PT : 0;
      if (tc) pg.pushOperators(setCharacterSpacing(tc));
      for (const w of run.words) {
        pg.drawText(w.text, {
          x: (MARGIN + w.left) * PT, y: yPt,
          size: run.font.size * PT, font, color: rgb(0, 0, 0),
        });
      }
      if (tc) pg.pushOperators(setCharacterSpacing(0));
    }

    const bytes = await doc.save();
    const tDone = performance.now();

    // 4. prove it can be handed to the user without a server
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    URL.revokeObjectURL(url);

    return {
      bytes: Array.from(bytes),
      runs: extracted.runs.length,
      blobSize: blob.size,
      blobUrlWorked: url.startsWith('blob:'),
      timing: {
        extractMs: tExtract - t0,
        totalMs: tDone - t0,
      },
    };
  }, `${base}/fixtures/font.ttf`);

  await browser.close();
  server.close();

  const bytes = Uint8Array.from(result.bytes);
  const out = path.join(ROOT, 'out', 'client-side.pdf');
  fs.writeFileSync(out, bytes);

  console.log('=== BUILT ENTIRELY IN THE BROWSER ===');
  console.log(`text runs          : ${result.runs}`);
  console.log(`PDF size           : ${(bytes.byteLength / 1024).toFixed(1)} KB`);
  console.log(`Blob created       : ${result.blobSize} bytes, object URL ${result.blobUrlWorked ? 'ok' : 'FAILED'}`);
  console.log(`extraction         : ${result.timing.extractMs.toFixed(1)} ms`);
  console.log(`total in-page      : ${result.timing.totalMs.toFixed(1)} ms`);

  // verify the bytes really are a usable PDF with recoverable text
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
  const tc = await (await doc.getPage(1)).getTextContent();
  const text = tc.items.map((i) => i.str).join('').replace(/\s+/g, '');
  console.log(`\n=== VERIFICATION (in Node, on the browser's bytes) ===`);
  console.log(`pages              : ${doc.numPages}`);
  console.log(`text extractable   : ${text.length} chars`);
  console.log(`starts with        : ${JSON.stringify(text.slice(0, 48))}`);

  const libs = [
    ['pdf-lib.min.js', 'node_modules/pdf-lib/dist/pdf-lib.min.js'],
    ['fontkit.umd.min.js', 'node_modules/@pdf-lib/fontkit/dist/fontkit.umd.min.js'],
  ];
  console.log('\n=== CLIENT BUNDLE (unzipped) ===');
  let total = 0;
  for (const [name, p] of libs) {
    const kb = fs.statSync(path.join(ROOT, p)).size / 1024;
    total += kb;
    console.log(`  ${name.padEnd(22)} ${kb.toFixed(0).padStart(5)} KB`);
  }
  const ours = ['src/capture/textRuns.js', 'src/capture/paintOrder.js', 'src/capture/boxes.js']
    .reduce((a, p) => a + fs.statSync(path.join(ROOT, p)).size, 0) / 1024;
  console.log(`  our extractors         ${ours.toFixed(0).padStart(5)} KB`);
  console.log(`  ${'TOTAL'.padEnd(22)} ${(total + ours).toFixed(0).padStart(5)} KB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
