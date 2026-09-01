/**
 * Paint-order test.
 *
 * Tests whether correct static painting order requires hidden
 * browser information that cannot reasonably be inferred from DOM/style state."
 *
 * A PDF content stream is already in paint order. So if every box carries a
 * unique fill colour, Chromium's own operator list *is* its painting sequence —
 * no renderer needed to test the ordering question.
 *
 * We recompute the order from computed style alone and compare the sequences.
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

/** Chromium's actual paint sequence, read from the PDF operator list. */
async function paintSequenceFromPdf(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { OPS } = pdfjs;
  const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
  const page = await doc.getPage(1);
  const list = await page.getOperatorList();

  const seq = [];
  let pending = null;
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i];
    if (fn === OPS.setFillRGBColor) {
      // pdf.js hands this a hex string ("#0a1e3c"), not RGB components.
      const hex = String(args[0]).replace('#', '');
      pending = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    } else if (fn === OPS.fill || fn === OPS.eoFill || fn === OPS.constructPath) {
      // a fill actually happened with the pending colour
      if (pending) {
        seq.push(pending);
        pending = null;
      }
    }
  }
  return seq;
}

const isPalette = (c) => c && c[1] === 30 && c[2] === 60;

async function main() {
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1400 });
  await page.goto(`${base}/fixtures/gate3-paint-order.html`, { waitUntil: 'networkidle0' });

  // Ground truth first.
  const pdfBytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  fs.writeFileSync(path.join(ROOT, 'out', 'gate3-chromium.pdf'), pdfBytes);

  await page.addScriptTag({ url: `${base}/src/capture/paintOrder.js` });
  const ours = await page.evaluate(() => {
    const order = globalThis.__pdf_paintOrder(document.body);
    const out = [];
    for (const el of order) {
      const cs = getComputedStyle(el);
      const m = cs.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) continue;
      const rgb = [+m[1], +m[2], +m[3]];
      if (rgb[1] !== 30 || rgb[2] !== 60) continue;   // palette signature
      out.push({ id: el.id || el.tagName.toLowerCase(), rgb });
    }
    return out;
  });

  await browser.close();
  server.close();

  const truth = (await paintSequenceFromPdf(pdfBytes)).filter(isPalette);

  // Map colours back to ids for a readable report.
  const idByRed = new Map(ours.map((o) => [o.rgb[0], o.id]));
  const truthIds = truth.map((c) => idByRed.get(c[0]) ?? `rgb(${c.join(',')})`);
  const ourIds = ours.map((o) => o.id);

  console.log('=== PAINT ORDER ===');
  console.log(`Chromium painted ${truthIds.length} palette boxes`);
  console.log(`we predicted     ${ourIds.length}\n`);

  console.log('  #   chromium        ours            ');
  const n = Math.max(truthIds.length, ourIds.length);
  let firstMismatch = -1;
  for (let i = 0; i < n; i++) {
    const t = truthIds[i] ?? '—';
    const o = ourIds[i] ?? '—';
    const ok = t === o;
    if (!ok && firstMismatch < 0) firstMismatch = i;
    console.log(
      String(i + 1).padStart(3),
      ' ', t.padEnd(15), o.padEnd(15), ok ? '' : '  <-- MISMATCH',
    );
  }

  const exact = truthIds.length === ourIds.length && firstMismatch === -1;
  console.log();
  console.log('=== RESULT ===');
  console.log(`sequences ${exact ? 'MATCH EXACTLY' : 'DIFFER (first at index ' + (firstMismatch + 1) + ')'}`);

  // Also report the interesting orderings explicitly.
  const posOf = (id, arr) => arr.indexOf(id);
  const checks = [
    ['negative z-index paints below its parent\'s content',
      posOf('neg', truthIds) < posOf('mid', truthIds), posOf('neg', ourIds) < posOf('mid', ourIds)],
    ['z-index 2 paints before z-index 5',
      posOf('pos2', truthIds) < posOf('pos5', truthIds), posOf('pos2', ourIds) < posOf('pos5', ourIds)],
    ['z-index:99 trapped inside an opacity stacking context',
      posOf('trapped', truthIds) < posOf('trans', truthIds), posOf('trapped', ourIds) < posOf('trans', ourIds)],
    ['in-flow block paints before an EARLIER positioned sibling',
      posOf('laterflow', truthIds) < posOf('posauto', truthIds), posOf('laterflow', ourIds) < posOf('posauto', ourIds)],
  ];
  console.log();
  console.log('=== ORDERING RULES ===');
  for (const [label, t, o] of checks) {
    console.log(`  ${t === o ? 'agree  ' : 'DIFFER '} chromium=${String(t).padEnd(5)} ours=${String(o).padEnd(5)}  ${label}`);
  }

  fs.writeFileSync(path.join(ROOT, 'out', 'gate3-paint-order.json'),
    JSON.stringify({ truthIds, ourIds }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
