/**
 * Text geometry test.
 *
 * Question: can client-side JS recover Chromium's text placement well enough
 * to position native PDF glyphs?
 *
 * Method: render a fixture, extract text runs with Web APIs only, then ask the
 * same Chromium instance for its own PDF via Page.printToPDF and read the real
 * baseline origins out of that PDF's text operators. The PDF is ground truth;
 * the extractor never sees it.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MIME = { '.html': 'text/html', '.ttf': 'font/ttf', '.css': 'text/css', '.js': 'text/javascript' };

function serve(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
      if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
        res.writeHead(404).end('nope');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** Pull baseline-positioned text out of a PDF using pdfjs. */
async function pdfTextItems(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    pages.push({
      index: i,
      widthPt: vp.width,
      heightPt: vp.height,
      items: tc.items
        .filter((it) => it.str && it.str.trim())
        .map((it) => ({
          str: it.str,
          // transform = [a,b,c,d,e,f]; (e,f) is the glyph-run origin, i.e. the
          // baseline start, in PDF user space (origin bottom-left, y up).
          xPt: it.transform[4],
          yPt: it.transform[5],
          scale: it.transform[0],
          widthPt: it.width,
          heightPt: it.height,
          fontName: it.fontName,
        })),
    });
  }
  return pages;
}

const PT_PER_PX = 72 / 96;

function norm(s) {
  return s.replace(/\s+/g, ' ').trim();
}

