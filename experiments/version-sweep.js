/**
 * Version sweep.
 *
 * The documentary pass (docs/evidence-classes.md) moved most findings to
 * spec- or source-confirmed, where platform is settled by construction. What it
 * could NOT settle is Blink *behaviour* that isn't a constant: the A4 page box
 * rounding, the dashed-border dash/gap rule, and list-marker placement. Those
 * are class `U` and the honest test for them is a version sweep, not a platform
 * matrix.
 *
 * Two controls ride along deliberately. If `baseline = top + ascent` or the
 * 1/64 LayoutUnit quantisation ever moved, the source-level reasoning in the
 * documentary pass would be wrong, and this is where that would show up.
 *
 *   node experiments/version-sweep.js
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PT = 72 / 96;
const MARGIN_MM = 20;
const MARGIN_PX = Math.round((MARGIN_MM / 25.4) * 96);
const MIME = { '.html': 'text/html', '.ttf': 'font/ttf', '.js': 'text/javascript' };

const mul = (m, o) => ({
  a: m.a * o.a + m.c * o.b, b: m.b * o.a + m.d * o.b,
  c: m.a * o.c + m.c * o.d, d: m.b * o.c + m.d * o.d,
  e: m.a * o.e + m.c * o.f + m.e, f: m.b * o.e + m.d * o.f + m.f,
});
const apply = (m, x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });

function decode(coords) {
  const subs = [];
  let cur = null, i = 0;
  while (i < coords.length) {
    const cmd = coords[i];
    if (cmd === 0) { cur = [[coords[i + 1], coords[i + 2]]]; subs.push(cur); i += 3; }
    else if (cmd === 1) { if (cur) cur.push([coords[i + 1], coords[i + 2]]); i += 3; }
    else if (cmd === 2 || cmd === 3) { if (cur) cur.push([coords[i + 5], coords[i + 6]]); i += 7; }
    else i += 1;
  }
  return subs.filter((s) => s.length > 1);
}

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

/** Every Chrome for Testing build puppeteer has cached, newest last. */
function installedBrowsers() {
  const dir = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((d) => d.startsWith('mac_arm-') || d.startsWith('mac-'))
    .map((d) => {
      const version = d.replace(/^mac(_arm)?-/, '');
      const exe = path.join(dir, d, 'chrome-mac-arm64',
        'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      return { version, major: parseInt(version, 10), exe };
    })
    .filter((b) => fs.existsSync(b.exe))
    .sort((a, z) => a.major - z.major);
}

/** pdf.js operator-list walk: every filled subpath as a page-space rect. */
async function pdfRects(pdfjs, bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const pg = await doc.getPage(1);
  const H = pg.getViewport({ scale: 1 }).height;
  const list = await pg.getOperatorList();
  const { OPS } = pdfjs;
  let ctm = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const stack = [], rects = [];
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
        rects.push({ x: x0 / PT, w: (x1 - x0) / PT, y: (H - y1) / PT, h: (y1 - y0) / PT });
      }
    }
  }
  return rects;
}

