/**
 * Page-vs-column divergence matrix.
 *
 * Compare Chromium page fragmentation with the multicolumn oracle. For every
 * probe, this harness fragments the same
 * document twice, once as pages (Page.printToPDF, ground truth) and once as
 * columns (the oracle), then diffs them.
 *
 * Output is a matrix of MATCH / DIVERGE with the cause named.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROBE_DIR = path.join(ROOT, 'fixtures', 'probes');
const PT_PER_PX = 72 / 96;
const MIME = { '.html': 'text/html', '.ttf': 'font/ttf', '.js': 'text/javascript' };

// Small pages so each probe fragments in a few lines and runs fast.
const PAGE = { wMm: 120, hMm: 90, marginMm: 10 };

const mmToPx = (mm) => (mm / 25.4) * 96;
// Chromium rounds @page margins to whole CSS pixels. (Whole *points* also fits
// a 20mm margin -- 75.59px -> 76px is 57pt exactly -- but only the pixel rule
// also fits 10mm, where 37.795px -> 38px is 28.5pt.)
const MARGIN_PX = Math.round(mmToPx(PAGE.marginMm));
const CONTENT_W = mmToPx(PAGE.wMm) - 2 * MARGIN_PX;
const CONTENT_H = mmToPx(PAGE.hMm) - 2 * MARGIN_PX;

// ---------------------------------------------------------------- probes ---

const filler = (n, tag = 'p') => Array.from({ length: n }, (_, i) =>
  `<${tag}>Paragraph ${i + 1}. The quick brown fox jumps over the lazy dog and keeps ` +
  `going so that this block wraps onto more than one line of text.</${tag}>`).join('\n');

const rows = (n) => Array.from({ length: n }, (_, i) =>
  `<tr><td>${String(i + 1).padStart(3, '0')}</td><td>Item number ${i + 1}</td><td>${(i + 1) * 37}.00</td></tr>`).join('\n');

const PROBES = [
  {
    name: 'control-plain-flow',
    what: 'plain paragraphs, no fragmentation rules',
    css: '',
    html: filler(9),
  },
  {
    name: 'break-before-page',
    what: 'forced page break (translated to column break)',
    css: '.brk { break-before: page; }',
    html: filler(4) + '<h2 class="brk">Forced</h2>' + filler(4),
  },
  {
    name: 'break-inside-avoid',
    what: 'indivisible block straddling a boundary',
    css: '.card { break-inside: avoid; border: 1px solid #888; padding: 6px; margin: 0 0 10px; }',
    html: filler(3) +
      '<div class="card">Indivisible card. This block must move whole to the next fragment ' +
      'rather than being split, and it is tall enough to straddle a boundary if nothing ' +
      'stopped it from doing so at all.</div>' + filler(4),
  },
  {
    name: 'break-after-avoid',
    what: 'heading that must not be orphaned at a fragment foot',
    css: 'h2 { break-after: avoid; font-size: 15px; margin: 8px 0 4px; }',
    html: filler(3) + '<h2>Heading kept with text</h2>' + filler(4),
  },
  {
    name: 'orphans-widows',
    what: 'orphans: 3; widows: 3',
    css: '.ow { orphans: 3; widows: 3; }',
    html: filler(3) +
      '<p class="ow">This paragraph carries orphan and widow constraints of three lines each, ' +
      'so it must not leave one or two lines stranded on either side of a fragment boundary, ' +
      'and additional lines get pulled across to satisfy that minimum.</p>' + filler(3),
  },
  {
    name: 'table-header-group',
    what: 'repeating <thead> (known divergence)',
    css: 'table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #888; padding: 2px 4px; } thead { display: table-header-group; }',
    html: filler(2) +
      `<table><thead><tr><th>Ref</th><th>Name</th><th>Amount</th></tr></thead><tbody>${rows(14)}</tbody></table>`,
  },
  {
    name: 'table-footer-group',
    what: 'repeating <tfoot>',
    css: 'table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #888; padding: 2px 4px; } tfoot { display: table-footer-group; }',
    html: filler(2) +
      `<table><tfoot><tr><td>TOTAL</td><td>sum</td><td>9999.00</td></tr></tfoot><tbody>${rows(14)}</tbody></table>`,
  },
  {
    name: 'position-fixed',
    what: 'fixed element (repeats on every printed page)',
    css: '.stamp { position: fixed; top: 0; right: 0; font-size: 11px; }',
    html: '<div class="stamp">RUNNING STAMP</div>' + filler(9),
  },
  {
    name: 'list-counters',
    what: 'ordered-list markers across a boundary',
    css: 'ol { margin: 0; padding-left: 22px; }',
    html: filler(2) + `<ol>${Array.from({ length: 12 }, (_, i) => `<li>List entry number ${i + 1} with enough text to wrap.</li>`).join('')}</ol>`,
  },
  {
    name: 'named-pages',
    what: 'CSS named pages (page: label)',
    css: '@page wide { size: 160mm 90mm; } .wide { page: wide; }',
    html: filler(3) + '<div class="wide">' + filler(3) + '</div>' + filler(3),
  },
];

// ---------------------------------------------------------------- harness ---

function template(p) {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  @page { size: ${PAGE.wMm}mm ${PAGE.hMm}mm; margin: ${PAGE.marginMm}mm; }
  html, body { margin: 0; padding: 0; }
  @font-face { font-family: "Sans"; src: url("../font.ttf") format("truetype"); }
  body { font-family: "Sans"; font-size: 11px; line-height: 16px; }
  /* Pin both modes to the identical content width. Sub-pixel differences here
     change line breaking, not just page assignment. */
  #doc { width: ${CONTENT_W}px; }
  p { margin: 0 0 8px; }
  ${p.css}
