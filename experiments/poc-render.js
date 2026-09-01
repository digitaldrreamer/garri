/**
 * The proof-of-concept from the plan's §36.
 *
 * Renders a PDF from nothing but Web-API observations of the browser's layout,
 * then scores it against the PDF the same Chromium produced for the same page.
 *
 * The extractor never sees Chromium's PDF; it is the yardstick, not an input.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PDFDocument, rgb, setCharacterSpacing } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PT_PER_PX = 72 / 96;
const MIME = { '.html': 'text/html', '.ttf': 'font/ttf', '.js': 'text/javascript' };

function serve(dir) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
      if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
  });
}

async function textItems(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdf.js takes ownership of the buffer it is given and detaches it, which
  // would zero the caller's view. Hand it a copy.
  const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  return {
    heightPt: vp.height,
    items: tc.items.filter((i) => i.str && i.str.trim()).map((i) => ({
      str: i.str,
      xPt: i.transform[4],
      baselineTopDownPx: (vp.height - i.transform[5]) / PT_PER_PX,
      leftPx: i.transform[4] / PT_PER_PX,
      widthPt: i.width,
    })),
  };
}

const dense = (s) => s.replace(/\s+/g, '');

async function main() {
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  const fixture = process.argv[2] || 'gate1-text';
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1600 });
  await page.goto(`${base}/fixtures/${fixture}.html`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await page.addScriptTag({ url: `${base}/src/capture/textRuns.js` });

  const extracted = await page.evaluate(() => globalThis.__pdf_extractTextRuns(document.body));
  const chromiumPdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  await browser.close();
  server.close();

  // ---- build our PDF from the extraction alone --------------------------
  const MARGIN_PX = 76; // @page margin: 20mm, as Chromium rounds it
  const A4 = { w: 595.276, h: 841.89 };

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fontBytes = fs.readFileSync(path.join(ROOT, 'fixtures', 'font.ttf'));
  const font = await doc.embedFont(fontBytes, { subset: true });
  const pg = doc.addPage([A4.w, A4.h]);

  const t0 = performance.now();
  for (const run of extracted.runs) {
    const baselinePx = MARGIN_PX + run.baselineCandidates.topPlusFontAscent;
    const yPt = A4.h - baselinePx * PT_PER_PX;
    const sizePt = run.font.size * PT_PER_PX;

    // CSS letter-spacing maps directly onto the PDF Tc operator. Word-spacing
    // does not: PDF's Tw only applies to single-byte code 32, which an
    // embedded CID font never emits. Positioning each word at its measured x
    // sidesteps that entirely.
    const ls = parseFloat(run.font.letterSpacing);
    const tc = Number.isFinite(ls) ? ls * PT_PER_PX : 0;
    if (tc) pg.pushOperators(setCharacterSpacing(tc));

    for (const w of run.words) {
      pg.drawText(w.text, {
        x: w.left * PT_PER_PX + MARGIN_PX * PT_PER_PX,
        y: yPt,
        size: sizePt,
        font,
        color: rgb(0, 0, 0),
      });
    }

    if (tc) pg.pushOperators(setCharacterSpacing(0));
  }
  const ourBytes = await doc.save();
  const buildMs = performance.now() - t0;

  const outPath = path.join(ROOT, 'out', `${fixture}-ours.pdf`);
  fs.writeFileSync(outPath, ourBytes);
  fs.writeFileSync(path.join(ROOT, 'out', `${fixture}-chromium.pdf`), chromiumPdf);

  // ---- score ------------------------------------------------------------
  const sizes = { ours: ourBytes.byteLength, chromium: chromiumPdf.byteLength };
  const ours = await textItems(ourBytes);
  const theirs = await textItems(chromiumPdf);

  console.log(`=== OUTPUT ===`);
  console.log(`ours     : ${(sizes.ours / 1024).toFixed(1)} KB, ${ours.items.length} text items, built in ${buildMs.toFixed(1)}ms`);
  console.log(`chromium : ${(sizes.chromium / 1024).toFixed(1)} KB, ${theirs.items.length} text items`);
  console.log();

  // Match our items to Chromium's by text, then compare placement.
  const taken = new Set();
  const dBase = [], dLeft = [], dWidth = [];
  let matched = 0;

  console.log('=== OUR PDF vs CHROMIUM PDF ===');
  console.log('text'.padEnd(34), 'Δbaseline'.padStart(10), 'Δleft'.padStart(9), 'Δwidth'.padStart(9));
  for (const mine of ours.items) {
    let best = null;
    for (let i = 0; i < theirs.items.length; i++) {
      if (taken.has(i)) continue;
      let acc = '', g = [];
      for (let j = i; j < theirs.items.length && dense(acc).length < dense(mine.str).length; j++) {
        if (taken.has(j)) break;
        acc += theirs.items[j].str; g.push(j);
      }
      if (dense(acc) === dense(mine.str)) { best = { g, first: theirs.items[g[0]], last: theirs.items[g[g.length - 1]] }; break; }
    }
    if (!best) { console.log(mine.str.slice(0, 32).padEnd(34), '  (unmatched)'); continue; }
    best.g.forEach((i) => taken.add(i));
    matched++;
    const theirWidth = (best.last.xPt + best.last.widthPt) - best.first.xPt;
    const b = mine.baselineTopDownPx - best.first.baselineTopDownPx;
    const l = mine.leftPx - best.first.leftPx;
    const w = mine.widthPt - theirWidth;
    dBase.push(b); dLeft.push(l); dWidth.push(w);
    console.log(
      mine.str.slice(0, 32).padEnd(34),
      `${b.toFixed(3)}px`.padStart(10),
      `${l.toFixed(3)}px`.padStart(9),
      `${w.toFixed(2)}pt`.padStart(9),
    );
  }

  const stat = (n, a) => {
    if (!a.length) return;
    const abs = a.map(Math.abs);
    console.log(`${n.padEnd(26)} n=${a.length} meanAbs=${(abs.reduce((x, y) => x + y, 0) / abs.length).toFixed(4)} max=${Math.max(...abs).toFixed(4)}`);
  };
  console.log();
  console.log('=== PLACEMENT ERROR vs CHROMIUM ===');
  stat('baseline (px)', dBase);
  stat('left edge (px)', dLeft);
  stat('run width (pt)', dWidth);
  console.log(`matched ${matched}/${ours.items.length} of our runs against Chromium's output`);

  // ---- does the text survive as text? -----------------------------------
  const srcText = extracted.runs.map((r) => dense(r.text)).join('');
  const outText = ours.items.map((i) => dense(i.str)).join('');
  console.log();
  console.log('=== TEXT FIDELITY ===');
  console.log(`source chars : ${srcText.length}`);
  console.log(`extracted    : ${outText.length}`);
  console.log(`round-trips  : ${srcText === outText ? 'YES — exact' : 'NO'}`);
  if (srcText !== outText) {
    console.log(`  expected: ${srcText.slice(0, 90)}`);
    console.log(`  actual  : ${outText.slice(0, 90)}`);
  }
  console.log(`\nwrote ${path.relative(ROOT, outPath)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
