/**
 * The three named-page items left open by findings 13:
 *   nested named runs
 *   :first / :left / :right page pseudo-classes
 *   whether a run boundary always coincides with a page break
 *
 * Runs are measured by hiding every other run and applying the multicolumn
 * oracle at that run's own geometry — nested runs are not contiguous siblings,
 * so they cannot be wrapped.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PT = 72 / 96;
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };

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

async function run(browser, base, fixture) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1400 });
  await page.goto(`${base}/fixtures/probes/${fixture}.html`, { waitUntil: 'networkidle0' });

  const pdfBytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: pdfBytes.slice(), useSystemFonts: false }).promise;
  const truth = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const vp = pg.getViewport({ scale: 1 });
    const tc = await pg.getTextContent();
    truth.push({ w: vp.width / PT, h: vp.height / PT, text: tc.items.map((t) => t.str).join('') });
  }

  await page.addScriptTag({ url: `${base}/src/capture/textRuns.js` });
  await page.addScriptTag({ url: `${base}/src/pagination/furniture.js` });

  const ours = await page.evaluate(() => {
    const F = globalThis.__pdf_furniture;
    const doc = document.getElementById('doc');
    const rules = F.pageRules();
    const runs = F.segmentByPage(doc);

    const mmPx = (mm) => (mm / 25.4) * 96;
    function geom(sizeStr, marginStr) {
      const size = (sizeStr || '').match(/([\d.]+)mm\s+([\d.]+)mm/);
      const marg = (marginStr || '').match(/([\d.]+)mm(?:\s+([\d.]+)mm)?/);
      const w = size ? mmPx(+size[1]) : mmPx(210);
      const h = size ? mmPx(+size[2]) : mmPx(297);
      const mv = marg ? Math.round(mmPx(+marg[1])) : 0;
      const mh = marg && marg[2] !== undefined ? Math.round(mmPx(+marg[2])) : mv;
      return { w, h, mTop: mv, mBottom: mv, mLeft: mh, mRight: mh,
               contentW: w - 2 * mh, contentH: h - 2 * mv };
    }

    const all = new Set(runs.flatMap((r) => r.elements));
    const pages = [];
    const runInfo = [];

    for (const r of runs) {
      // A run's elements are not necessarily siblings (nested runs), so isolate
      // by hiding the others rather than wrapping.
      const hidden = [];
      for (const el of all) {
        if (r.elements.includes(el)) continue;
        hidden.push([el, el.style.display]);
        el.style.display = 'none';
      }

      // forced page breaks become column breaks inside the oracle
      F.translatePageBreaks(doc);

      const merged = F.rulesForPage(rules, r.page, 0);
      const g = geom(merged.size, merged.margin);
      const COLS = 16;
      const prev = doc.style.cssText;
      Object.assign(doc.style, {
        width: `${g.contentW * COLS}px`, height: `${g.contentH}px`,
        columnWidth: `${g.contentW}px`, columnGap: '0px', columnFill: 'auto',
      });
      doc.getBoundingClientRect();
      const box = doc.getBoundingClientRect();
      const cw = box.width / COLS;
      const extracted = globalThis.__pdf_extractTextRuns(doc);
      const byCol = new Map();
      for (const t of extracted.runs) {
        const c = Math.floor((t.rect.left - box.left) / cw + 1e-3);
        if (!byCol.has(c)) byCol.set(c, []);
        byCol.get(c).push(t.text);
      }
      const cols = [...byCol.keys()].sort((a, b) => a - b);
      runInfo.push({ page: r.page || '(default)', elements: r.elements.length, columns: cols.length });
      for (const c of cols) pages.push({ run: r.page, geom: g, texts: byCol.get(c) });

      doc.style.cssText = prev;
      for (const [el, d] of hidden) el.style.display = d;
    }

    // furniture per page, with the pseudo-class cascade applied
    const ctx = document.createElement('canvas').getContext('2d');
    const DEF = F.MARGIN_BOX_DEFAULT_FONT;
    const total = pages.length;
    pages.forEach((pg, i) => {
      const merged = F.rulesForPage(rules, pg.run, i);
      pg.furniture = [];
      for (const b of merged.boxes) {
        const { text } = F.resolveMarginContent(b.content, i + 1, total);
        if (!text) continue;
        const size = b.font.size || DEF.size;
        ctx.font = `${b.font.style || DEF.style} ${b.font.weight || DEF.weight} ${size}px ${b.font.family || DEF.family}`;
        pg.furniture.push({ slot: b.slot, text });
      }
    });

    return {
      rules: [...rules.keys()],
      runs: runInfo,
      pages: pages.map((p) => ({ run: p.run || '(default)', w: p.geom.w, h: p.geom.h,
        furniture: p.furniture, texts: p.texts })),
    };
  });

  await page.close();
  return { ours, truth };
}

async function main() {
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({ headless: true });

  const fixtures = process.argv.length > 2 ? process.argv.slice(2) : ['nested-runs', 'page-pseudo'];
  for (const fixture of fixtures) {
    const { ours, truth } = await run(browser, base, fixture);
    console.log(`\n===== ${fixture} =====`);
    console.log('  @page rules found:', ours.rules.map((r) => r || '(default)').join(', '));
    console.log('  runs:');
    for (const r of ours.runs) {
      console.log(`    page="${r.page}"`.padEnd(24) + `${r.elements} element(s) -> ${r.columns} column(s)`);
    }

    console.log('  pages:');
    console.log('   ', '#'.padStart(3), 'run'.padEnd(11), 'ours'.padStart(14), 'chromium'.padStart(14), 'size'.padStart(5), ' furniture');
    let sizeOk = 0, furnOk = 0, furnTotal = 0;
    for (let i = 0; i < Math.max(ours.pages.length, truth.length); i++) {
      const o = ours.pages[i], t = truth[i];
      if (!o || !t) { console.log('   ', String(i + 1).padStart(3), '  (page count differs)'); continue; }
      const m = Math.abs(o.w - t.w) < 1.5 && Math.abs(o.h - t.h) < 1.5;
      if (m) sizeOk++;
      const furn = o.furniture.map((f) => f.text);
      for (const f of furn) { furnTotal++; if (dense(t.text).includes(dense(f))) furnOk++; }
      console.log('   ', String(i + 1).padStart(3), o.run.padEnd(11),
        `${o.w.toFixed(0)}x${o.h.toFixed(0)}`.padStart(14),
        `${t.w.toFixed(0)}x${t.h.toFixed(0)}`.padStart(14),
        (m ? 'ok' : 'DIFF').padStart(5), ' ' + furn.join(' '));
    }
    console.log(`  page count: ours ${ours.pages.length}, chromium ${truth.length}`);
    console.log(`  sizes matching: ${sizeOk}/${truth.length}   furniture on correct page: ${furnOk}/${furnTotal}`);
  }

  await browser.close();
  server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
