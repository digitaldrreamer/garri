/**
 * Gate 3 (part 2) — Box decoration.
 *
 * Paint order is settled (gate3-paint-order.js). This asks the other half:
 * given the order, can the boxes themselves be reproduced — backgrounds,
 * uniform borders, per-corner radii, opacity and transforms — from computed
 * style and geometry alone?
 *
 * Rendered with pdf-lib, then rasterised and pixel-diffed against Chromium.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PDFDocument, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix } from 'pdf-lib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PT = 72 / 96;
const MIME = { '.html': 'text/html', '.ttf': 'font/ttf', '.js': 'text/javascript' };
// Chromium's own page box, read from its PDF. The nominal A4 in points
// (595.276 x 841.89) is NOT what it emits -- the page size carries its own
// rounding, separate from the margin rounding.
let A4 = { w: 595.276, h: 841.89 };
const MARGIN_PX = Math.round((10 / 25.4) * 96);   // @page margin 10mm -> whole px

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

/** SVG path for a rounded rectangle with per-corner (rx, ry), y increasing down. */
function roundedRectPath(w, h, radii, inset = 0, reverse = false) {
  // CSS does not clamp each corner to half its side. It computes one scale
  // factor f across the whole box -- the tightest ratio of any side's length to
  // the sum of the two radii on it -- and scales every radius by it.
  const ratio = (side, sum) => (sum <= 0 ? Infinity : side / sum);
  const f = Math.min(1,
    ratio(w, radii.tl[0] + radii.tr[0]),
    ratio(h, radii.tr[1] + radii.br[1]),
    ratio(w, radii.br[0] + radii.bl[0]),
    ratio(h, radii.tl[1] + radii.bl[1]));
  const R = (c) => [radii[c][0] * f, radii[c][1] * f];
  const shrink = (r) => [Math.max(0, r[0] - inset), Math.max(0, r[1] - inset)];

  const x0 = inset, y0 = inset, x1 = w - inset, y1 = h - inset;
  const tl = shrink(R('tl'));
  const tr = shrink(R('tr'));
  const br = shrink(R('br'));
  const bl = shrink(R('bl'));
  if (!reverse) {
    return [
      `M ${x0 + tl[0]} ${y0}`,
      `L ${x1 - tr[0]} ${y0}`,
      tr[0] || tr[1] ? `A ${tr[0]} ${tr[1]} 0 0 1 ${x1} ${y0 + tr[1]}` : '',
      `L ${x1} ${y1 - br[1]}`,
      br[0] || br[1] ? `A ${br[0]} ${br[1]} 0 0 1 ${x1 - br[0]} ${y1}` : '',
      `L ${x0 + bl[0]} ${y1}`,
      bl[0] || bl[1] ? `A ${bl[0]} ${bl[1]} 0 0 1 ${x0} ${y1 - bl[1]}` : '',
      `L ${x0} ${y0 + tl[1]}`,
      tl[0] || tl[1] ? `A ${tl[0]} ${tl[1]} 0 0 1 ${x0 + tl[0]} ${y0}` : '',
      'Z',
    ].filter(Boolean).join(' ');
  }
  // Counter-clockwise, so nonzero winding cuts a hole when this subpath follows
  // an outer clockwise one -- which is how CSS paints a border band.
  return [
    `M ${x0 + tl[0]} ${y0}`,
    tl[0] || tl[1] ? `A ${tl[0]} ${tl[1]} 0 0 0 ${x0} ${y0 + tl[1]}` : '',
    `L ${x0} ${y1 - bl[1]}`,
    bl[0] || bl[1] ? `A ${bl[0]} ${bl[1]} 0 0 0 ${x0 + bl[0]} ${y1}` : '',
    `L ${x1 - br[0]} ${y1}`,
    br[0] || br[1] ? `A ${br[0]} ${br[1]} 0 0 0 ${x1} ${y1 - br[1]}` : '',
    `L ${x1} ${y0 + tr[1]}`,
    tr[0] || tr[1] ? `A ${tr[0]} ${tr[1]} 0 0 0 ${x1 - tr[0]} ${y0}` : '',
    'Z',
  ].filter(Boolean).join(' ');
}

const col = (c) => rgb(c.r / 255, c.g / 255, c.b / 255);