</style></head><body>
<div id="doc">
${p.html}
</div>
</body></html>`;
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
      out.push({
        page: i - 1,
        str: t.str,
        y: (vp.height - t.transform[5]) / PT_PER_PX,
        x: t.transform[4] / PT_PER_PX,
      });
    }
  }
  return { items: out, pages: doc.numPages };
}

async function runProbe(browser, base, probe) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.goto(`${base}/fixtures/probes/${probe.name}.html`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);

  // 1. GROUND TRUTH first — any DOM mutation below would corrupt it.
  const pdfBytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  const truth = await truthFromPdf(pdfBytes);

  // 2. The multicolumn oracle.
  await page.addScriptTag({ url: `${base}/src/capture/textRuns.js` });
  const oracle = await page.evaluate((H, W) => {
    const doc = document.getElementById('doc');
    let translated = 0;
    for (const el of doc.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.breakBefore === 'page') { el.style.breakBefore = 'column'; translated++; }
      if (cs.breakAfter === 'page') { el.style.breakAfter = 'column'; translated++; }
    }
    Object.assign(doc.style, {
      width: `${W * 16}px`, height: `${H}px`,
      columnWidth: `${W}px`, columnGap: '0px', columnFill: 'auto',
    });
    doc.getBoundingClientRect();
    const box = doc.getBoundingClientRect();
    // Measure the column width rather than assuming it: Chromium rounds the
    // container's used width, so the real column pitch is a hair narrower than
    // the value we asked for, and an assumed pitch puts column N at N-1.
    const colWidth = box.width / 16;
    const r = globalThis.__pdf_extractTextRuns(doc);
    return {
      originLeft: box.left, originTop: box.top, translated, colWidth,
      runs: r.runs.map((x) => ({
        text: x.text,
        col: Math.floor((x.rect.left - box.left) / colWidth + 1e-3),
        y: x.baselineCandidates.topPlusFontAscent - box.top,
      })),
    };
  }, CONTENT_H, CONTENT_W);

  await page.close();

  // 3. Diff.
  let cursor = 0, matched = 0, pageOk = 0;
  const yErr = [];
  const misassigned = [];
  const unmatchedOurs = [];
  for (const r of oracle.runs) {
    const want = dense(r.text);
    if (!want) continue;
    let found = -1;
    for (let i = cursor; i < truth.items.length; i++) {
      if (dense(truth.items[i].str) === want) { found = i; break; }
    }
    if (found === -1) { unmatchedOurs.push(r.text); continue; }
    cursor = found + 1;
    matched++;
    const t = truth.items[found];
    if (t.page === r.col) {
      pageOk++;
      yErr.push((MARGIN_PX + r.y) - t.y);
    } else {
      misassigned.push({ text: r.text.slice(0, 30), col: r.col + 1, page: t.page + 1 });
    }
  }

  // Ground-truth text with no counterpart in the oracle: content the page
  // fragmenter creates that the column fragmenter does not.
  const oracleDense = new Set(oracle.runs.map((r) => dense(r.text)));
  const counts = new Map();
  for (const t of truth.items) {
    const d = dense(t.str);
    if (!d) continue;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  const extraInPrint = [];
  for (const [d, n] of counts) {
    const ours = oracle.runs.filter((r) => dense(r.text) === d).length;
    if (n > ours) extraInPrint.push({ text: d, print: n, oracle: ours });
  }

  const cols = new Set(oracle.runs.map((r) => r.col)).size;
  const absY = yErr.map(Math.abs);
  return {
    probe, pages: truth.pages, cols,
    matched, pageOk, translated: oracle.translated,
    pct: matched ? (100 * pageOk / matched) : 0,
    maxY: absY.length ? Math.max(...absY) : 0,
    meanY: absY.length ? absY.reduce((a, b) => a + b, 0) / absY.length : 0,
    misassigned, unmatchedOurs, extraInPrint,
  };
}

async function main() {
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  for (const p of PROBES) fs.writeFileSync(path.join(PROBE_DIR, `${p.name}.html`), template(p));

  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({ headless: true });

  console.log('=== SETUP ===');
  console.log(`page ${PAGE.wMm}x${PAGE.hMm}mm, margin ${PAGE.marginMm}mm -> ${MARGIN_PX.toFixed(2)}px (${(MARGIN_PX*PT_PER_PX).toFixed(2)}pt)`);
  console.log(`content box ${CONTENT_W.toFixed(2)} x ${CONTENT_H.toFixed(2)} px`);
  console.log(`${PROBES.length} probes\n`);

  const results = [];
  for (const p of PROBES) results.push(await runProbe(browser, base, p));
  await browser.close();
  server.close();

  console.log('=== DIVERGENCE MATRIX ===');
  console.log(
    'probe'.padEnd(22), 'pages'.padStart(6), 'cols'.padStart(5),
    'page ok'.padStart(9), 'maxΔy'.padStart(8), '  verdict',
  );
  for (const r of results) {
    const clean = r.pct === 100 && r.maxY < 0.75 && !r.extraInPrint.length && !r.unmatchedOurs.length;
    const verdict = clean ? 'MATCH'
      : r.pages !== r.cols ? 'DIVERGE — fragment count'
      : r.extraInPrint.length ? 'DIVERGE — print emits extra content'
      : r.pct < 100 ? 'DIVERGE — page assignment'
      : 'DIVERGE — position';
    console.log(
      r.probe.name.padEnd(22),
      String(r.pages).padStart(6), String(r.cols).padStart(5),
      `${r.pageOk}/${r.matched}`.padStart(9),
      r.maxY.toFixed(2).padStart(8),
      '  ' + verdict,
    );
  }

  console.log('\n=== DETAIL ===');
  for (const r of results) {
    const clean = r.pct === 100 && r.maxY < 0.75 && !r.extraInPrint.length && !r.unmatchedOurs.length;
    if (clean) continue;
    console.log(`\n--- ${r.probe.name}: ${r.probe.what}`);
    console.log(`    pages=${r.pages} cols=${r.cols} matched=${r.matched} pageOk=${r.pageOk} meanΔy=${r.meanY.toFixed(2)} maxΔy=${r.maxY.toFixed(2)}`);
    if (r.translated) console.log(`    forced page breaks translated: ${r.translated}`);
    for (const m of r.misassigned.slice(0, 5)) console.log(`    misassigned col${m.col} -> page${m.page}: ${JSON.stringify(m.text)}`);
    for (const e of r.extraInPrint.slice(0, 5)) console.log(`    print has extra: ${JSON.stringify(e.text)} print=${e.print} oracle=${e.oracle}`);
    for (const u of r.unmatchedOurs.slice(0, 5)) console.log(`    oracle-only text: ${JSON.stringify(u)}`);
  }

  fs.writeFileSync(path.join(ROOT, 'out', 'divergence-matrix.json'),
    JSON.stringify(results.map((r) => ({ ...r, probe: r.probe.name })), null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