async function main() {
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  // Viewport wide enough that the 170mm body is never the constraint.
  await page.setViewport({ width: 1200, height: 1600, deviceScaleFactor: 1 });
  const fixture = process.argv[2] || 'gate1-text';
  await page.goto(`${base}/fixtures/${fixture}.html`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);

  await page.addScriptTag({ url: `${base}/src/capture/textRuns.js` });
  const extracted = await page.evaluate(() => globalThis.__pdf_extractTextRuns(document.body));

  const pdfBytes = await page.pdf({
    preferCSSPageSize: true,
    printBackground: true,
  });
  fs.writeFileSync(path.join(ROOT, 'out', `${fixture}-chromium.pdf`), pdfBytes);

  const pdfPages = await pdfTextItems(pdfBytes);

  await browser.close();
  server.close();

  // ---- report ----------------------------------------------------------
  console.log('=== EXTRACTOR (Web APIs only) ===');
  console.log(`runs=${extracted.stats.runCount} charProbes=${extracted.stats.charProbes} ` +
    `extractMs=${extracted.stats.extractMs.toFixed(1)}`);
  console.log();

  console.log('=== CHROMIUM printToPDF ===');
  for (const p of pdfPages) {
    console.log(`page ${p.index}: ${p.widthPt.toFixed(1)}x${p.heightPt.toFixed(1)}pt, ${p.items.length} text items`);
  }
  console.log();

  // The fixture is single-page; margins come from @page.
  const pg = pdfPages[0];
  const pdfItems = pg.items.map((it) => ({
    ...it,
    // convert PDF baseline to a top-down px coordinate on the page
    baselineTopDownPx: (pg.heightPt - it.yPt) / PT_PER_PX,
    leftPx: it.xPt / PT_PER_PX,
  }));

  // Align runs to PDF items sequentially: both are in document order, and one
  // extracted line may be split across several PDF items.
  // Compare on non-whitespace only: letter/word-spacing makes Chromium emit
  // extra text items whose whitespace does not survive normalisation.
  // Search rather than walk in lockstep: RTL and bidi reorder PDF items
  // relative to DOM order, so a strictly sequential walk desyncs.
  const dense = (s) => s.replace(/\s+/g, '');
  const pairs = [];
  const taken = new Set();
  for (const run of extracted.runs) {
    const want = dense(run.text);
    let group = null;
    for (let start = 0; start < pdfItems.length && !group; start++) {
      if (taken.has(start)) continue;
      let acc = '';
      const g = [];
      for (let j = start; j < pdfItems.length && dense(acc).length < want.length; j++) {
        if (taken.has(j)) break;
        acc += pdfItems[j].str;
        g.push(j);
      }
      if (dense(acc) === want) group = g;
    }
    if (group) {
      group.forEach((i) => taken.add(i));
      pairs.push({ run, group: group.map((i) => pdfItems[i]), matched: true });
    } else {
      pairs.push({ run, group: null, matched: false });
    }
  }

  // The page origin is the @page margin. Derive it from the data rather than
  // hardcoding it, then verify it against the declared 20mm.
  const ok = pairs.filter((p) => p.matched);
  const originX = median(ok.map((p) => p.group[0].leftPx - p.run.rect.left));
  const originY = median(ok.map((p) => p.group[0].baselineTopDownPx - p.run.baselineCandidates.topPlusFontAscent));
  const declaredMarginPx = (20 / 25.4) * 96;
  console.log('=== PAGE ORIGIN ===');
  console.log(`derived from data: x=${originX.toFixed(3)}px y=${originY.toFixed(3)}px`);
  console.log(`@page margin 20mm = ${declaredMarginPx.toFixed(3)}px  ` +
    `(Chromium appears to round to ${(originX * PT_PER_PX).toFixed(2)}pt)`);
  console.log();

  console.log('=== SIDE BY SIDE (page-origin removed) ===');
  console.log(
    'text'.padEnd(34), 'ok'.padStart(3),
    'top+asc'.padStart(9), 'PDF base'.padStart(9), 'Δbase'.padStart(8),
    'left'.padStart(9), 'PDF left'.padStart(9), 'Δleft'.padStart(8),
  );

  const cands = { topPlusFontAscent: [], topPlusActualAscent: [], bottomMinusFontDescent: [] };
  const leftDeltas = [];
  const rightDeltas = [];

  for (const p of pairs) {
    if (!p.matched) {
      console.log(norm(p.run.text).slice(0,32).padEnd(34), 'N'.padStart(3), '   (no PDF item matched this text)');
      continue;
    }
    const gt = p.group[0];
    const ourBase = p.run.baselineCandidates.topPlusFontAscent + originY;
    const ourLeft = p.run.rect.left + originX;
    const ourRight = p.run.rect.right + originX;
    const dBase = ourBase - gt.baselineTopDownPx;
    const dLeft = ourLeft - gt.leftPx;
    const dRight = ourRight - gt.leftPx;
    for (const k of Object.keys(cands)) {
      cands[k].push(p.run.baselineCandidates[k] + originY - gt.baselineTopDownPx);
    }
    leftDeltas.push(dLeft);
    rightDeltas.push(dRight);
    console.log(
      norm(p.run.text).slice(0, 32).padEnd(34),
      (p.matched ? 'y' : 'N').padStart(3),
      ourBase.toFixed(2).padStart(9),
      gt.baselineTopDownPx.toFixed(2).padStart(9),
      dBase.toFixed(3).padStart(8),
      ourLeft.toFixed(2).padStart(9),
      gt.leftPx.toFixed(2).padStart(9),
      dLeft.toFixed(3).padStart(8),
    );
  }

  const summarize = (name, arr) => {
    if (!arr.length) return;
    const abs = arr.map(Math.abs);
    const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
    console.log(`${name.padEnd(38)} n=${arr.length} meanAbs=${mean.toFixed(4)}px ` +
      `max=${Math.max(...abs).toFixed(4)}px`);
  };
  console.log();
  console.log('=== BASELINE HYPOTHESES (px error vs Chromium PDF) ===');
  for (const [k, v] of Object.entries(cands)) summarize(k, v);
  console.log();
  summarize('left edge  (rect.left vs item origin)', leftDeltas);
  summarize('right edge (rect.right vs item origin)', rightDeltas);
  console.log(`text alignment: ${ok.length}/${pairs.length} runs matched exactly`);

  fs.writeFileSync(
    path.join(ROOT, 'out', `${fixture}-result.json`),
    JSON.stringify({ extracted, pdfPages }, null, 2),
  );
}

main().catch((e) => { console.error(e); process.exit(1); });

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
