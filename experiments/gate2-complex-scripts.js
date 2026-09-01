/**
 * Complex-script shaping experiment for Arabic, Hebrew and Devanagari.
 *
 * Checks font selection, contextual shaping and Unicode extraction with two
 * independent extractors. The shaping prototype runs in the browser; Node only
 * drives and verifies it.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { execFileSync } from 'node:child_process';

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

const cps = (s) => [...s].map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'));
// Poppler emits Unicode bidi control characters (RLE/PDF/LRM...) around RTL
// runs. They are presentation scaffolding, not source text, so comparing
// without stripping them reports false failures on every bidi line.
const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const dense = (s) => s.replace(BIDI_CONTROLS, '').replace(/\s+/g, '');

/**
 * Text as an INDEPENDENT extractor sees it.
 *
 * pdf.js and Poppler can interpret the same complex-script text differently,
 * so every round-trip claim below is checked against both.
 */
function popplerText(file) {
  try {
    return execFileSync('pdftotext', ['-q', file, '-'], { encoding: 'utf8' });
  } catch {
    return null;   // poppler not installed
  }
}

async function pdfText(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
  const tc = await (await doc.getPage(1)).getTextContent();
  return tc.items.filter((i) => i.str && i.str.trim()).map((i) => i.str);
}

async function main() {
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page]', m.text()); });
  await page.setViewport({ width: 1200, height: 1600 });
  await page.goto(`${base}/fixtures/gate2-scripts.html`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);

  const chromiumPdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  fs.writeFileSync(path.join(ROOT, 'out', 'gate2-chromium.pdf'), chromiumPdf);

  // @pdf-lib/fontkit's complex-script shaping is transpiled with generators and
  // needs a regeneratorRuntime polyfill in the browser. Latin never reaches that
  // path, so this only surfaces once you render Arabic or Indic text.
  await page.addScriptTag({ url: `${base}/node_modules/regenerator-runtime/runtime.js` });
  await page.addScriptTag({ url: `${base}/node_modules/pdf-lib/dist/pdf-lib.min.js` });
  await page.addScriptTag({ url: `${base}/node_modules/@pdf-lib/fontkit/dist/fontkit.umd.min.js` });
  await page.addScriptTag({ url: `${base}/src/capture/textRuns.js` });
  await page.addScriptTag({ url: `${base}/src/text/fontRegistry.js` });

  const result = await page.evaluate(async (b, useActualText) => {
    const { PDFDocument, rgb, PDFOperator, PDFName, PDFHexString, PDFDict,
            setCharacterSqueeze } = PDFLib;
    const PT = 72 / 96, MARGIN = 76, A4 = { w: 595.276, h: 841.89 };

    const reg = new globalThis.__pdf_FontRegistry();
    reg.register({ family: 'Sans', src: `${b}/fixtures/font.ttf` })
       .register({ family: 'Arab', src: `${b}/fixtures/NotoSansArabic-Regular.ttf` })
       .register({ family: 'Hebr', src: `${b}/fixtures/NotoSansHebrew-Regular.ttf` })
       .register({ family: 'Deva', src: `${b}/fixtures/NotoSansDevanagari-Regular.ttf` });
    await reg.load();

    const extracted = globalThis.__pdf_extractTextRuns(document.body);

    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const embedded = new Map();
    for (const f of reg.usedFaces()) {
      embedded.set(f, await doc.embedFont(f.bytes, { subset: true }));
    }
    const pg = doc.addPage([A4.w, A4.h]);

    let drawn = 0, skipped = 0, multiFaceWords = 0, maxSqueeze = 0;
    for (const run of extracted.runs) {
      const el = document.querySelector(run.selector) || document.body;
      const cs = getComputedStyle(el);
      const yPt = A4.h - (MARGIN + run.baselineCandidates.topPlusFontAscent) * PT;
      const sizePt = run.font.size * PT;

      for (const w of run.words) {
        const subs = reg.shapeRuns(w.text, cs);
        if (subs.length > 1) multiFaceWords++;
        if (!subs.length) { skipped++; continue; }

        // PDF extraction returns glyphs in DRAWING order. Scripts that reorder
        // (Devanagari's pre-base vowel signs) or ligate therefore copy out
        // scrambled, even when every glyph maps back to the right codepoint.
        // /ActualText marked content states the logical text for the cluster
        // and is the standard remedy.
        // OFF by default. /ActualText is the spec's answer to reordered and
        // ligated clusters, but emitting it per word made poppler extract this
        // document as garbage while pdf.js ignored it entirely. Opt in with
        // --actualtext to reproduce that; it needs work before it ships.
        if (useActualText) {
          const dict = PDFDict.withContext(doc.context);
          dict.set(PDFName.of('ActualText'), PDFHexString.fromText(w.text));
          pg.pushOperators(PDFOperator.of('BDC', [PDFName.of('Span'), dict]));
        }

        let x = (MARGIN + w.left) * PT;

        // Our shaper and Chromium's HarfBuzz agree on glyph SELECTION but not
        // always on advances inside a word (ligature clusters, cursive joins).
        // The browser already measured the word, so make that measurement
        // authoritative: Tz scales the run horizontally to the measured width.
        // For RTL this matters most -- drawing left-to-right from `left` would
        // otherwise push the whole drift onto the right edge, which is where an
        // RTL word visually begins.
        let squeezed = false;
        if (subs.length === 1) {
          const font = embedded.get(subs[0].face);
          const shaped = font.widthOfTextAtSize(subs[0].text, sizePt);
          const measured = (w.right - w.left) * PT;
          if (shaped > 0.01 && measured > 0.01) {
            const pct = (measured / shaped) * 100;
            if (Math.abs(pct - 100) > 0.05) {
              pg.pushOperators(setCharacterSqueeze(pct));
              squeezed = true;
              maxSqueeze = Math.max(maxSqueeze, Math.abs(pct - 100));
            }
          }
        }

        for (const sub of subs) {
          const font = embedded.get(sub.face);
          pg.drawText(sub.text, { x, y: yPt, size: sizePt, font, color: rgb(0, 0, 0) });
          x += font.widthOfTextAtSize(sub.text, sizePt);
          drawn++;
        }
        if (squeezed) pg.pushOperators(setCharacterSqueeze(100));

        if (useActualText) pg.pushOperators(PDFOperator.of('EMC', []));
      }
    }

    const bytes = await doc.save();
    return {
      bytes: Array.from(bytes),
      diagnostics: reg.report(),
      sourceByPara: [...document.querySelectorAll('p')].map((p) => ({ id: p.id, text: p.textContent.trim() })),
      stats: { runs: extracted.runs.length, drawn, skipped, multiFaceWords, maxSqueeze },
    };
  }, base, process.argv.includes('--actualtext'));

  await browser.close();
  server.close();

  const bytes = Uint8Array.from(result.bytes);
  fs.writeFileSync(path.join(ROOT, 'out', 'gate2-ours.pdf'), bytes);

  console.log('=== FONT REGISTRY ===');
  console.log(`runs=${result.stats.runs} drawn=${result.stats.drawn} ` +
    `skipped=${result.stats.skipped} multiFaceWords=${result.stats.multiFaceWords}`);
  console.log(`max horizontal correction: ${result.stats.maxSqueeze.toFixed(2)}%`);
  console.log('\ndiagnostics:');
  if (!result.diagnostics.length) console.log('  (none)');
  for (const d of result.diagnostics) {
    console.log(`  ${d.code}  ${d.codePoint ?? ''} ${JSON.stringify(d.char ?? '')} x${d.count}`);
    console.log(`    ${d.message}`);
  }

  const ourItems = await pdfText(bytes);
  const chromeItems = await pdfText(chromiumPdf);
  const ourText = dense(ourItems.join(''));
  const chromeText = dense(chromeItems.join(''));

  const ourPop = popplerText(path.join(ROOT, 'out', 'gate2-ours.pdf'));
  const chrPop = popplerText(path.join(ROOT, 'out', 'gate2-chromium.pdf'));
  const havePoppler = ourPop !== null && chrPop !== null;

  console.log('\n=== TEXT ROUND-TRIP, TWO INDEPENDENT EXTRACTORS ===');
  if (!havePoppler) console.log('(poppler not installed — results use pdf.js only)');
  console.log('para'.padEnd(9), 'ours/pdfjs'.padStart(11), 'ours/poppler'.padStart(13),
    'chrome/pdfjs'.padStart(13), 'chrome/poppler'.padStart(15));
  for (const p of result.sourceByPara) {
    const src = dense(p.text);
    const row = [
      ourText.includes(src),
      havePoppler ? dense(ourPop).includes(src) : null,
      chromeText.includes(src),
      havePoppler ? dense(chrPop).includes(src) : null,
    ].map((v) => (v === null ? '-' : v ? 'yes' : 'NO'));
    console.log(p.id.padEnd(9), row[0].padStart(11), row[1].padStart(13),
      row[2].padStart(13), row[3].padStart(15));
  }
  if (havePoppler) {
    console.log('\n  Note: pdf.js and poppler DISAGREE about the same bytes.');
    console.log('  Any single-extractor conclusion about text fidelity is unsafe.');
  }

  console.log('\n=== WHAT EACH PDF ACTUALLY ENCODES (Arabic) ===');
  const ar = result.sourceByPara.find((p) => p.id === 'arabic').text;
  console.log('  source  :', cps(dense(ar)).slice(0, 8).join(' '), '…');
  const arOurs = ourItems.find((s) => /[؀-ۿﭐ-﻿]/.test(s));
  const arChr = chromeItems.find((s) => /[؀-ۿﭐ-﻿]/.test(s));
  console.log('  ours    :', arOurs ? cps(arOurs).slice(0, 8).join(' ') : '(none found)');
  console.log('  chromium:', arChr ? cps(arChr).slice(0, 8).join(' ') : '(none found)');
}

main().catch((e) => { console.error(e); process.exit(1); });
