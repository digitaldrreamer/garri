/**
 * Scale testing.
 *
 * Measures 1, 10, 25, 50 and 100 pages: per-phase time,
 * peak JS heap, output size, and whether anything degrades non-linearly.
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

const SHELL_PATH = path.join(ROOT, 'fixtures', 'scale-shell.html');
const SHELL = `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: 210mm 297mm; margin: 20mm; }
  html, body { margin: 0; padding: 0; }
  @font-face { font-family: "Sans"; src: url("/fixtures/font.ttf") format("truetype"); }
  body { font-family: "Sans"; font-size: 16px; line-height: 24px; width: 170mm; }
  h2 { font-size: 20px; line-height: 28px; margin: 16px 0 8px; font-weight: 400; }
  p { margin: 0 0 10px; }
</style></head><body><div id="doc"></div></body></html>`;

async function measure(page, pages, base) {
  return page.evaluate(async (nPages, b) => {
    const doc = document.getElementById('doc');
    doc.innerHTML = '';

    // ~40 lines per A4 page at 16/24; two-line paragraphs plus headings
    const perPage = 13;
    const total = nPages * perPage;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < total; i++) {
      if (i % perPage === 0) {
        const h = document.createElement('h2');
        h.textContent = `Section ${i / perPage + 1}`;
        frag.appendChild(h);
      }
      const p = document.createElement('p');
      p.textContent = `Paragraph ${i + 1}. The quick brown fox jumps over the lazy dog, ` +
        `and continues for long enough that this paragraph wraps onto a second line of text.`;
      frag.appendChild(p);
    }
    doc.appendChild(frag);
    await document.fonts.ready;
    doc.getBoundingClientRect();

    const mem = () => (performance.memory ? performance.memory.usedJSHeapSize : 0);
    const t = [];
    const mark = (name) => t.push({ name, at: performance.now(), heap: mem() });

    mark('start');

    // --- 1. extraction
    const extracted = globalThis.__pdf_extractTextRuns(doc);
    mark('extract');

    // --- 2. pagination oracle
    // COLS must cover the document: a fixed 16 cannot express 100 pages.
    const PT = 72 / 96, MARGIN = 76;
    const A4 = { w: 595.276, h: 841.89 };
    const contentW = A4.w / PT - 2 * MARGIN;
    const contentH = A4.h / PT - 2 * MARGIN;
    const COLS = Math.max(4, nPages + 4);
    const prev = doc.style.cssText;
    Object.assign(doc.style, {
      width: `${contentW * COLS}px`, height: `${contentH}px`,
      columnWidth: `${contentW}px`, columnGap: '0px', columnFill: 'auto',
    });
    doc.getBoundingClientRect();
    const box = doc.getBoundingClientRect();
    const cw = box.width / COLS;
    const paged = globalThis.__pdf_extractTextRuns(doc);
    const colOf = (r) => Math.floor((r.rect.left - box.left) / cw + 1e-3);
    const columns = new Set(paged.runs.map(colOf));
    doc.style.cssText = prev;
    mark('paginate');

    // --- 3. build the PDF
    const { PDFDocument, rgb } = PDFLib;
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const fontBytes = await (await fetch(`${b}/fixtures/font.ttf`)).arrayBuffer();
    const font = await pdf.embedFont(fontBytes, { subset: true });
    mark('embedFont');

    const byCol = new Map();
    for (const r of paged.runs) {
      const c = colOf(r);
      if (!byCol.has(c)) byCol.set(c, []);
      byCol.get(c).push(r);
    }
    for (const c of [...byCol.keys()].sort((a, z) => a - z)) {
      const pg = pdf.addPage([A4.w, A4.h]);
      for (const r of byCol.get(c)) {
        const yPt = A4.h - (MARGIN + r.baselineCandidates.topPlusFontAscent - box.top) * PT;
        for (const w of r.words) {
          pg.drawText(w.text, {
            x: (MARGIN + (w.left - box.left) % cw) * PT, y: yPt,
            size: r.font.size * PT, font, color: rgb(0, 0, 0),
          });
        }
      }
    }
    mark('draw');

    const bytes = await pdf.save();
    mark('save');

    const span = (a, z) => t.find((x) => x.name === z).at - t.find((x) => x.name === a).at;
    return {
      chars: extracted.runs.reduce((s, r) => s + r.text.length, 0),
      runs: extracted.runs.length,
      columns: columns.size,
      pdfPages: pdf.getPageCount(),
      bytes: bytes.byteLength,
      heapStart: t[0].heap,
      heapPeak: Math.max(...t.map((x) => x.heap)),
      timing: {
        extract: span('start', 'extract'),
        paginate: span('extract', 'paginate'),
        embedFont: span('paginate', 'embedFont'),
        draw: span('embedFont', 'draw'),
        save: span('draw', 'save'),
        total: span('start', 'save'),
      },
    };
  }, pages, base);
}

async function main() {
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'],
  });

  fs.writeFileSync(SHELL_PATH, SHELL);

  const sizes = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [1, 10, 25, 50, 100];
  const rows = [];

  for (const n of sizes) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1200 });
    await page.goto(`${base}/fixtures/scale-shell.html`, { waitUntil: 'networkidle0' });
    await page.addScriptTag({ url: `${base}/node_modules/pdf-lib/dist/pdf-lib.min.js` });
    await page.addScriptTag({ url: `${base}/node_modules/@pdf-lib/fontkit/dist/fontkit.umd.min.js` });
    await page.addScriptTag({ url: `${base}/src/capture/textRuns.js` });
    const r = await measure(page, n, base);
    await page.close();
    rows.push({ n, ...r });
    console.log(`  measured ${n} page(s): ${r.pdfPages} PDF pages, ${r.chars} chars`);
  }

  await browser.close();
  server.close();

  console.log('\n=== SCALE ===');
  console.log('target'.padStart(6), 'pages'.padStart(6), 'chars'.padStart(8), 'runs'.padStart(6),
    'extract'.padStart(9), 'paginate'.padStart(9), 'font'.padStart(7), 'draw'.padStart(8),
    'save'.padStart(8), 'TOTAL'.padStart(9), 'KB'.padStart(7), 'heapMB'.padStart(8));
  for (const r of rows) {
    console.log(
      String(r.n).padStart(6), String(r.pdfPages).padStart(6), String(r.chars).padStart(8),
      String(r.runs).padStart(6),
      r.timing.extract.toFixed(0).padStart(9), r.timing.paginate.toFixed(0).padStart(9),
      r.timing.embedFont.toFixed(0).padStart(7), r.timing.draw.toFixed(0).padStart(8),
      r.timing.save.toFixed(0).padStart(8), r.timing.total.toFixed(0).padStart(9),
      (r.bytes / 1024).toFixed(0).padStart(7),
      (r.heapPeak / 1048576).toFixed(1).padStart(8),
    );
  }

  console.log('\n=== LINEARITY (per page, normalised to the 1-page case) ===');
  const base1 = rows[0];
  console.log('target'.padStart(6), 'ms/page'.padStart(9), 'vs linear'.padStart(11),
    'chars/s'.padStart(10), 'KB/page'.padStart(9));
  for (const r of rows) {
    const perPage = r.timing.total / r.pdfPages;
    const ratio = perPage / (base1.timing.total / base1.pdfPages);
    console.log(
      String(r.n).padStart(6), perPage.toFixed(1).padStart(9),
      `${ratio.toFixed(2)}x`.padStart(11),
      Math.round((r.chars / r.timing.total) * 1000).toString().padStart(10),
      (r.bytes / 1024 / r.pdfPages).toFixed(1).padStart(9),
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
