/**
 * The untested paint features: gradients, background images, clipping,
 * non-uniform borders — plus the ones that turn out to need raster fallback.
 *
 * Gradients become native PDF shadings (axial type 2 / radial type 3) rather
 * than rasterised strips, and clipping becomes real PDF clip paths, so the
 * output stays vector.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html', '.ttf': 'font/ttf', '.js': 'text/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
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
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page]', m.text()); });
  await page.setViewport({ width: 1200, height: 1600 });
  const fixture = process.argv[2] || 'paint-gaps';
  await page.goto(`${base}/fixtures/${fixture}.html`, { waitUntil: 'networkidle0' });

  const chromiumPdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  fs.writeFileSync(path.join(ROOT, 'out', `${fixture}-chromium.pdf`), chromiumPdf);

  await page.addScriptTag({ url: `${base}/node_modules/pdf-lib/dist/pdf-lib.min.js` });
  await page.addScriptTag({ url: `${base}/src/capture/paint.js` });

  const result = await page.evaluate(async (pageBox) => {
    const { PDFDocument, PDFName, PDFOperator,
            pushGraphicsState, popGraphicsState, concatTransformationMatrix } = PDFLib;
    const PT = 72 / 96;
    const MARGIN = Math.round((10 / 25.4) * 96);

    const { items, unsupported } = globalThis.__pdf_extractPaint(document.body);

    const doc = await PDFDocument.create();
    const pg = doc.addPage([pageBox.w, pageBox.h]);
    const n = (v) => (Math.abs(v) < 1e-6 ? '0' : String(+v.toFixed(4)));
    const raw = (s) => pg.pushOperators(PDFOperator.of(s, []));

    // page-space conversion for a point in viewport px
    const PX = (x) => (MARGIN + x) * PT;
    const PY = (y) => pageBox.h - (MARGIN + y) * PT;

    // ---- shading resources -------------------------------------------------
    let shCount = 0;
    function addShading(dict) {
      const res = pg.node.Resources();
      let shd = res.lookup(PDFName.of('Shading'));
      if (!shd) { shd = doc.context.obj({}); res.set(PDFName.of('Shading'), shd); }
      const name = `Sh${shCount++}`;
      shd.set(PDFName.of(name), doc.context.register(dict));
      return name;
    }

    const rgb01 = (c) => [c.r / 255, c.g / 255, c.b / 255];

    /** Colour stops -> a PDF function over [0,1]. */
    function stopsToFunction(stops) {
      const s = stops.map((x) => ({ ...x }));
      if (s[0].pos > 0) s.unshift({ ...s[0], pos: 0 });
      if (s[s.length - 1].pos < 1) s.push({ ...s[s.length - 1], pos: 1 });
      if (s.length === 2) {
        return doc.context.obj({
          FunctionType: 2, Domain: [0, 1],
          C0: rgb01(s[0].color), C1: rgb01(s[1].color), N: 1,
        });
      }
      const fns = [], bounds = [], encode = [];
      for (let i = 0; i < s.length - 1; i++) {
        fns.push(doc.context.obj({
          FunctionType: 2, Domain: [0, 1],
          C0: rgb01(s[i].color), C1: rgb01(s[i + 1].color), N: 1,
        }));
        encode.push(0, 1);
        if (i > 0) bounds.push(s[i].pos);
      }
      return doc.context.obj({
        FunctionType: 3, Domain: [0, 1], Functions: fns, Bounds: bounds, Encode: encode,
      });
    }

    // ---- path helpers ------------------------------------------------------
    function roundRectOps(x, y, w, h, r) {
      const K = 0.5523;
      const lim = (v, m) => Math.max(0, Math.min(v, m));
      const tl = lim(r.tl[0], w / 2), tr = lim(r.tr[0], w / 2);
      const brr = lim(r.br[0], w / 2), bl = lim(r.bl[0], w / 2);
      const tlv = lim(r.tl[1], h / 2), trv = lim(r.tr[1], h / 2);
      const brv = lim(r.br[1], h / 2), blv = lim(r.bl[1], h / 2);
      const X = x, Y = y, R = x + w, T = y + h;
      if (!tl && !tr && !brr && !bl) return [`${n(X)} ${n(Y)} ${n(w)} ${n(h)} re`];
      return [
        `${n(X + bl)} ${n(Y)} m`,
        `${n(R - brr)} ${n(Y)} l`,
        `${n(R - brr + brr * K)} ${n(Y)} ${n(R)} ${n(Y + brv - brv * K)} ${n(R)} ${n(Y + brv)} c`,
        `${n(R)} ${n(T - trv)} l`,
        `${n(R)} ${n(T - trv + trv * K)} ${n(R - tr + tr * K)} ${n(T)} ${n(R - tr)} ${n(T)} c`,
        `${n(X + tl)} ${n(T)} l`,
        `${n(X + tl - tl * K)} ${n(T)} ${n(X)} ${n(T - tlv + tlv * K)} ${n(X)} ${n(T - tlv)} c`,
        `${n(X)} ${n(Y + blv)} l`,
        `${n(X)} ${n(Y + blv - blv * K)} ${n(X + bl - bl * K)} ${n(Y)} ${n(X + bl)} ${n(Y)} c`,
        'h',
      ];
    }
    const boxOps = (b, radii) =>
      roundRectOps(PX(b.x), PY(b.y + b.h), b.w * PT, b.h * PT, {
        tl: radii.tl.map((v) => v * PT), tr: radii.tr.map((v) => v * PT),
        br: radii.br.map((v) => v * PT), bl: radii.bl.map((v) => v * PT),
      });

    function circleOps(cx, cy, r) {
      const K = 0.5523 * r;
      return [
        `${n(cx - r)} ${n(cy)} m`,
        `${n(cx - r)} ${n(cy + K)} ${n(cx - K)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c`,
        `${n(cx + K)} ${n(cy + r)} ${n(cx + r)} ${n(cy + K)} ${n(cx + r)} ${n(cy)} c`,
        `${n(cx + r)} ${n(cy - K)} ${n(cx + K)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c`,
        `${n(cx - K)} ${n(cy - r)} ${n(cx - r)} ${n(cy - K)} ${n(cx - r)} ${n(cy)} c`,
        'h',
      ];
    }

    const stats = { gradients: 0, bgImages: 0, clips: 0, borders: 0, shadings: 0, rasterFallbacks: 0, dashedSides: 0 };
    const unsupportedRuntime = [];

    // ---- raster fallback --------------------------------------------------
    // PDF has no shadow primitive, and Chromium's own export rasterises
    // box-shadow into an image. So matching Chromium here MEANS rasterising.
    // Rather than approximate the blur, use the browser's own shadow renderer
    // on a canvas -- the same principle as everywhere else in this design.
    function parseShadow(s) {
      const col = String(s).match(/rgba?\([^)]*\)/);
      const nums = String(s).replace(/rgba?\([^)]*\)/, '').trim().match(/-?[\d.]+px/g) || [];
      const v = nums.map(parseFloat);
      return {
        color: col ? col[0] : 'rgba(0,0,0,0.5)',
        dx: v[0] || 0, dy: v[1] || 0, blur: v[2] || 0, spread: v[3] || 0,
        inset: /inset/.test(s),
      };
    }

    async function shadowImage(it) {
      const sh = parseShadow(it.shadow);
      if (sh.inset) return null;                     // inset shadows not handled
      const bw = it.box.w, bh = it.box.h;
      const grow = sh.blur + Math.max(0, sh.spread);
      const left = Math.min(0, sh.dx - grow);
      const top = Math.min(0, sh.dy - grow);
      const right = Math.max(bw, bw + sh.dx + grow);
      const bottom = Math.max(bh, bh + sh.dy + grow);
      const cw = Math.ceil(right - left), chh = Math.ceil(bottom - top);
      if (cw <= 0 || chh <= 0) return null;

      const SCALE = 3;                                // resolution of the fallback
      const cv = document.createElement('canvas');
      cv.width = cw * SCALE; cv.height = chh * SCALE;
      const cx = cv.getContext('2d');
      cx.scale(SCALE, SCALE);

      const x0 = -left - sh.spread, y0 = -top - sh.spread;
      const w0 = bw + 2 * sh.spread, h0 = bh + 2 * sh.spread;
      const rr = Math.max(0, Math.min(it.radii.tl[0] + sh.spread, w0 / 2, h0 / 2));
      const shapePath = () => {
        cx.beginPath();
        if (cx.roundRect) cx.roundRect(x0, y0, w0, h0, rr);
        else cx.rect(x0, y0, w0, h0);
      };

      // Draw the shape WITH its shadow, then erase the shape itself. Keeping
      // everything on-canvas avoids the usual off-screen-offset trick, which
      // fails here because geometry placed outside the surface is culled
      // before the shadow is ever generated.
      // shadowBlur and shadowOffset are specified in DEVICE units and are not
      // affected by the canvas transform, so they must be scaled by hand.
      // Missing this silently shrinks the blur by the supersampling factor.
      cx.shadowColor = sh.color;
      cx.shadowBlur = sh.blur * SCALE;
      cx.shadowOffsetX = sh.dx * SCALE;
      cx.shadowOffsetY = sh.dy * SCALE;
      cx.fillStyle = '#000';
      shapePath();
      cx.fill();

      // CSS clips an outer shadow out from under its own box, so removing the
      // shape is correct rather than merely convenient.
      cx.shadowColor = 'transparent';
      cx.shadowBlur = 0; cx.shadowOffsetX = 0; cx.shadowOffsetY = 0;
      cx.globalCompositeOperation = 'destination-out';
      shapePath();
      cx.fill();
      cx.globalCompositeOperation = 'source-over';

      const b64 = cv.toDataURL('image/png').split(',')[1];
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { img: await doc.embedPng(bytes), left, top, w: cw, h: chh };
    }

    for (const it of items) {
      const b = it.box;
      pg.pushOperators(pushGraphicsState());

      // shadows paint beneath the element
      if (it.shadow) {
        const s = await shadowImage(it);
        if (s) {
          pg.drawImage(s.img, {
            x: PX(b.x + s.left), y: PY(b.y + s.top + s.h),
            width: s.w * PT, height: s.h * PT,
          });
          stats.rasterFallbacks++;
        }
      }

      // ancestor overflow clips, outermost first
      for (const ac of it.ancestorClips) {
        for (const op of boxOps(ac, ac.radii)) raw(op);
        raw('W n');
        stats.clips++;
      }

      // this element's own clip-path
      if (it.clip) {
        if (it.clip.kind === 'circle') {
          for (const op of circleOps(PX(b.x + it.clip.cx), PY(b.y + it.clip.cy), it.clip.r * PT)) raw(op);
        } else if (it.clip.kind === 'polygon') {
          it.clip.points.forEach((p, i) => {
            raw(`${n(PX(b.x + p.x))} ${n(PY(b.y + p.y))} ${i === 0 ? 'm' : 'l'}`);
          });
          raw('h');
        } else if (it.clip.kind === 'rect') {
          for (const op of boxOps({ x: b.x + it.clip.x, y: b.y + it.clip.y, w: it.clip.w, h: it.clip.h }, it.radii)) raw(op);
        }
        raw('W n');
        stats.clips++;
      }

      // background colour
      if (it.background) {
        raw(`${n(it.background.r / 255)} ${n(it.background.g / 255)} ${n(it.background.b / 255)} rg`);
        for (const op of boxOps(b, it.radii)) raw(op);
        raw('f');
      }

      // gradient -> native shading, painted through a clip of the box
      if (it.gradient && !it.gradient.alpha) {
        const g = it.gradient;
        const fn = stopsToFunction(g.stops);
        pg.pushOperators(pushGraphicsState());
        for (const op of boxOps(b, it.radii)) raw(op);
        raw('W n');

        if (g.kind === 'linear') {
          const name = addShading(doc.context.obj({
            ShadingType: 2, ColorSpace: 'DeviceRGB',
            Coords: [PX(b.x + g.line.x0), PY(b.y + g.line.y0), PX(b.x + g.line.x1), PY(b.y + g.line.y1)],
            Function: fn, Extend: [true, true],
          }));
          raw(`/${name} sh`);
        } else {
          // PDF radial shadings are circular; an ellipse needs a scale about
          // its centre so the same construct can express it.
          const cx = PX(b.x + g.cx), cy = PY(b.y + g.cy);
          const rx = g.rx * PT, ry = g.ry * PT;
          const ellipse = Math.abs(rx - ry) > 0.01;
          if (ellipse) {
            pg.pushOperators(
              concatTransformationMatrix(1, 0, 0, 1, cx, cy),
              concatTransformationMatrix(1, 0, 0, ry / rx, 0, 0),
              concatTransformationMatrix(1, 0, 0, 1, -cx, -cy),
            );
          }
          const name = addShading(doc.context.obj({
            ShadingType: 3, ColorSpace: 'DeviceRGB',
            Coords: [cx, cy, 0, cx, cy, rx],
            Function: fn, Extend: [true, true],
          }));
          raw(`/${name} sh`);
        }
        pg.pushOperators(popGraphicsState());
        stats.gradients++; stats.shadings++;
      }

      // background-image
      if (it.bgImage) {
        const bytes = new Uint8Array(await (await fetch(it.bgImage.src)).arrayBuffer());
        const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
        const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        const nw = img.width, nh = img.height;
        const cw = b.w, ch = b.h;

        let dw, dh;
        const size = it.bgImage.size;
        if (size === 'cover') { const s = Math.max(cw / nw, ch / nh); dw = nw * s; dh = nh * s; }
        else if (size === 'contain') { const s = Math.min(cw / nw, ch / nh); dw = nw * s; dh = nh * s; }
        else { dw = nw; dh = nh; }

        const [pxTok, pyTok] = String(it.bgImage.position).split(/\s+/);
        const rel = (t, free) => (String(t).endsWith('%') ? (parseFloat(t) / 100) * free : parseFloat(t) || 0);
        const dx = rel(pxTok ?? '0%', cw - dw);
        const dy = rel(pyTok ?? '0%', ch - dh);

        pg.pushOperators(pushGraphicsState());
        for (const op of boxOps(b, it.radii)) raw(op);
        raw('W n');
        pg.drawImage(img, {
          x: PX(b.x + dx), y: PY(b.y + dy + dh), width: dw * PT, height: dh * PT,
        });
        pg.pushOperators(popGraphicsState());
        stats.bgImages++;
      }

      // borders: each side is a mitred trapezoid, which handles the
      // non-uniform case that a single stroked rectangle cannot.
      if (it.borders) {
        const { widths: w, colors: c, styles: st } = it.borders;
        const X0 = PX(b.x), X1 = PX(b.x + b.w);
        const Y1 = PY(b.y), Y0 = PY(b.y + b.h);          // Y1 top, Y0 bottom
        const iX0 = PX(b.x + w.l), iX1 = PX(b.x + b.w - w.r);
        const iY1 = PY(b.y + w.t), iY0 = PY(b.y + b.h - w.b);
        const quad = (col, pts) => {
          if (!col || col.a === 0) return;
          raw(`${n(col.r / 255)} ${n(col.g / 255)} ${n(col.b / 255)} rg`);
          pts.forEach((p, i) => raw(`${n(p[0])} ${n(p[1])} ${i === 0 ? 'm' : 'l'}`));
          raw('h f');
        };
        // Dash geometry, derived from Chromium's own output:
        //   dashed  dash = 2*bw,  n = ceil(side / (3*bw))
        //   dotted  dot  = 1*bw,  n = ceil(side / (2*bw))
        //   gap = (side - n*dash) / (n - 1), so the run fits the side exactly.
        // Chrome special-cases bw <= 2, where this does not hold.
        function dashRun(col, bwPx, sidePx, style) {
          if (!col || col.a === 0 || bwPx <= 0 || sidePx <= 0) return null;
          let dash, period, n;
          if (style === 'dotted') {
            dash = bwPx;
            period = 2 * bwPx;
            // dots are fenceposts: n dots with n-1 gaps spanning the side
            n = Math.floor(sidePx / period) + 1;
          } else {
            // thin dashed borders use a longer dash and a sparser period
            const thin = bwPx <= 2;
            dash = (thin ? 3 : 2) * bwPx;
            period = (thin ? 5 : 3) * bwPx;
            n = Math.ceil(sidePx / period);
          }
          n = Math.max(2, n);
          const gap = (sidePx - n * dash) / (n - 1);
          if (gap < 0) return null;
          return { dash, gap, n };
        }
        const dashed = (style) => style === 'dashed' || style === 'dotted';

        function emitSide(side, col, bwPx, style) {
          if (!dashed(style)) return false;
          const horizontal = side === 't' || side === 'b';
          const sidePx = horizontal ? b.w : b.h;
          const run = dashRun(col, bwPx, sidePx, style);
          if (!run) return false;
          raw(`${n(col.r / 255)} ${n(col.g / 255)} ${n(col.b / 255)} rg`);
          for (let i = 0; i < run.n; i++) {
            const off = i * (run.dash + run.gap);
            let x, y, dw, dh;
            if (side === 't') { x = b.x + off; y = b.y; dw = run.dash; dh = bwPx; }
            else if (side === 'b') { x = b.x + off; y = b.y + b.h - bwPx; dw = run.dash; dh = bwPx; }
            else if (side === 'l') { x = b.x; y = b.y + off; dw = bwPx; dh = run.dash; }
            else { x = b.x + b.w - bwPx; y = b.y + off; dw = bwPx; dh = run.dash; }
            raw(`${n(PX(x))} ${n(PY(y + dh))} ${n(dw * PT)} ${n(dh * PT)} re f`);
          }
          stats.dashedSides++;
          return true;
        }

        if (w.t && !emitSide('t', c.t, w.t, st.t) && st.t === 'solid') quad(c.t, [[X0, Y1], [X1, Y1], [iX1, iY1], [iX0, iY1]]);
        if (w.b && !emitSide('b', c.b, w.b, st.b) && st.b === 'solid') quad(c.b, [[X0, Y0], [iX0, iY0], [iX1, iY0], [X1, Y0]]);
        if (w.l && !emitSide('l', c.l, w.l, st.l) && st.l === 'solid') quad(c.l, [[X0, Y1], [iX0, iY1], [iX0, iY0], [X0, Y0]]);
        if (w.r && !emitSide('r', c.r, w.r, st.r) && st.r === 'solid') quad(c.r, [[X1, Y1], [X1, Y0], [iX1, iY0], [iX1, iY1]]);
        stats.borders++;
      }

      pg.pushOperators(popGraphicsState());
    }

    const bytes = await doc.save();
    return { bytes: Array.from(bytes), stats, unsupported: [...unsupported, ...unsupportedRuntime], itemCount: items.length };
  }, { w: 594.96, h: 841.92 });

  await browser.close();
  server.close();

  const bytes = Uint8Array.from(result.bytes);
  fs.writeFileSync(path.join(ROOT, 'out', `${fixture}-ours.pdf`), bytes);

  console.log('=== EMITTED ===');
  console.log(`  items=${result.itemCount}`);
  for (const [k, v] of Object.entries(result.stats)) console.log(`  ${k.padEnd(12)} ${v}`);
  console.log(`  PDF ${(bytes.byteLength / 1024).toFixed(1)} KB  (Chromium ${(chromiumPdf.byteLength / 1024).toFixed(1)} KB)`);

  console.log('\n=== DECLARED UNSUPPORTED ===');
  const seen = new Set();
  for (const u of result.unsupported) {
    const k = `${u.id}:${u.feature}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`  ${String(u.id).padEnd(11)} ${u.feature.padEnd(28)} ${u.detail}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