async function main() {
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1400 });
  await page.goto(`${base}/fixtures/gate3-boxes.html`, { waitUntil: 'networkidle0' });

  const chromiumPdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });

  await page.addScriptTag({ url: `${base}/src/capture/paintOrder.js` });
  await page.addScriptTag({ url: `${base}/src/capture/boxes.js` });
  const boxes = await page.evaluate(() => globalThis.__pdf_extractBoxes(document.body));
  await browser.close();
  server.close();

  // Adopt Chromium's page box so the raster diff isolates box rendering
  // rather than a page-size mismatch.
  {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const d = await pdfjs.getDocument({ data: chromiumPdf.slice(), useSystemFonts: false }).promise;
    const vp = (await d.getPage(1)).getViewport({ scale: 1 });
    A4 = { w: vp.width, h: vp.height };
    console.log(`Chromium page box: ${A4.w.toFixed(3)} x ${A4.h.toFixed(3)} pt\n`);
  }

  // ---- render ----------------------------------------------------------
  const doc = await PDFDocument.create();
  const pg = doc.addPage([A4.w, A4.h]);

  for (const b of boxes) {
    const { box } = b;
    const xPt = (MARGIN_PX + box.x) * PT;
    const yPt = A4.h - (MARGIN_PX + box.y) * PT;      // top edge, PDF space
    const wPt = box.w * PT;
    const hPt = box.h * PT;

    const opts = {};
    if (b.opacity < 1) { opts.opacity = b.opacity; opts.borderOpacity = b.opacity; }

    if (b.transform) {
      const m = b.transform;
      // Apply the browser's matrix about the same origin, in PDF space.
      // PDF y grows upward, so b and c flip sign.
      const ox = xPt + (box.originX ?? box.w / 2) * PT;
      const oy = yPt - (box.originY ?? box.h / 2) * PT;
      pg.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(1, 0, 0, 1, ox, oy),
        concatTransformationMatrix(m.a, -m.b, -m.c, m.d, 0, 0),
        concatTransformationMatrix(1, 0, 0, 1, -ox, -oy),
      );
    }

    const hasRadius = Object.values(b.radii).some(([a, c]) => a > 0 || c > 0);

    if (b.background) {
      if (hasRadius) {
        pg.drawSvgPath(roundedRectPath(box.w, box.h, b.radii), {
          x: xPt, y: yPt, scale: PT, color: col(b.background), borderWidth: 0, ...opts,
        });
      } else {
        pg.drawRectangle({
          x: xPt, y: yPt - hPt, width: wPt, height: hPt, color: col(b.background), ...opts,
        });
      }
    }

    if (b.border && b.border.color) {
      // CSS paints a border as a filled band between the border box and the
      // padding box, not as a stroked centreline: outer path plus a reversed
      // inner path, filled.
      const ring = roundedRectPath(box.w, box.h, b.radii) + ' ' +
                   roundedRectPath(box.w, box.h, b.radii, b.border.width, true);
      pg.drawSvgPath(ring, {
        x: xPt, y: yPt, scale: PT,
        color: col(b.border.color), borderWidth: 0, ...opts,
      });
    }

    if (b.transform) pg.pushOperators(popGraphicsState());
  }

  const ourBytes = await doc.save();
  fs.writeFileSync(path.join(ROOT, 'out', 'gate3-boxes-ours.pdf'), ourBytes);
  fs.writeFileSync(path.join(ROOT, 'out', 'gate3-boxes-chromium.pdf'), chromiumPdf);

  console.log('=== EXTRACTED ===');
  console.log('id'.padEnd(13), 'x'.padStart(7), 'y'.padStart(7), 'w'.padStart(7), 'h'.padStart(7),
    'bg'.padStart(6), 'border'.padStart(7), 'radius'.padStart(7), 'op'.padStart(5), ' xform');
  for (const b of boxes) {
    console.log(
      b.id.padEnd(13),
      b.box.x.toFixed(1).padStart(7), b.box.y.toFixed(1).padStart(7),
      b.box.w.toFixed(1).padStart(7), b.box.h.toFixed(1).padStart(7),
      (b.background ? 'yes' : '-').padStart(6),
      (b.border ? b.border.width + 'px' : '-').padStart(7),
      (Object.values(b.radii).some(([a, c]) => a || c) ? 'yes' : '-').padStart(7),
      String(b.opacity).padStart(5),
      ' ' + (b.transform ? 'yes' : '-'),
    );
  }
  console.log(`\nwrote out/gate3-boxes-ours.pdf (${(ourBytes.byteLength / 1024).toFixed(1)} KB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