async function measureOne(browserInfo, base, pdfjs) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: browserInfo.exe,
    args: ['--font-render-hinting=none'],
  });
  const out = { version: browserInfo.version, major: browserInfo.major };

  // ---------- probe 1: page box, baseline control, marker placement ----------
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1400 });
    await page.goto(`${base}/fixtures/version-probe.html`, { waitUntil: 'networkidle0' });

    const pdfBytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });

    // our own prediction, from the live DOM, before anything is touched
    await page.addScriptTag({ url: `${base}/src/capture/textRuns.js` });
    const dom = await page.evaluate(() => {
      const runs = globalThis.__pdf_extractTextRuns(document.body).runs;
      const bodyRect = document.body.getBoundingClientRect();
      return {
        bodyTop: bodyRect.top,
        // every probe line, with the screen-derived baseline prediction
        lines: runs
          .filter((r) => r.text.trim())
          .map((r) => ({
            text: r.text.trim(),
            pred: r.baselineCandidates.topPlusFontAscent,
          })),
      };
    });

    const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes) }).promise;
    const pg = await doc.getPage(1);
    const vp = pg.getViewport({ scale: 1 });
    out.pageW = vp.width;
    out.pageH = vp.height;

    const tc = await pg.getTextContent();
    const items = tc.items.filter((t) => t.str.trim());

    // baseline control: Chromium's own text origin for the probe line
    // This is the REAL screen-vs-print comparison: the prediction is derived
    // from the on-screen layout, the truth is the printed PDF's text origin.
    const errs = [];
    for (const ln of dom.lines) {
      const key = ln.text.slice(0, 12);
      const it = items.find((t) => t.str.trim().startsWith(key));
      if (!it) continue;
      const pdfBaselinePx = (vp.height - it.transform[5]) / PT;         // from page top
      const oursPx = MARGIN_PX + (ln.pred - dom.bodyTop);
      errs.push({ text: key, err: pdfBaselinePx - oursPx });
    }
    out.matched = errs.length;
    out.baselineErr = errs.length ? errs.reduce((m, e) => Math.abs(e.err) > Math.abs(m) ? e.err : m, 0) : null;
    // does every discrepancy land on the 1/64 px LayoutUnit grid?
    out.driftIs64ths = errs.length
      ? errs.every((e) => Math.abs(e.err * 64 - Math.round(e.err * 64)) < 0.02) : null;
    out.maxDrift = out.baselineErr == null ? null : Math.abs(out.baselineErr);

    // marker placement: numeric markers are text, so match by string
    out.markers = {};
    for (const [key, label] of [['12', 'twelve'], ['16', 'sixteen'], ['24', 'twentyfour'], ['32', 'thirtytwo']]) {
      const li = items.find((t) => t.str.includes(label));
      const marks = items.filter((t) => /^\s*1\.?\s*$/.test(t.str));
      if (!li) { out.markers[key] = null; continue; }
      // the marker for this row is the "1." nearest in y to the item text
      let best = null;
      for (const m of marks) {
        const dy = Math.abs(m.transform[5] - li.transform[5]);
        if (dy < 3 && (!best || dy < Math.abs(best.transform[5] - li.transform[5]))) best = m;
      }
      out.markers[key] = best ? +(((li.transform[4] - best.transform[4]) / PT).toFixed(3)) : null;
    }

    await page.close();
  }

  // ---------- probe 2: dashed-border dash/gap rule ----------
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 1600 });
    await page.goto(`${base}/fixtures/dashed-borders.html`, { waitUntil: 'networkidle0' });
    const rows = await page.evaluate(() => [...document.querySelectorAll('.d,.t')].map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { id: el.id, y: r.top, side: r.width, bw: parseFloat(cs.borderTopWidth) };
    }));
    const pdfBytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    const rects = await pdfRects(pdfjs, pdfBytes);
    const M = 38;                                   // dashed-borders.html uses a 10mm margin
    const dashes = rects
      .map((r) => ({ ...r, x: r.x - M, y: r.y - M }))
      .filter((r) => r.w > 0.05 && r.w < 200 && r.h > 0.05 && r.h < 20 && r.y >= -1.5);   // NOT y>=0: that hides the first row (findings 10)

    out.dash = {};
    for (const el of rows) {
      const it = dashes.filter((d) => Math.abs(d.y - el.y) < 2.5).sort((a, z) => a.x - z.x);
      if (it.length < 3) { out.dash[el.id] = null; continue; }
      const dash = it.reduce((s, d) => s + d.w, 0) / it.length;
      const gaps = [];
      for (let i = 1; i < it.length; i++) gaps.push(it[i].x - (it[i - 1].x + it[i - 1].w));
      const gap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      out.dash[el.id] = { n: it.length, dash: +dash.toFixed(3), gap: +gap.toFixed(3) };
    }
    out.dashOperatorUsed = false;                   // constructPath-only => no `d` operator
    await page.close();
  }

  // ---------- probe 3: the oracle still agrees with printToPDF ----------
  // css-break-3 makes page boxes and column boxes the same kind of fragmentainer,
  // so this SHOULD be invariant; Blink's implementation is what is under test.
  // PLAIN FLOW ONLY — gate4-pagination.html carries a repeating <thead>, which is
  // a furniture question (findings 02/03), not a fragmentation one. Mixing them
  // would report the furniture gap as a version regression.
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1400 });
    await page.goto(`${base}/fixtures/scale-shell.html`, { waitUntil: 'networkidle0' });

    await page.evaluate(() => {
      const d = document.getElementById('doc');
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 40; i++) {
        const p = document.createElement('p');
        p.textContent = `Paragraph ${i + 1}. The quick brown fox jumps over the lazy `
          + `dog, and continues far enough that this paragraph wraps onto a second line.`;
        frag.appendChild(p);
      }
      d.appendChild(frag);
      return document.fonts.ready;
    });

    // ground truth FIRST — before any DOM mutation (findings 02's harness bug)
    const pdfBytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes) }).promise;
    const truth = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i);
      const tc = await pg.getTextContent();
      truth.push(tc.items.map((t) => t.str).join('').replace(/\s+/g, ''));
    }

    await page.addScriptTag({ url: `${base}/src/capture/textRuns.js` });
    const oracle = await page.evaluate(() => {
      const d = document.getElementById('doc');
      const PTl = 72 / 96, M = 76;
      const A4 = { w: 595.276, h: 841.89 };
      const cW = A4.w / PTl - 2 * M, cH = A4.h / PTl - 2 * M;
      const COLS = 16;
      Object.assign(d.style, {
        width: `${cW * COLS}px`, height: `${cH}px`,
        columnWidth: `${cW}px`, columnGap: '0px', columnFill: 'auto',
      });
      d.getBoundingClientRect();
      const box = d.getBoundingClientRect();
      const cw = box.width / COLS;
      const runs = globalThis.__pdf_extractTextRuns(d).runs;
      const byCol = new Map();
      for (const r of runs) {
        const c = Math.floor((r.rect.left - box.left) / cw + 1e-3);
        if (!byCol.has(c)) byCol.set(c, []);
        byCol.get(c).push(r.text);
      }
      return [...byCol.keys()].sort((a, z) => a - z)
        .map((c) => byCol.get(c).join('').replace(/\s+/g, ''));
    });

    out.pagesTruth = truth.length;
    out.pagesOracle = oracle.length;
    let agree = 0;
    for (let i = 0; i < Math.min(truth.length, oracle.length); i++) {
      if (truth[i] === oracle[i]) agree++;
    }
    out.oracleAgree = `${agree}/${truth.length}`;
    await page.close();
  }

  await browser.close();
  return out;
}

