/**
 * Explain the three anomalies from gate1-stress:
 *   1. Δleft = -3.961px on runs that follow an inline span
 *   2. Δbase = -0.484px on paragraphs #c and #f
 *   3. Arabic runs matched no PDF item
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.ttf': 'font/ttf' };

function serve(dir) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
      if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
  });
}

const main = async () => {
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1600 });
  await page.goto(`${base}/fixtures/gate1-stress.html`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);

  // --- 1 & 2: what does the DOM actually say? ---
  const dom = await page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    const asc = (f) => { ctx.font = f; const m = ctx.measureText('Hxlpqg'); return m.fontBoundingBoxAscent; };

    // leading-space hypothesis: does the run text start with a space?
    const spans = [...document.querySelectorAll('#a span')];
    const afterSpan = document.getElementById('a').childNodes[2]; // " then "
    const r = document.createRange();
    r.selectNodeContents(afterSpan);

    const rFirstNonSpace = document.createRange();
    const idx = afterSpan.data.search(/\S/);
    rFirstNonSpace.setStart(afterSpan, idx);
    rFirstNonSpace.setEnd(afterSpan, afterSpan.data.length);

    // measure a single space in the paragraph font
    ctx.font = '400 16px "Sans"';
    const spaceW = ctx.measureText(' ').width;

    return {
      leadingSpace: {
        nodeData: JSON.stringify(afterSpan.data),
        firstNonSpaceIndex: idx,
        rectLeftWholeNode: r.getBoundingClientRect().left,
        rectLeftTrimmed: rFirstNonSpace.getBoundingClientRect().left,
        spaceAdvancePx: spaceW,
      },
      // fallback-trap hypothesis: does canvas resolve the family list the same
      // way the layout engine does?
      ascents: {
        'Sans': asc('400 20px "Sans"'),
        'Serif': asc('400 20px "Serif"'),
        'Arab': asc('400 20px "Arab"'),
        'Arab,Serif (as authored on #f)': asc('400 20px "Arab","Serif"'),
      },
      fRunAscent: (() => {
        const el = document.getElementById('f');
        const s = getComputedStyle(el);
        ctx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} / normal ${s.fontFamily}`;
        return { font: ctx.font, ascent: ctx.measureText('Hxlpqg').fontBoundingBoxAscent };
      })(),
      // paragraph tops, to see whether #c/#f sit on fractional positions
      pTops: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
        id, top: document.getElementById(id).getBoundingClientRect().top,
      })),
    };
  });

  const pdfBytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  await browser.close(); server.close();

  console.log('=== 1. leading-space hypothesis ===');
  console.log(dom.leadingSpace);
  console.log(`  rectLeft difference = ${(dom.leadingSpace.rectLeftTrimmed - dom.leadingSpace.rectLeftWholeNode).toFixed(4)}px`);
  console.log(`  space advance       = ${dom.leadingSpace.spaceAdvancePx.toFixed(4)}px`);
  console.log();

  console.log('=== 2. font-list resolution (fallback trap on #f) ===');
  console.log(dom.ascents);
  console.log('  #f computed ->', dom.fRunAscent);
  console.log();
  console.log('  paragraph tops (screen layout):');
  for (const p of dom.pTops) console.log(`    #${p.id}: ${p.top}`);
  console.log();

  console.log('=== 3. what is in the PDF for the Arabic runs ===');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: pdfBytes, useSystemFonts: false }).promise;
  const tc = await (await doc.getPage(1)).getTextContent();
  const arabic = tc.items.filter((i) => /[؀-ࣿﭐ-﻿]/.test(i.str));
  console.log(`items containing Arabic-range codepoints: ${arabic.length}`);
  for (const it of arabic) {
    console.log(`  ${JSON.stringify(it.str)}`);
    console.log(`    codepoints: ${[...it.str].map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ')}`);
    console.log(`    x=${it.transform[4].toFixed(2)}pt y=${it.transform[5].toFixed(2)}pt font=${it.fontName}`);
  }
  const source = 'مرحبا بالعالم هذا نص عربي';
  console.log(`  source codepoints: ${[...source.replace(/\s/g, '')].map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ')}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
