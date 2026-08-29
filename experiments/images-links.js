/**
 * Images and link annotations — completing Gate 5.
 *
 * Two goals from the plan:
 *   §20  embed the ORIGINAL encoded bytes as native image resources rather than
 *        re-rasterising, so a JPEG stays a JPEG.
 *   §2   turn <a href> into real PDF link annotations, including links that
 *        wrap across lines and links wrapping images.
 *
 * Everything runs in the browser; Node drives and verifies.
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
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page]', m.text()); });
  await page.setViewport({ width: 1200, height: 1600 });
  await page.goto(`${base}/fixtures/images-links.html`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);

  const chromiumPdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  fs.writeFileSync(path.join(ROOT, 'out', 'imglink-chromium.pdf'), chromiumPdf);

  await page.addScriptTag({ url: `${base}/node_modules/pdf-lib/dist/pdf-lib.min.js` });
  await page.addScriptTag({ url: `${base}/src/capture/images.js` });
  await page.addScriptTag({ url: `${base}/src/capture/links.js` });

  const result = await page.evaluate(async (pageBox) => {
    const { PDFDocument, PDFName, PDFString, PDFOperator,
            pushGraphicsState, popGraphicsState, concatTransformationMatrix } = PDFLib;
    const PT = 72 / 96;
    const MARGIN = Math.round((10 / 25.4) * 96);

    const images = globalThis.__pdf_extractImages(document.body);
    const links = globalThis.__pdf_extractLinks(document.body);

    const doc = await PDFDocument.create();
    const pg = doc.addPage([pageBox.w, pageBox.h]);
    const n = (v) => (Math.abs(v) < 1e-6 ? '0' : String(+v.toFixed(4)));
    const raw = (str) => pg.pushOperators(PDFOperator.of(str, []));

    const diagnostics = [];
    const gsCache = new Map();
    function alphaState(a) {
      const key = a.toFixed(3);
      if (!gsCache.has(key)) {
        const ref = doc.context.register(doc.context.obj({ Type: 'ExtGState', ca: a, CA: a }));
        const name = `GS${gsCache.size}`;
        pg.node.setExtGState(PDFName.of(name), ref);
        gsCache.set(key, name);
      }
      return gsCache.get(key);
    }

    /** Rounded rect as an explicit path, in PDF coords (y up). */
    function roundRectOps(x, y, w, h, r) {
      const K = 0.5523;
      const lim = (v, max) => Math.max(0, Math.min(v, max));
      const tl = lim(r.tl[0], w / 2), tr = lim(r.tr[0], w / 2);
      const brr = lim(r.br[0], w / 2), bl = lim(r.bl[0], w / 2);
      const tlv = lim(r.tl[1], h / 2), trv = lim(r.tr[1], h / 2);
      const brv = lim(r.br[1], h / 2), blv = lim(r.bl[1], h / 2);
      const X = x, Y = y, R = x + w, T = y + h;
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

    async function loadImage(src) {
      const buf = new Uint8Array(await (await fetch(src)).arrayBuffer());
      const isPng = buf[0] === 0x89 && buf[1] === 0x50;
      const isJpg = buf[0] === 0xFF && buf[1] === 0xD8;
      if (isPng) return { img: await doc.embedPng(buf), mode: 'PNG passthrough', bytes: buf.length };
      if (isJpg) return { img: await doc.embedJpg(buf), mode: 'JPEG passthrough', bytes: buf.length };

      // The backend cannot embed this container. Re-encode through the canvas,
      // which is lossless to PNG but loses the original compression.
      const el = new Image();
      el.crossOrigin = 'anonymous';
      el.src = src;
      await el.decode();
      const c = document.createElement('canvas');
      c.width = el.naturalWidth; c.height = el.naturalHeight;
      c.getContext('2d').drawImage(el, 0, 0);
      const b64 = c.toDataURL('image/png').split(',')[1];
      const bin = atob(b64);
      const re = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) re[i] = bin.charCodeAt(i);
      diagnostics.push({
        code: 'PDF_IMAGE_REENCODED', src: src.split('/').pop(),
        message: `Format not embeddable directly; re-encoded to PNG (${buf.length} -> ${re.length} bytes).`,
      });
      return { img: await doc.embedPng(re), mode: 're-encoded to PNG', bytes: re.length };
    }

    const drawn = [];
    for (const im of images) {
      const { img, mode, bytes } = await loadImage(im.src);

      pg.pushOperators(pushGraphicsState());

      if (im.transform) {
        const m = im.transform;
        const ox = (MARGIN + im.box.x + im.origin.x) * PT;
        const oy = pageBox.h - (MARGIN + im.box.y + im.origin.y) * PT;
        pg.pushOperators(
          concatTransformationMatrix(1, 0, 0, 1, ox, oy),
          concatTransformationMatrix(m.a, -m.b, -m.c, m.d, 0, 0),
          concatTransformationMatrix(1, 0, 0, 1, -ox, -oy),
        );
      }

      const hasRadius = Object.values(im.radii).some(([a, b]) => a > 0 || b > 0);
      if (im.needsClip || hasRadius) {
        const cx = (MARGIN + im.content.x) * PT;
        const cyBottom = pageBox.h - (MARGIN + im.content.y + im.content.h) * PT;
        const cw = im.content.w * PT, chh = im.content.h * PT;
        if (hasRadius) {
          const r = {
            tl: im.radii.tl.map((v) => v * PT), tr: im.radii.tr.map((v) => v * PT),
            br: im.radii.br.map((v) => v * PT), bl: im.radii.bl.map((v) => v * PT),
          };
          for (const op of roundRectOps(cx, cyBottom, cw, chh, r)) raw(op);
          raw('W n');
        } else {
          raw(`${n(cx)} ${n(cyBottom)} ${n(cw)} ${n(chh)} re W n`);
        }
      }

      if (im.opacity < 1) raw(`/${alphaState(im.opacity)} gs`);

      const ix = (MARGIN + im.content.x + im.dest.dx) * PT;
      const iyBottom = pageBox.h - (MARGIN + im.content.y + im.dest.dy + im.dest.dh) * PT;
      pg.drawImage(img, {
        x: ix, y: iyBottom, width: im.dest.dw * PT, height: im.dest.dh * PT,
      });

      pg.pushOperators(popGraphicsState());
      drawn.push({ id: im.id, fit: im.fit, mode, bytes, clipped: im.needsClip || hasRadius });
    }

    // ---- link annotations -------------------------------------------------
    const annots = [];
    for (const ln of links) {
      for (const r of ln.rects) {
        const x1 = (MARGIN + r.x) * PT;
        const y2 = pageBox.h - (MARGIN + r.y) * PT;
        const x2 = (MARGIN + r.x + r.w) * PT;
        const y1 = pageBox.h - (MARGIN + r.y + r.h) * PT;
        annots.push(doc.context.register(doc.context.obj({
          Type: 'Annot', Subtype: 'Link',
          Rect: [x1, y1, x2, y2],
          Border: [0, 0, 0],
          F: 4,
          A: { Type: 'Action', S: 'URI', URI: PDFString.of(ln.href) },
        })));
      }
    }
    if (annots.length) pg.node.set(PDFName.of('Annots'), doc.context.obj(annots));

    const bytes = await doc.save();
    return {
      bytes: Array.from(bytes), drawn, diagnostics,
      links: links.map((l) => ({ id: l.id, href: l.href, rects: l.rects.length, text: l.text })),
      annotCount: annots.length,
    };
  }, { w: 594.96, h: 841.92 });

  await browser.close();
  server.close();

  const bytes = Uint8Array.from(result.bytes);
  fs.writeFileSync(path.join(ROOT, 'out', 'imglink-ours.pdf'), bytes);

  console.log('=== IMAGES ===');
  console.log('id'.padEnd(11), 'object-fit'.padEnd(12), 'embed'.padEnd(20), 'bytes'.padStart(7), '  clipped');
  for (const d of result.drawn) {
    console.log(d.id.padEnd(11), d.fit.padEnd(12), d.mode.padEnd(20),
      String(d.bytes).padStart(7), '  ' + d.clipped);
  }

  console.log('\n=== DIAGNOSTICS ===');
  if (!result.diagnostics.length) console.log('  (none)');
  for (const d of result.diagnostics) console.log(`  ${d.code}  ${d.src}\n    ${d.message}`);

  console.log('\n=== LINKS ===');
  for (const l of result.links) {
    console.log(`  ${l.id.padEnd(11)} rects=${l.rects}  ${l.href}`);
    console.log(`    text: ${JSON.stringify(l.text)}`);
  }
  console.log(`\n  annotations written: ${result.annotCount}`);
  console.log(`  PDF size: ${(bytes.byteLength / 1024).toFixed(1)} KB ` +
    `(Chromium ${(chromiumPdf.byteLength / 1024).toFixed(1)} KB)`);

  // ---- verify the annotations survive a real PDF reader -------------------
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  for (const [name, data] of [['ours', bytes], ['chromium', chromiumPdf]]) {
    const doc = await pdfjs.getDocument({ data: data.slice(), useSystemFonts: false }).promise;
    const anns = await (await doc.getPage(1)).getAnnotations();
    const urls = anns.filter((a) => a.subtype === 'Link').map((a) => a.url || a.unsafeUrl);
    console.log(`\n  ${name}: ${urls.length} link annotations`);
    for (const u of [...new Set(urls)]) console.log(`    ${u}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
