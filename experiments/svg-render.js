/**
 * SVG — native vector reproduction.
 *
 * Plan §19 wants SVG preserved as vectors, not rasterised. The hard part is not
 * the drawing primitives but SVG's coordinate resolution: viewBox,
 * preserveAspectRatio, nested transforms, units.
 *
 * We reimplement none of that. `getScreenCTM()` hands us the fully resolved
 * user-space -> viewport matrix, and the backend just concatenates it.
 *
 * Everything runs in the browser; Node drives and diffs.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
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

async function main() {
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page]', m.text()); });
  await page.setViewport({ width: 1200, height: 1400 });
  await page.goto(`${base}/fixtures/svg-basic.html`, { waitUntil: 'networkidle0' });

  const chromiumPdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  fs.writeFileSync(path.join(ROOT, 'out', 'svg-chromium.pdf'), chromiumPdf);

  await page.addScriptTag({ url: `${base}/node_modules/pdf-lib/dist/pdf-lib.min.js` });
  await page.addScriptTag({ url: `${base}/src/capture/svg.js` });
  await page.addScriptTag({ url: `${base}/src/pdf/svgPath.js` });

  const result = await page.evaluate(async (pageBox) => {
    const { PDFDocument, pushGraphicsState, popGraphicsState,
            concatTransformationMatrix, PDFOperator, PDFName } = PDFLib;
    const PT = 72 / 96;
    const MARGIN = Math.round((10 / 25.4) * 96);      // @page 10mm -> whole px

    const { shapes, unsupported } = globalThis.__pdf_extractSvg(document.body);
    const toOps = globalThis.__pdf_svgPathToOps;

    const compose = (m, o) => ({
      a: m.a * o.a + m.c * o.b, b: m.b * o.a + m.d * o.b,
      c: m.a * o.c + m.c * o.d, d: m.b * o.c + m.d * o.d,
      e: m.a * o.e + m.c * o.f + m.e, f: m.b * o.e + m.d * o.f + m.f,
    });

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
    function stopsToFunction(stops) {
      const st = stops.map((x) => ({ ...x })).sort((a, b) => a.pos - b.pos);
      if (st[0].pos > 0) st.unshift({ ...st[0], pos: 0 });
      if (st[st.length - 1].pos < 1) st.push({ ...st[st.length - 1], pos: 1 });
      if (st.length === 2) {
        return doc.context.obj({ FunctionType: 2, Domain: [0, 1],
          C0: rgb01(st[0].color), C1: rgb01(st[1].color), N: 1 });
      }
      const fns = [], bounds = [], encode = [];
      for (let i = 0; i < st.length - 1; i++) {
        fns.push(doc.context.obj({ FunctionType: 2, Domain: [0, 1],
          C0: rgb01(st[i].color), C1: rgb01(st[i + 1].color), N: 1 }));
        encode.push(0, 1);
        if (i > 0) bounds.push(st[i].pos);
      }
      return doc.context.obj({ FunctionType: 3, Domain: [0, 1],
        Functions: fns, Bounds: bounds, Encode: encode });
    }

    const doc = await PDFDocument.create();
    const pg = doc.addPage([pageBox.w, pageBox.h]);

    const n = (v) => (Math.abs(v) < 1e-6 ? '0' : String(+v.toFixed(4)));
    const raw = (str) => pg.pushOperators(PDFOperator.of(str, []));

    // Alpha needs a graphics-state resource; there is no inline operator.
    const gsCache = new Map();
    function alphaState(fillA, strokeA) {
      const key = `${fillA.toFixed(3)}/${strokeA.toFixed(3)}`;
      if (!gsCache.has(key)) {
        const ref = doc.context.register(doc.context.obj({
          Type: 'ExtGState', ca: fillA, CA: strokeA,
        }));
        const name = `GS${gsCache.size}`;
        pg.node.setExtGState(PDFName.of(name), ref);
        gsCache.set(key, name);
      }
      return gsCache.get(key);
    }

    let painted = 0, skipped = 0, evenodd = 0, clipped = 0, gradients = 0;
    for (const s of shapes) {
      // A shape we cannot clip must not be painted unclipped -- that paints
      // outside the region the author asked for, which is worse than omitting
      // it. A future raster fallback can preserve the clipped appearance.
      if (s.skip) { skipped++; continue; }

      const M = s.ctm;
      const P = { a: PT, b: 0, c: 0, d: -PT, e: MARGIN * PT, f: pageBox.h - MARGIN * PT };
      const T = {
        a: P.a * M.a + P.c * M.b,
        b: P.b * M.a + P.d * M.b,
        c: P.a * M.c + P.c * M.d,
        d: P.b * M.c + P.d * M.d,
        e: P.a * M.e + P.c * M.f + P.e,
        f: P.b * M.e + P.d * M.f + P.f,
      };

      pg.pushOperators(pushGraphicsState());

      // Clip to the SVG viewport, in page space, BEFORE the shape matrix.
      if (s.viewportClip) {
        const v = s.viewportClip;
        const cx = (MARGIN + v.x) * PT;
        const cy = pageBox.h - (MARGIN + v.y + v.h) * PT;
        raw(`${n(cx)} ${n(cy)} ${n(v.w * PT)} ${n(v.h * PT)} re W n`);
      }

      // <clipPath> children carry their own CTM, so each is applied in page
      // space and the matrix is then inverted -- q/Q would discard the clip
      // along with the transform.
      if (s.clip) {
        for (const cp of s.clip.paths) {
          if (!cp.ctm) continue;
          const C = compose(P, cp.ctm);
          const det = C.a * C.d - C.b * C.c;
          if (!det) continue;
          pg.pushOperators(concatTransformationMatrix(C.a, C.b, C.c, C.d, C.e, C.f));
          for (const op of toOps(cp.d)) raw(op);
          raw('W n');
          pg.pushOperators(concatTransformationMatrix(
            C.d / det, -C.b / det, -C.c / det, C.a / det,
            (C.c * C.f - C.d * C.e) / det, (C.b * C.e - C.a * C.f) / det,
          ));
        }
        clipped++;
      }

      pg.pushOperators(concatTransformationMatrix(T.a, T.b, T.c, T.d, T.e, T.f));

      const fA = (s.fill ? s.fillOpacity * (s.fill.a ?? 1) : 1) * s.opacity;
      const sA = (s.stroke ? s.strokeOpacity * (s.stroke.a ?? 1) : 1) * s.opacity;
      if (fA < 1 || sA < 1) raw(`/${alphaState(fA, sA)} gs`);

      if (s.fill) raw(`${n(s.fill.r / 255)} ${n(s.fill.g / 255)} ${n(s.fill.b / 255)} rg`);
      const doStroke = s.stroke && s.strokeWidth > 0;
      if (doStroke) {
        raw(`${n(s.stroke.r / 255)} ${n(s.stroke.g / 255)} ${n(s.stroke.b / 255)} RG`);
        raw(`${n(s.strokeWidth)} w`);
        raw(`${{ butt: 0, round: 1, square: 2 }[s.strokeLinecap] ?? 0} J`);
        raw(`${{ miter: 0, round: 1, bevel: 2 }[s.strokeLinejoin] ?? 0} j`);
        if (s.strokeMiterlimit) raw(`${n(s.strokeMiterlimit)} M`);
        if (s.strokeDasharray && s.strokeDasharray.length) {
          raw(`[${s.strokeDasharray.map(n).join(' ')}] ${n(s.strokeDashoffset)} d`);
        } else {
          raw('[] 0 d');
        }
      }

      for (const op of toOps(s.d)) raw(op);

      const eo = s.fillRule === 'evenodd';
      if (eo) evenodd++;

      if (s.gradient) {
        // Fill with a paint server: clip to the shape, paint the shading,
        // then re-emit the path for the stroke if there is one.
        raw(eo ? 'W* n' : 'W n');
        const g = s.gradient;
        const fn = stopsToFunction(g.stops);
        const name = addShading(g.kind === 'linear'
          ? doc.context.obj({ ShadingType: 2, ColorSpace: 'DeviceRGB',
              Coords: [g.x1, g.y1, g.x2, g.y2], Function: fn, Extend: [true, true] })
          : doc.context.obj({ ShadingType: 3, ColorSpace: 'DeviceRGB',
              Coords: [g.cx, g.cy, 0, g.cx, g.cy, g.r], Function: fn, Extend: [true, true] }));
        raw(`/${name} sh`);
        gradients++;
        if (doStroke) { for (const op of toOps(s.d)) raw(op); raw('S'); }
      } else if (s.fill && doStroke) raw(eo ? 'B*' : 'B');
      else if (s.fill) raw(eo ? 'f*' : 'f');
      else if (doStroke) raw('S');
      else raw('n');

      pg.pushOperators(popGraphicsState());
      painted++;
    }

    const bytes = await doc.save();
    return {
      bytes: Array.from(bytes),
      shapes: shapes.map((s) => ({ id: s.id, tag: s.tag, fill: !!s.fill, stroke: !!s.stroke,
        sw: s.strokeWidth, rule: s.fillRule, dash: !!s.strokeDasharray, op: s.opacity,
        skip: !!s.skip })),
      unsupported, evenodd, painted, skipped, clipped, gradients,
    };
  }, { w: 594.96, h: 841.92 });

  await browser.close();
  server.close();

  const bytes = Uint8Array.from(result.bytes);
  fs.writeFileSync(path.join(ROOT, 'out', 'svg-ours.pdf'), bytes);

  console.log('=== EXTRACTED ===');
  console.log('id'.padEnd(12), 'tag'.padEnd(9), 'fill'.padStart(5), 'stroke'.padStart(7),
    'width'.padStart(6), 'rule'.padStart(8), 'dash'.padStart(5), 'opacity'.padStart(8));
  for (const s of result.shapes) {
    console.log(s.id.padEnd(12), s.tag.padEnd(9), String(s.fill).padStart(5),
      String(s.stroke).padStart(7), String(s.sw).padStart(6), s.rule.padStart(8),
      String(s.dash).padStart(5), String(s.op).padStart(8));
  }
  console.log(`\nshapes=${result.shapes.length}  painted=${result.painted}  ` +
    `skipped=${result.skipped}  evenodd=${result.evenodd}  ` +
    `gradients=${result.gradients}  clipped=${result.clipped}  ` +
    `PDF=${(bytes.byteLength / 1024).toFixed(1)} KB`);

  console.log('\n=== DECLARED UNSUPPORTED (reported, not silently dropped) ===');
  if (!result.unsupported.length) console.log('  (none)');
  for (const u of result.unsupported) console.log(`  ${u.id.padEnd(12)} ${u.feature.padEnd(20)} ${u.detail}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
