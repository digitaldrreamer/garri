/**
 * Validate the object-fit implementation against Chromium's own image
 * placement, by reading the CTM in force at each image-paint operator.
 *
 * A PDF image occupies the unit square transformed by the current matrix, so
 * the matrix IS the placement -- a direct check of the fit maths, independent
 * of rasterisation and unaffected by the CSS borders in the fixture.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const mul = (m, n) => ({
  a: m.a * n.a + m.c * n.b,       b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d,       d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f,
});

async function placements(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { OPS } = pdfjs;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)) }).promise;
  const list = await (await doc.getPage(1)).getOperatorList();

  let ctm = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const stack = [];
  const out = [];
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i], args = list.argsArray[i];
    if (fn === OPS.save) stack.push({ ...ctm });
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) {
      const [a, b, c, d, e, f] = args;
      ctm = mul(ctm, { a, b, c, d, e, f });
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject ||
               fn === OPS.paintImageXObjectRepeat) {
      // unit square -> placed rect
      const xs = [ctm.e, ctm.e + ctm.a, ctm.e + ctm.c, ctm.e + ctm.a + ctm.c];
      const ys = [ctm.f, ctm.f + ctm.b, ctm.f + ctm.d, ctm.f + ctm.b + ctm.d];
      out.push({
        x: Math.min(...xs), y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
        rotated: Math.abs(ctm.b) > 1e-6 || Math.abs(ctm.c) > 1e-6,
      });
    }
  }
  return out;
}

const LABELS = ['fill', 'contain', 'cover', 'none', 'scale-down', 'cover+position',
  'natural', 'jpeg', 'webp', 'rounded', 'rotated', 'in-link'];

const ours = await placements(path.join(ROOT, 'out', 'imglink-ours.pdf'));
const theirs = await placements(path.join(ROOT, 'out', 'imglink-chromium.pdf'));

console.log(`images painted: ours=${ours.length} chromium=${theirs.length}\n`);
console.log('case'.padEnd(15), 'Δx'.padStart(8), 'Δy'.padStart(8), 'Δw'.padStart(8), 'Δh'.padStart(8), '  rot');
const errs = [];
for (let i = 0; i < Math.min(ours.length, theirs.length); i++) {
  const a = ours[i], b = theirs[i];
  const d = [a.x - b.x, a.y - b.y, a.w - b.w, a.h - b.h];
  errs.push(...d.map(Math.abs));
  console.log((LABELS[i] ?? `#${i}`).padEnd(15),
    ...d.map((v) => v.toFixed(3).padStart(8)),
    `  ${a.rotated === b.rotated ? 'ok' : 'MISMATCH'}`);
}
console.log(`\nmax |error| across all placements: ${Math.max(...errs).toFixed(4)} pt`);
