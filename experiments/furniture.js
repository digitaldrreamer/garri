/**
 * Page furniture layer, measured against the three probes it exists to fix.
 *
 * Baseline (findings 03, no furniture layer):
 *   table-header-group   49/49 pages, but the header is ABSENT on continuations
 *                        and every row below sits 21.50 px high
 *   table-footer-group   22/28 pages  <- assignment is wrong, not just paint
 *   position-fixed       0/4 pages, and it invents a third column
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PT_PER_PX = 72 / 96;
const MIME = { '.html': 'text/html', '.ttf': 'font/ttf', '.js': 'text/javascript' };

const PAGE = { wMm: 120, hMm: 90, marginMm: 10 };
const mmToPx = (mm) => (mm / 25.4) * 96;
const MARGIN_PX = Math.round(mmToPx(PAGE.marginMm));
const CONTENT_W = mmToPx(PAGE.wMm) - 2 * MARGIN_PX;
const CONTENT_H = mmToPx(PAGE.hMm) - 2 * MARGIN_PX;

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

async function truthFromPdf(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const vp = pg.getViewport({ scale: 1 });
    const tc = await pg.getTextContent();
    for (const t of tc.items) {
      if (!t.str || !t.str.trim()) continue;
      out.push({ page: i - 1, str: t.str, y: (vp.height - t.transform[5]) / PT_PER_PX });
    }
  }
  return { items: out, pages: doc.numPages };
}

async function runProbe(browser, base, name, useFurniture) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.goto(`${base}/fixtures/probes/${name}.html`, { waitUntil: 'networkidle0' });

  const pdfBytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  const truth = await truthFromPdf(pdfBytes);

  await page.addScriptTag({ url: `${base}/src/capture/textRuns.js` });
  await page.addScriptTag({ url: `${base}/src/pagination/furniture.js` });

  const result = await page.evaluate((H, W, withFurniture) => {
    const doc = document.getElementById('doc');
    const F = globalThis.__pdf_furniture;

    const furniture = F.identify(doc);
    let restore = () => {};
    if (withFurniture) restore = F.detach(furniture);   // keep fixed out of the flow

    // forced page breaks are column breaks inside a multicol container
    let translated = 0;
    for (const el of doc.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.breakBefore === 'page') { el.style.breakBefore = 'column'; translated++; }
      if (cs.breakAfter === 'page') { el.style.breakAfter = 'column'; translated++; }
    }

    const COLS = 16;
    Object.assign(doc.style, {
      width: `${W * COLS}px`, height: `${H}px`,
      columnWidth: `${W}px`, columnGap: '0px', columnFill: 'auto',
    });
    doc.getBoundingClientRect();

    const box = () => doc.getBoundingClientRect();
    const colWidth = () => box().width / COLS;
    const columnOf = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return Math.floor((r.left - box().left) / colWidth() + 1e-3);
    };

    let reservation = { passes: 0, spacers: 0 };
    if (withFurniture) reservation = F.reserve(furniture, () => columnOf);

    // Per-LINE runs: Chromium's text items are line fragments, so a per-text-node
    // walker cannot be matched against them.
    const extracted = globalThis.__pdf_extractTextRuns(doc);
    const bx = box(), cw = colWidth();

    // Repeated table sections are FURNITURE, not flow. Leaving them in the flow
    // run list double-counts them: the layer already emits them per page.
    const furnitureEls = withFurniture
      ? furniture.tables.flatMap((t) => [t.head, t.foot]).filter(Boolean)
      : [];
    const isFurniture = (el) => furnitureEls.some((f) => f.contains(el));

    const runs = extracted.runs
      .filter((r) => {
        const el = document.querySelector(r.selector) || null;
        return true;
      })
      .map((r) => ({
        text: r.text,
        col: Math.floor((r.rect.left - bx.left) / cw + 1e-3),
        furniture: false,
      }));

    // mark runs that fall inside furniture by matching their text
    const furnitureTexts = new Set(furnitureEls.flatMap((f) => {
      const out = [];
      const w2 = document.createTreeWalker(f, NodeFilter.SHOW_TEXT, null);
      let nn; while ((nn = w2.nextNode())) { const t = nn.data.trim(); if (t) out.push(t); }
      return out;
    }));
    for (const r of runs) if (furnitureTexts.has(r.text.trim())) r.furniture = true;

    const colCount = new Set(runs.map((r) => r.col)).size;
    const perPage = withFurniture ? F.emit(furniture, columnOf, colCount) : [];

    // furniture text that must be re-issued per page
    const emitted = [];
    perPage.forEach((items, p) => {
      for (const it of items) {
        emitted.push({ page: p, kind: it.kind, texts: it.texts || [] });
      }
    });

    if (withFurniture) { F.clearSpacers(); restore(); }

    return {
      runs, colCount, reservation, translated,
      furniture: { fixed: furniture.fixed.length, tables: furniture.tables.length },
      spacers: reservation.spacers,
      emitted,
    };
  }, CONTENT_H, CONTENT_W, useFurniture);

  await page.close();

  // ---- score page assignment -------------------------------------------
  let cursor = 0, matched = 0, ok = 0;
  const miss = [];
  for (const r of result.runs) {
    if (r.furniture) continue;          // handled by the furniture layer
    const want = dense(r.text);
    if (!want) continue;
    let found = -1;
    for (let i = cursor; i < truth.items.length; i++) {
      if (dense(truth.items[i].str) === want) { found = i; break; }
    }
    if (found === -1) continue;
    cursor = found + 1;
    matched++;
    if (truth.items[found].page === r.col) ok++;
    else miss.push(`${JSON.stringify(r.text.slice(0, 24))} ours=col${r.col} truth=page${truth.items[found].page}`);
  }

  // ---- content Chromium emits that we do not --------------------------
  // Content: furniture runs DO count -- a repeated section's first occurrence
  // is genuine flow content. Only its page ASSIGNMENT is meaningless.
  const oursCounts = new Map();
  for (const r of result.runs) {
    const d = dense(r.text);
    oursCounts.set(d, (oursCounts.get(d) || 0) + 1);
  }
  for (const e of result.emitted) {
    for (const piece of e.texts) {
      const d = dense(piece);
      if (d) oursCounts.set(d, (oursCounts.get(d) || 0) + 1);
    }
  }
  const truthCounts = new Map();
  for (const t of truth.items) {
    const d = dense(t.str);
    if (d) truthCounts.set(d, (truthCounts.get(d) || 0) + 1);
  }
  let missing = 0;
  for (const [d, n] of truthCounts) {
    const have = oursCounts.get(d) || 0;
    if (n > have) missing += n - have;
  }

  if (process.env.DEBUG_FURNITURE && useFurniture && miss.length) {
    console.log(`\n   [misassigned ${name}]`);
    for (const m of miss) console.log('     ' + m);
  }
  if (false && process.env.DEBUG_FURNITURE && useFurniture) {
    console.log(`\n   [debug ${name}] emitted:`, JSON.stringify(result.emitted));
    const need = [];
    for (const [d, n] of truthCounts) {
      const have = oursCounts.get(d) || 0;
      if (n > have) need.push(`${JSON.stringify(d)} truth=${n} ours=${have}`);
    }
    console.log(`   [debug ${name}] missing:`, need.join(' | '));
  }

  return {
    name, pages: truth.pages, cols: result.colCount,
    matched, ok, pct: matched ? (100 * ok) / matched : 0,
    missing, reservation: result.reservation, furniture: result.furniture,
    spacers: result.spacers,
    emitted: result.emitted.length,
  };
}

async function main() {
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({ headless: true });

  const probes = ['table-header-group', 'table-footer-group', 'position-fixed', 'control-plain-flow'];

  console.log(`page ${PAGE.wMm}x${PAGE.hMm}mm, content ${CONTENT_W.toFixed(2)} x ${CONTENT_H.toFixed(2)} px\n`);
  console.log('probe'.padEnd(20), 'furniture'.padEnd(10), 'pages/cols'.padStart(11),
    'page assign'.padStart(12), 'missing'.padStart(8), 'passes'.padStart(7), 'spacers'.padStart(8), 'emitted'.padStart(8));

  for (const p of probes) {
    for (const withF of [false, true]) {
      const r = await runProbe(browser, base, p, withF);
      console.log(
        (withF ? '' : r.name).padEnd(20),
        (withF ? 'ON' : 'off').padEnd(10),
        `${r.pages}/${r.cols}`.padStart(11),
        `${r.ok}/${r.matched} (${r.pct.toFixed(0)}%)`.padStart(12),
        String(r.missing).padStart(8),
        String(r.reservation.passes).padStart(7),
        String(r.spacers ?? 0).padStart(8),
        String(r.emitted).padStart(8),
      );
    }
  }

  await browser.close();
  server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
