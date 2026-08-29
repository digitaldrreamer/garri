/**
 * The advanced furniture cases: @page margin boxes, counter(page)/counter(pages),
 * position: sticky, and nested repeating table headers.
 *
 * Every one of these was recorded as "untested, and Chromium's support is
 * limited". The first thing this does is check that claim.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PT = 72 / 96;
const MIME = { '.html': 'text/html', '.ttf': 'font/ttf', '.js': 'text/javascript' };

const PAGE = { wMm: 120, hMm: 90, mTopMm: 14, mSideMm: 10 };
const mmPx = (mm) => (mm / 25.4) * 96;

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
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page]', m.text()); });
  await page.setViewport({ width: 1200, height: 1600 });
  await page.goto(`${base}/fixtures/probes/furniture-advanced.html`, { waitUntil: 'networkidle0' });

  const chromiumPdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  fs.writeFileSync(path.join(ROOT, 'out', 'furn-adv-chromium.pdf'), chromiumPdf);

  await page.addScriptTag({ url: `${base}/src/pagination/furniture.js` });

  // Chromium's own page count, which counter(pages) needs.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const truthDoc = await pdfjs.getDocument({ data: chromiumPdf.slice(), useSystemFonts: false }).promise;
  const pageCount = truthDoc.numPages;

  const result = await page.evaluate((geom, nPages) => {
    const F = globalThis.__pdf_furniture;
    const boxes = F.marginBoxes();
    const furniture = F.identify(document.getElementById('doc'));

    const ctx = document.createElement('canvas').getContext('2d');
    const DEF = F.MARGIN_BOX_DEFAULT_FONT;
    const metricsFor = (b) => {
      // initial font, not the body's -- margin boxes do not inherit from it
      const size = b.font.size || DEF.size;
      const fam = b.font.family || DEF.family;
      ctx.font = `${b.font.style || DEF.style} ${b.font.weight || DEF.weight} ${size}px ${fam}`;
      const m = ctx.measureText('Hxpg');
      return { size, fam, ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent,
               width: (t) => { ctx.font = `${b.font.style || DEF.style} ${b.font.weight || DEF.weight} ${size}px ${fam}`; return ctx.measureText(t).width; } };
    };

    const placed = [];
    for (let p = 1; p <= nPages; p++) {
      for (const b of boxes) {
        if (b.unsupportedSlot || !b.content) continue;
        const { text, unresolved } = F.resolveMarginContent(b.content, p, nPages);
        if (!text) continue;
        const met = metricsFor(b);
        const pl = F.marginBoxPlacement(b.slot, geom, met);
        const w = met.width(text);
        let x;
        if (pl.align === 'left') x = pl.contentL;
        else if (pl.align === 'right') x = pl.contentR - w;
        else x = (pl.contentL + pl.contentR) / 2 - w / 2;
        placed.push({ page: p, slot: b.slot, text, x, baseline: pl.baseline, width: w, unresolved });
      }
    }

    return {
      boxes: boxes.map((b) => ({ slot: b.slot, content: b.content, unsupportedSlot: b.unsupportedSlot })),
      placed,
      tables: furniture.tables.map((t) => ({
        rows: t.table.querySelectorAll('tbody > tr').length,
        nested: !!t.table.parentElement.closest('table'),
        headH: t.headH, footH: t.footH,
        headText: t.head ? t.head.textContent.trim() : null,
      })),
      fixed: furniture.fixed.length,
    };
  }, {
    w: mmPx(PAGE.wMm), h: mmPx(PAGE.hMm),
    marginTop: mmPx(PAGE.mTopMm), marginBottom: mmPx(PAGE.mTopMm),
    marginLeft: mmPx(PAGE.mSideMm), marginRight: mmPx(PAGE.mSideMm),
  }, pageCount);

  await browser.close();
  server.close();

  console.log('=== @page MARGIN BOXES (via CSSOM) ===');
  for (const b of result.boxes) {
    console.log(`  ${b.slot.padEnd(14)} ${b.unsupportedSlot ? '(slot not placed)' : JSON.stringify(b.content)}`);
  }

  console.log('\n=== NESTED REPEATING TABLES detected ===');
  for (const t of result.tables) {
    console.log(`  rows=${String(t.rows).padStart(3)}  nested=${String(t.nested).padEnd(5)}  headH=${t.headH.toFixed(1)}  head=${JSON.stringify(t.headText)}`);
  }

  // ---- compare our placement to Chromium's ------------------------------
  const truth = [];
  for (let i = 1; i <= pageCount; i++) {
    const pg = await truthDoc.getPage(i);
    const vp = pg.getViewport({ scale: 1 });
    const tc = await pg.getTextContent();
    for (const it of tc.items) {
      if (!it.str.trim()) continue;
      truth.push({ page: i, str: it.str, x: it.transform[4] / PT,
        baseline: (vp.height - it.transform[5]) / PT, w: it.width / PT });
    }
  }

  console.log('\n=== MARGIN BOX PLACEMENT vs CHROMIUM ===');
  console.log('page'.padStart(4), 'slot'.padEnd(14), 'text'.padEnd(18),
    'Δx'.padStart(8), 'Δbaseline'.padStart(10), 'Δwidth'.padStart(8));
  const dx = [], dy = [];
  for (const p of result.placed) {
    const t = truth.find((q) => q.page === p.page && q.str.trim() === p.text.trim());
    if (!t) { console.log(String(p.page).padStart(4), p.slot.padEnd(14), JSON.stringify(p.text).padEnd(18), '  (not found in Chromium output)'); continue; }
    dx.push(p.x - t.x); dy.push(p.baseline - t.baseline);
    console.log(String(p.page).padStart(4), p.slot.padEnd(14), JSON.stringify(p.text).padEnd(18),
      (p.x - t.x).toFixed(2).padStart(8), (p.baseline - t.baseline).toFixed(2).padStart(10),
      (p.width - t.w).toFixed(2).padStart(8));
  }
  const stat = (n, a) => a.length && console.log(`${n}: mean ${(a.reduce((x, y) => x + Math.abs(y), 0) / a.length).toFixed(3)}px  max ${Math.max(...a.map(Math.abs)).toFixed(3)}px`);
  console.log();
  stat('x error', dx);
  stat('baseline error', dy);

  const sticky = truth.filter((t) => t.str.includes('STICKYHEADING'));
  console.log(`\nposition: sticky — appears on ${new Set(sticky.map((s) => s.page)).size} of ${pageCount} pages ` +
    `=> ${sticky.length === 1 ? 'ordinary flow content, NOT furniture' : 'repeats'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