async function main() {
  const browsers = installedBrowsers();
  if (!browsers.length) {
    console.error('No cached Chrome for Testing builds found.');
    process.exit(1);
  }
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  console.log(`Sweeping ${browsers.length} builds: ${browsers.map((b) => b.major).join(', ')}\n`);
  const rows = [];
  for (const b of browsers) {
    try {
      const r = await measureOne(b, base, pdfjs);
      rows.push(r);
      console.log(`  m${r.major.toString().padEnd(4)} ${r.version.padEnd(18)} ok`);
    } catch (e) {
      console.log(`  m${b.major.toString().padEnd(4)} ${b.version.padEnd(18)} FAILED — ${e.message.split('\n')[0]}`);
      rows.push({ version: b.version, major: b.major, failed: e.message.split('\n')[0] });
    }
  }

  await new Promise((r) => server.close(r));

  const ok = rows.filter((r) => !r.failed);
  const baseline = ok.find((r) => r.major === 152) || ok[0];

  const f = (v, d = 3) => (v == null ? '—' : (+v).toFixed(d));
  const same = (a, b, tol = 1e-6) => a != null && b != null && Math.abs(a - b) <= tol;

  console.log('\n=== CLASS U — behavioural rules under test ===');
  console.log('major'.padStart(6), 'pageW pt'.padStart(11), 'pageH pt'.padStart(11),
    'marker12'.padStart(10), 'marker16'.padStart(10), 'marker24'.padStart(10), 'marker32'.padStart(10));
  for (const r of ok) {
    console.log(
      String(r.major).padStart(6), f(r.pageW).padStart(11), f(r.pageH).padStart(11),
      f(r.markers?.['12']).padStart(10), f(r.markers?.['16']).padStart(10),
      f(r.markers?.['24']).padStart(10), f(r.markers?.['32']).padStart(10));
  }

  console.log('\n=== DASH / GAP (dash width, gap width) ===');
  const dashIds = ok.length ? Object.keys(ok[0].dash || {}) : [];
  const show = dashIds.slice(0, 8);
  console.log('major'.padStart(6), ...show.map((id) => id.padStart(15)));
  for (const r of ok) {
    console.log(String(r.major).padStart(6),
      ...show.map((id) => {
        const d = r.dash?.[id];
        return (d ? `${d.dash}/${d.gap}` : '—').padStart(15);
      }));
  }

  console.log('\n=== CONTROLS — these must NOT move ===');
  console.log('major'.padStart(6), 'lines'.padStart(7), 'baselineErr px'.padStart(16),
    'pages (pdf/oracle)'.padStart(20), 'page text agree'.padStart(17));
  for (const r of ok) {
    console.log(String(r.major).padStart(6), String(r.matched ?? '—').padStart(7),
      (r.baselineErr == null ? '—' : r.baselineErr.toExponential(2)).padStart(16),
      `${r.pagesTruth ?? '—'} / ${r.pagesOracle ?? '—'}`.padStart(20),
      String(r.oracleAgree ?? '—').padStart(17));
  }

  console.log(`\n=== STABILITY vs m${baseline.major} ===`);
  let moved = 0;
  for (const r of ok) {
    if (r === baseline) continue;
    const diffs = [];
    if (!same(r.pageW, baseline.pageW, 0.01)) diffs.push(`pageW ${f(baseline.pageW)}→${f(r.pageW)}`);
    if (!same(r.pageH, baseline.pageH, 0.01)) diffs.push(`pageH ${f(baseline.pageH)}→${f(r.pageH)}`);
    for (const k of ['12', '16', '24', '32']) {
      if (!same(r.markers?.[k], baseline.markers?.[k], 0.01)) {
        diffs.push(`marker${k} ${f(baseline.markers?.[k])}→${f(r.markers?.[k])}`);
      }
    }
    for (const id of dashIds) {
      const a = baseline.dash?.[id], b = r.dash?.[id];
      if (a && b && (!same(a.dash, b.dash, 0.01) || !same(a.gap, b.gap, 0.01))) {
        diffs.push(`${id} ${a.dash}/${a.gap}→${b.dash}/${b.gap}`);
      }
    }
    if (diffs.length) { moved += diffs.length; console.log(`  m${r.major}: ${diffs.join('; ')}`); }
    else console.log(`  m${r.major}: identical`);
  }
  const failed = rows.filter((r) => r.failed);
  console.log(`\n${moved === 0 ? 'No measured quantity moved across the sweep.' : `${moved} quantity/quantities moved.`}`);
  console.log(`builds compared: ${ok.length}/${rows.length}` +
    (failed.length ? `  —  DID NOT RUN: ${failed.map((r) => 'm' + r.major).join(', ')}` : ''));
  if (failed.length) for (const r of failed) console.log(`    m${r.major}: ${r.failed}`);

  fs.writeFileSync(path.join(ROOT, 'out', 'version-sweep.json'), JSON.stringify(rows, null, 2));
  console.log('raw → out/version-sweep.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
