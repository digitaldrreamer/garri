/**
 * Pagination test.
 *
 * Measures how much of Chromium's fragmentation can be obtained from normal
 * layout APIs, so that we implement as little of it ourselves as possible.
 *
 * Two candidate oracles, scored against Chromium's real page assignments:
 *
 *   A. NAIVE      continuous screen layout, page = floor(y / pageHeight).
 *                 Knows nothing about break-inside, orphans, widows or
 *                 forced breaks.
 *
 *   B. MULTICOL   re-lay the same content in a multicolumn container whose
 *                 column height equals the page content height, with
 *                 column-fill:auto. Chromium then performs *real*
 *                 fragmentation and we read back which column each line
 *                 landed in. Column index = page index.
 *
 * Ground truth is Page.printToPDF: which page each text run actually lands on,
 * and where on that page.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PT_PER_PX = 72 / 96;
const MM_PER_PX = 25.4 / 96;
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

const dense = (s) => s.replace(/\s+/g, '');

async function groundTruth(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    pages.push({
      pageIndex: i - 1,
      heightPx: vp.height / PT_PER_PX,
      items: tc.items.filter((t) => t.str && t.str.trim()).map((t) => ({
        str: t.str,
        baselineTopDownPx: (vp.height - t.transform[5]) / PT_PER_PX,
        leftPx: t.transform[4] / PT_PER_PX,
      })),
    });
  }
  return pages;
}

async function main() {
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  await page.goto(`${base}/fixtures/gate4-pagination.html`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await page.addScriptTag({ url: `${base}/src/capture/textRuns.js` });

  // --- geometry of the page box, as a client-side implementation would know it
  const PAGE = { wMm: 210, hMm: 297, marginMm: 20 };
  // Chromium rounds @page margins to whole points, so the usable content box
  // is slightly smaller than the CSS arithmetic suggests. Replicating that
  // rounding is reproducible client-side and matters at a page boundary,
  // where sub-pixel slack decides whether one more line fits.
  const mmToPt = (mm) => (mm / 25.4) * 72;
  const marginPt = Math.round(mmToPt(PAGE.marginMm));
  const contentWpx = (mmToPt(PAGE.wMm) - 2 * marginPt) / PT_PER_PX;
  const contentHpx = (mmToPt(PAGE.hMm) - 2 * marginPt) / PT_PER_PX;
  const MARGIN_PX = marginPt / PT_PER_PX;

  // --- GROUND TRUTH FIRST: any DOM mutation below would corrupt it -------
  const pdfBytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  fs.writeFileSync(path.join(ROOT, 'out', 'gate4-chromium.pdf'), pdfBytes);

  // --- METHOD A: continuous screen layout -------------------------------
  const flow = await page.evaluate(() => {
    const doc = document.getElementById('doc');
    const top = doc.getBoundingClientRect().top;
    const r = globalThis.__pdf_extractTextRuns(doc);
    return { origin: top, runs: r.runs, ms: r.stats.extractMs };
  });

  // --- METHOD B: multicolumn as a fragmentation oracle -------------------
  const multicol = await page.evaluate((H, W) => {
    const doc = document.getElementById('doc');
    const COLS = 12;
    // A multicolumn container fragments into columns, so it ignores
    // break-*: page entirely. Translate forced page breaks into the
    // equivalent column breaks before measuring.
    let translated = 0;
    for (const el of doc.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.breakBefore === 'page') { el.style.breakBefore = 'column'; translated++; }
      if (cs.breakAfter === 'page') { el.style.breakAfter = 'column'; translated++; }
    }
    Object.assign(doc.style, {
      width: `${W * COLS}px`,
      height: `${H}px`,
      columnCount: String(COLS),
      columnGap: '0px',
      columnFill: 'auto',
    });
    doc.getBoundingClientRect(); // force layout
    const box = doc.getBoundingClientRect();
    const t0 = performance.now();
    const r = globalThis.__pdf_extractTextRuns(doc);
    return {
      // Measured, not assumed: Chromium rounds the container's used width, so
      // the real column pitch differs from W by a fraction of a pixel and an
      // assumed pitch silently collapses every column onto the first.
      originLeft: box.left, originTop: box.top, colWidth: box.width / COLS,
      runs: r.runs, ms: performance.now() - t0, translated,
    };
  }, contentHpx, contentWpx);

  await browser.close();
  server.close();

  const truthPages = await groundTruth(pdfBytes);

  // --- build ground-truth lookup: dense text -> page index --------------
  const truth = [];
  for (const p of truthPages) {
    for (const it of p.items) {
      truth.push({ page: p.pageIndex, baseline: it.baselineTopDownPx, left: it.leftPx, str: it.str });
    }
  }

  console.log('=== SETUP ===');
  console.log(`page content box : ${contentWpx.toFixed(2)} x ${contentHpx.toFixed(2)} px  (margin ${marginPt}pt = ${MARGIN_PX.toFixed(2)}px)`);
  console.log(`Chromium pages   : ${truthPages.length}`);
  console.log(`ground-truth text items: ${truth.length}`);
  console.log(`extraction: flow ${flow.ms.toFixed(0)}ms, multicol ${multicol.ms.toFixed(0)}ms`);
  console.log(`forced page breaks translated to column breaks: ${multicol.translated}`);
  console.log();

  // --- score a method ----------------------------------------------------
  function score(name, predictions) {
    // Match each prediction to a ground-truth item by text, in order.
    let cursor = 0;
    let matched = 0, pageOk = 0;
    const perPageMiss = new Map();
    const misses = [];
    const yErr = [];
    const yDetail = [];

    for (const pred of predictions) {
      const want = dense(pred.text);
      if (!want) continue;
      let found = -1;
      for (let i = cursor; i < truth.length; i++) {
        if (dense(truth[i].str) === want) { found = i; break; }
      }
      // fall back to a prefix match (Chromium splits some runs into items)
      if (found === -1) {
        for (let i = cursor; i < truth.length; i++) {
          let acc = '';
          for (let j = i; j < truth.length && dense(acc).length < want.length; j++) acc += truth[j].str;
          if (dense(acc) === want) { found = i; break; }
        }
      }
      if (found === -1) continue;
      cursor = found + 1;
      matched++;
      const t = truth[found];
      if (t.page === pred.page) {
        pageOk++;
        yErr.push(pred.y - t.baseline);
        yDetail.push({ text: pred.text.slice(0, 34), page: t.page + 1, ours: pred.y, truth: t.baseline, d: pred.y - t.baseline });
      } else {
        perPageMiss.set(t.page, (perPageMiss.get(t.page) || 0) + 1);
        misses.push({ text: pred.text.slice(0, 46), pred: pred.page + 1, truth: t.page + 1 });
      }
    }

    const pct = matched ? (100 * pageOk / matched) : 0;
    console.log(`--- ${name} ---`);
    console.log(`  runs matched to ground truth : ${matched}/${predictions.length}`);
    console.log(`  correct page assignment      : ${pageOk}/${matched}  (${pct.toFixed(1)}%)`);
    if (perPageMiss.size) {
      const s = [...perPageMiss.entries()].sort((a, b) => a[0] - b[0])
        .map(([p, n]) => `p${p + 1}:${n}`).join(' ');
      console.log(`  misassigned, by true page    : ${s}`);
    }
    if (yErr.length) {
      const abs = yErr.map(Math.abs);
      console.log(`  baseline error within page   : mean ${(abs.reduce((a, b) => a + b, 0) / abs.length).toFixed(3)}px  max ${Math.max(...abs).toFixed(3)}px`);
    }
    if (misses.length) {
      console.log('  MISASSIGNED:');
      for (const m of misses) console.log(`    p${m.pred}->p${m.truth}  ${JSON.stringify(m.text)}`);
    }
    // where does y error start on each page?
    const byPage = new Map();
    for (const d of yDetail) if (!byPage.has(d.page)) byPage.set(d.page, []);
    for (const d of yDetail) byPage.get(d.page).push(d);
    for (const [pg, arr] of [...byPage.entries()].sort((a,b)=>a[0]-b[0])) {
      const f = arr[0], l = arr[arr.length - 1];
      console.log(`  page ${pg}: first run d=${f.d.toFixed(2)}px ${JSON.stringify(f.text.slice(0,26))} | last run d=${l.d.toFixed(2)}px`);
    }
    console.log();
    return { matched, pageOk, pct };
  }

  // Content resumes at the top of the content box on every new page, so a
  // run's y is measured from the first run placed on that page, not from a
  // modulo of the continuous flow.
  function resolveY(preds) {
    const firstTop = new Map();
    for (const p of preds) {
      const cur = firstTop.get(p.page);
      if (cur === undefined || p.rectTop < cur) firstTop.set(p.page, p.rectTop);
    }
    for (const p of preds) p.y = MARGIN_PX + (p.rawY - firstTop.get(p.page));
    return preds;
  }

  // METHOD A predictions: continuous flow cut every contentHpx
  const predA = resolveY(flow.runs.map((r) => {
    const yInDoc = r.rect.top - flow.origin;
    return {
      text: r.text,
      page: Math.floor(yInDoc / contentHpx),
      rectTop: r.rect.top,
      rawY: r.baselineCandidates.topPlusFontAscent,
    };
  }));

  // METHOD B predictions: column index from x, y within column
  const predB = multicol.runs.map((r) => {
    const xInDoc = r.rect.left - multicol.originLeft;
    return {
      text: r.text,
      page: Math.floor(xInDoc / multicol.colWidth + 1e-3),
      // A column's top is the page content-box top, so this is the real
      // offset — including whatever Chromium did to margins at the boundary.
      y: MARGIN_PX + (r.baselineCandidates.topPlusFontAscent - multicol.originTop),
    };
  });

  console.log('=== PAGE ASSIGNMENT ACCURACY ===');
  const a = score('A · naive height partition', predA);
  const b = score('B · multicolumn oracle', predB);

  const colsUsed = new Set(predB.map((p) => p.page)).size;
  console.log('=== SUMMARY ===');
  console.log(`Chromium produced      : ${truthPages.length} pages`);
  console.log(`multicolumn produced   : ${colsUsed} columns`);
  console.log(`naive page accuracy    : ${a.pct.toFixed(1)}%`);
  console.log(`multicolumn accuracy   : ${b.pct.toFixed(1)}%`);

  fs.writeFileSync(path.join(ROOT, 'out', 'gate4-result.json'),
    JSON.stringify({ contentWpx, contentHpx, truthPages, predA, predB }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
