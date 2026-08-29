/**
 * Derive Chromium's dashed/dotted border rule from its own output.
 *
 * Chromium emits no PDF dash operator at all — each dash is a separate filled
 * rectangle. So the pattern can be read straight out of the geometry, which is
 * exact, rather than measured off a raster.
 *
 * The question the fixture asks: does the dash pattern depend only on
 * border-width, or is it stretched to fit the side length?
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PT = 72 / 96;
const MARGIN = 38;

const mul = (m, o) => ({
  a: m.a * o.a + m.c * o.b, b: m.b * o.a + m.d * o.b,
  c: m.a * o.c + m.c * o.d, d: m.b * o.c + m.d * o.d,
  e: m.a * o.e + m.c * o.f + m.e, f: m.b * o.e + m.d * o.f + m.f,
});
const apply = (m, x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });

/**
 * Split into SUBPATHS. One constructPath carries many of them -- Chromium puts
 * every dash of a side in a single path object, so collapsing them into one
 * bounding box reports the whole border as a single 300px rectangle.
 */
function decode(coords) {
  const subs = [];
  let cur = null;
  let i = 0;
  while (i < coords.length) {
    const cmd = coords[i];
    if (cmd === 0) { cur = [[coords[i + 1], coords[i + 2]]]; subs.push(cur); i += 3; }
    else if (cmd === 1) { if (cur) cur.push([coords[i + 1], coords[i + 2]]); i += 3; }
    else if (cmd === 2 || cmd === 3) { if (cur) cur.push([coords[i + 5], coords[i + 6]]); i += 7; }
    else i += 1;                                   // closePath and friends
  }
  return subs.filter((s) => s.length > 1);
}

/** Element geometry, so rows are MATCHED to elements rather than assumed. */
async function elementRows() {
  const MIME = { '.html': 'text/html', '.ttf': 'font/ttf', '.js': 'text/javascript' };
  const srv = http.createServer((req, res) => {
    const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1600 });
  await page.goto(`http://127.0.0.1:${srv.address().port}/fixtures/dashed-borders.html`, { waitUntil: 'networkidle0' });
  const rows = await page.evaluate(() => [...document.querySelectorAll('.d,.t')].map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { id: el.id, y: r.top, side: r.width, bw: parseFloat(cs.borderTopWidth), style: cs.borderTopStyle };
  }));
  await browser.close(); srv.close();
  return rows;
}

async function main() {
  const elements = await elementRows();
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { OPS } = pdfjs;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(path.join(ROOT, 'out', process.argv[2] || 'dashed-chromium.pdf'))),
  }).promise;
  const pg = await doc.getPage(1);
  const H = pg.getViewport({ scale: 1 }).height;
  const list = await pg.getOperatorList();

  let ctm = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const stack = [];
  const rects = [];

  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i], args = list.argsArray[i];
    if (fn === OPS.save) stack.push({ ...ctm });
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) {
      ctm = mul(ctm, { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] });
    } else if (fn === OPS.constructPath) {
      const co = Array.from(args[1][0] || args[1]);
      for (const sub of decode(co)) {
        const pts = sub.map(([x, y]) => apply(ctm, x, y));
        const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
        const x0 = Math.min(...xs), x1 = Math.max(...xs);
        const y0 = Math.min(...ys), y1 = Math.max(...ys);
        rects.push({
          x: x0 / PT - MARGIN, w: (x1 - x0) / PT,
          y: (H - y1) / PT - MARGIN, h: (y1 - y0) / PT,
        });
      }
    }
  }

  console.log(`total paths decoded: ${rects.length}`);
  const byY = new Map();
  for (const r of rects) {
    const k = Math.round(r.y);
    if (!byY.has(k)) byY.set(k, []);
    byY.get(k).push(r);
  }
  console.log('paths grouped by rounded y (first 20):');
  for (const [k, v] of [...byY.entries()].sort((a, b) => a[0] - b[0]).slice(0, 20)) {
    const ws = v.map((r) => +r.w.toFixed(2));
    console.log(`   y=${String(k).padStart(5)}  n=${String(v.length).padStart(3)}  h=${v[0].h.toFixed(2)}  widths=${ws.slice(0, 6).join(',')}${ws.length > 6 ? '…' : ''}`);
  }

  // Dashes: short, wide-ish, and well inside the page.
  const dashes = rects.filter((r) => r.w > 0.2 && r.w < 200 && r.h > 0.2 && r.h < 20 && r.y >= 0);
  console.log('ALL rects with y in [-3,6]:');
  for (const r of rects.filter(r=>r.y>-3&&r.y<6)) console.log('   x=%s y=%s w=%s h=%s', r.x.toFixed(2), r.y.toFixed(2), r.w.toFixed(2), r.h.toFixed(2));
  console.log(`dash candidates: ${dashes.length}`);

  // group into rows by y
  const rows = [];
  for (const d of dashes.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r.y - d.y) < 1.5 && Math.abs(r.h - d.h) < 0.6);
    if (row) row.items.push(d);
    else rows.push({ y: d.y, h: d.h, items: [d] });
  }

  console.log(`=== DASH GEOMETRY: ${process.argv[2] || 'dashed-chromium.pdf'} ===`);
  console.log('id'.padEnd(6), 'style'.padEnd(7), 'bw'.padStart(3), 'side'.padStart(5), 'n'.padStart(3),
    'dash'.padStart(7), 'gap'.padStart(7), 'firstX'.padStart(7), 'y'.padStart(8), 'h'.padStart(6));

  for (const el of elements) {
    const row = rows.find((r) => Math.abs(r.y - el.y) < 2.0);
    if (!row) { console.log(el.id.padEnd(6), el.style.padEnd(7), String(el.bw).padStart(3), String(Math.round(el.side)).padStart(5), '  (no dashes found)'); continue; }
    const it = row.items.sort((a, b) => a.x - b.x);
    const dash = it.reduce((s2, d) => s2 + d.w, 0) / it.length;
    const n = it.length;
    // gap implied by an exact fit across the side
    const fitGap = n > 1 ? (el.side - n * dash) / (n - 1) : 0;
    const gaps = [];
    for (let i = 1; i < n; i++) gaps.push(it[i].x - (it[i - 1].x + it[i - 1].w));
    const measGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    console.log(
      el.id.padEnd(6), el.style.padEnd(7), String(el.bw).padStart(3),
      String(Math.round(el.side)).padStart(5), String(n).padStart(3),
      dash.toFixed(3).padStart(7), measGap.toFixed(3).padStart(7),
      it[0].x.toFixed(2).padStart(7), row.y.toFixed(2).padStart(8), row.h.toFixed(2).padStart(6),
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
