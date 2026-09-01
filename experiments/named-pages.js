/**
 * Furniture under named pages.
 *
 * A multicolumn container has one fixed geometry, so named pages are split into
 * uniform runs and fragmented with a separate oracle pass. The browser exposes:
 *   getComputedStyle(el).page  names the run an element belongs to
 *   CSSOM @page rules          give each run its size, margin and margin boxes
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PT = 72 / 96;
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
  await page.setViewport({ width: 1600, height: 1600 });
  await page.goto(`${base}/fixtures/probes/named-pages-furniture.html`, { waitUntil: 'networkidle0' });

  const chromiumPdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  fs.writeFileSync(path.join(ROOT, 'out', 'named-pages-chromium.pdf'), chromiumPdf);

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const truthDoc = await pdfjs.getDocument({ data: chromiumPdf.slice(), useSystemFonts: false }).promise;
  const truthPages = [];
  for (let i = 1; i <= truthDoc.numPages; i++) {
    const pg = await truthDoc.getPage(i);
    const vp = pg.getViewport({ scale: 1 });
    const tc = await pg.getTextContent();
    truthPages.push({
      w: vp.width / PT, h: vp.height / PT,
      items: tc.items.filter((t) => t.str.trim()).map((t) => t.str),
    });
  }

  await page.addScriptTag({ url: `${base}/src/capture/textRuns.js` });
  await page.addScriptTag({ url: `${base}/src/pagination/furniture.js` });

  const result = await page.evaluate(() => {
    const F = globalThis.__pdf_furniture;
    const doc = document.getElementById('doc');
    const rules = F.pageRules();
    const runs = F.segmentByPage(doc);

    const mmPx = (mm) => (mm / 25.4) * 96;
    function geometryFor(name) {
      const rule = rules.get(name) || rules.get('') || {};
      const size = (rule.size || '').match(/([\d.]+)mm\s+([\d.]+)mm/);
      const marg = (rule.margin || '').match(/([\d.]+)mm(?:\s+([\d.]+)mm)?/);
      const w = size ? mmPx(+size[1]) : mmPx(210);
      const h = size ? mmPx(+size[2]) : mmPx(297);
      const mv = marg ? Math.round(mmPx(+marg[1])) : 0;
      const mh = marg && marg[2] !== undefined ? Math.round(mmPx(+marg[2])) : mv;
      return { w, h, mTop: mv, mBottom: mv, mLeft: mh, mRight: mh,
               contentW: w - 2 * mh, contentH: h - 2 * mv, rule };
    }

    // ---- fragment each run with ITS OWN page geometry --------------------
    const COLS = 16;
    const pages = [];          // global page list
    const perRun = [];

    const allEls = new Set(runs.flatMap((r) => r.elements));

    for (const run of runs) {
      const g = geometryFor(run.page);

      // Isolate the run by hiding the others. A run's elements are not
      // necessarily contiguous siblings once nested runs exist, so they cannot
      // be moved into a wrapper.
      const hidden = [];
      for (const el of allEls) {
        if (run.elements.includes(el)) continue;
        hidden.push([el, el.style.display]);
        el.style.display = 'none';
      }

      F.translatePageBreaks(doc);

      const prevStyle = doc.style.cssText;
      Object.assign(doc.style, {
        width: `${g.contentW * COLS}px`, height: `${g.contentH}px`,
        columnWidth: `${g.contentW}px`, columnGap: '0px', columnFill: 'auto',
      });
      doc.getBoundingClientRect();

      const box = doc.getBoundingClientRect();
      const cw = box.width / COLS;
      const extracted = globalThis.__pdf_extractTextRuns(doc);
      const runsByCol = new Map();
      for (const r of extracted.runs) {
        const c = Math.floor((r.rect.left - box.left) / cw + 1e-3);
        if (!runsByCol.has(c)) runsByCol.set(c, []);
        runsByCol.get(c).push(r.text);
      }
      const cols = [...runsByCol.keys()].sort((a, b) => a - b);

      perRun.push({ page: run.page, geometry: { w: g.w, h: g.h, contentW: g.contentW, contentH: g.contentH }, columns: cols.length });
      for (const c of cols) {
        pages.push({ run: run.page, w: g.w, h: g.h, geometry: g, texts: runsByCol.get(c) });
      }

      doc.style.cssText = prevStyle;
      for (const [el, d] of hidden) el.style.display = d;
    }

    // ---- furniture per page, using that page's OWN rule -------------------
    const ctx = document.createElement('canvas').getContext('2d');
    const DEF = F.MARGIN_BOX_DEFAULT_FONT;
    const total = pages.length;
    pages.forEach((pg, i) => {
      const rule = rules.get(pg.run) || rules.get('');
      pg.furniture = [];
      for (const b of (rule && rule.boxes) || []) {
        // counter(page) is document-global, not per run
        const { text } = F.resolveMarginContent(b.content, i + 1, total);
        if (!text) continue;
        const size = b.font.size || DEF.size;
        const fam = b.font.family || DEF.family;
        ctx.font = `${b.font.style || DEF.style} ${b.font.weight || DEF.weight} ${size}px ${fam}`;
        const m = ctx.measureText('Hxpg');
        const pl = F.marginBoxPlacement(b.slot, {
          w: pg.geometry.w, h: pg.geometry.h,
          marginTop: pg.geometry.mTop, marginBottom: pg.geometry.mBottom,
          marginLeft: pg.geometry.mLeft, marginRight: pg.geometry.mRight,
        }, { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent });
        const w = ctx.measureText(text).width;
        let x;
        if (pl.align === 'left') x = pl.contentL;
        else if (pl.align === 'right') x = pl.contentR - w;
        else x = (pl.contentL + pl.contentR) / 2 - w / 2;
        pg.furniture.push({ slot: b.slot, text, x, baseline: pl.baseline });
      }
    });

    return {
      rules: [...rules.values()].map((r) => ({ name: r.name || '(default)', size: r.size, boxes: r.boxes.length })),
      runs: perRun,
      pages: pages.map((p) => ({ run: p.run || '(default)', w: p.w, h: p.h,
        texts: p.texts, furniture: p.furniture })),
    };
  });

  await browser.close();
  server.close();

  console.log('=== @page RULES ===');
  for (const r of result.rules) console.log(`  ${String(r.name).padEnd(11)} size=${r.size.padEnd(14)} marginBoxes=${r.boxes}`);

  console.log('\n=== RUNS (one oracle pass each) ===');
  for (const r of result.runs) {
    console.log(`  page="${(r.page || '(default)')}"`.padEnd(24) +
      `content ${r.geometry.contentW.toFixed(1)} x ${r.geometry.contentH.toFixed(1)} px  -> ${r.columns} column(s)`);
  }

  console.log('\n=== PAGES: ours vs Chromium ===');
  console.log('#'.padStart(3), 'run'.padEnd(11), 'ours w x h'.padStart(16), 'chromium w x h'.padStart(16), 'size'.padStart(6), 'furniture');
  let sizeOk = 0;
  for (let i = 0; i < Math.max(result.pages.length, truthPages.length); i++) {
    const o = result.pages[i], t = truthPages[i];
    if (!o || !t) { console.log(String(i + 1).padStart(3), '  (page count differs)'); continue; }
    const match = Math.abs(o.w - t.w) < 1 && Math.abs(o.h - t.h) < 1;
    if (match) sizeOk++;
    console.log(
      String(i + 1).padStart(3), o.run.padEnd(11),
      `${o.w.toFixed(1)} x ${o.h.toFixed(1)}`.padStart(16),
      `${t.w.toFixed(1)} x ${t.h.toFixed(1)}`.padStart(16),
      (match ? 'ok' : 'DIFF').padStart(6),
      o.furniture.map((f) => `${f.slot}=${JSON.stringify(f.text)}`).join(' '),
    );
  }

  console.log(`\npage count: ours ${result.pages.length}, chromium ${truthPages.length}`);
  console.log(`page sizes matching: ${sizeOk}/${truthPages.length}`);

  // furniture text present on the right page?
  let furnOk = 0, furnTotal = 0;
  for (let i = 0; i < Math.min(result.pages.length, truthPages.length); i++) {
    const truthText = dense(truthPages[i].items.join(''));
    for (const f of result.pages[i].furniture) {
      furnTotal++;
      if (truthText.includes(dense(f.text))) furnOk++;
    }
  }
  console.log(`furniture strings on the correct page: ${furnOk}/${furnTotal}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
