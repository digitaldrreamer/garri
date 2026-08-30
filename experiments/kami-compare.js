/**
 * Garri against Kami's demo documents.
 *
 * Every fixture in this repo so far was written by us, to probe one mechanism.
 * These are third-party documents written by someone else for their own tool,
 * which makes them the first real test of whether any of this survives contact
 * with a document we did not design.
 *
 * For each demo: Chromium's own printToPDF, then Garri, then both rasterised
 * and diffed page by page.
 *
 *   node experiments/kami-compare.js
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KAMI = path.join(ROOT, 'kami');
const OUT = path.join(KAMI, 'out');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
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

const dense = (s) => s.replace(/\s+/g, '');

/** Every artefact of a --fair-fonts run is suffixed, so the two runs coexist
 *  and the document's PDF links match the images beside them. */
const FAIR = process.argv.includes('--fair-fonts');
const SFX = FAIR ? '-fair' : '';

/** Rasterise one page of a PDF at 110dpi. */
function raster(pdf, outPrefix, page) {
  try {
    execFileSync('pdftoppm', ['-r', '110', '-f', String(page), '-l', String(page),
      '-png', pdf, outPrefix], { stdio: 'ignore' });
  } catch { return null; }
  const dir = path.dirname(outPrefix), base = path.basename(outPrefix);
  const hit = fs.readdirSync(dir).find((f) => f.startsWith(base) && f.endsWith('.png'));
  return hit ? path.join(dir, hit) : null;
}

/** Worst-of-three-channel diff, via the existing dependency-free comparer. */
function diff(a, b, out) {
  try {
    const txt = execFileSync('python3', [path.join(ROOT, 'experiments', 'pngdiff.py'), a, b, out],
      { encoding: 'utf8' });
    const m = txt.match(/pixels differing >32\/255\s*:\s*(\d+)\s*\(([\d.]+)%\)/);
    // `tint` is the low threshold: a large area off by a small amount, which
    // `pct` is blind to and which is exactly what a wrong page background is.
    const t = txt.match(/pixels differing\s+>2\/255\s*:\s*(\d+)\s*\(([\d.]+)%\)/);
    const mean = txt.match(/mean abs diff\s*:\s*([\d.]+)/);
    return m ? {
      pct: parseFloat(m[2]),
      tint: t ? parseFloat(t[2]) : null,
      mean: mean ? parseFloat(mean[1]) : null,
    } : null;
  } catch { return null; }
}

async function pdfPages(pdfjs, bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const vp = pg.getViewport({ scale: 1 });
    const tc = await pg.getTextContent();
    pages.push({
      w: vp.width, h: vp.height,
      text: dense(tc.items.map((t) => t.str).join('')),
      annots: (await pg.getAnnotations()).length,
    });
  }
  return pages;
}

async function runDemo(browser, base, rootBase, pdfjs, name) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 794, height: 1123 });   // A4 at 96dpi

  const result = { name, errors };
  try {
    await page.goto(`${base}/demos/${name}.html`, { waitUntil: 'networkidle0', timeout: 45000 });
  } catch (e) {
    result.failed = `navigation: ${e.message}`;
    await page.close();
    return result;
  }
  // --fair-fonts forces one embeddable face on BOTH sides, isolating "does
  // Garri reproduce what the browser laid out" from "can Garri read the font's
  // bytes at all". Layout changes, but it changes identically for both.
  if (FAIR) {
    // The stack has to COVER the document, not just replace its Latin. Forcing
    // a Latin-only face on a Chinese or Korean document left Chromium falling
    // back to a system CJK font while Garri — whose fallback is restricted to
    // declared families — had nothing and dropped the text: demo-resume-ko
    // extracted 636 characters against Chromium's 2351. The two sides were not
    // rendering the same document, so the number meant nothing. These three
    // faces are all embeddable, so both engines can use all of them.
    await page.addStyleTag({ content:
      `@font-face{font-family:"FairSub";src:url("${rootBase}/fixtures/Tinos-Regular.ttf") format("truetype");}`
      + `@font-face{font-family:"FairCJK";src:url("${rootBase}/kami/fonts/TsangerJinKai02-W04.ttf") format("truetype");}`
      + `@font-face{font-family:"FairKR";src:url("${rootBase}/kami/fonts/SourceHanSerifKR-Regular.otf") format("opentype");}`
      + '*{font-family:"FairSub","FairCJK","FairKR",serif !important;}' });
  }
  await page.evaluate(() => document.fonts.ready).catch(() => {});

  // ---- Chromium's own answer, before anything is touched
  const truthBytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  fs.writeFileSync(path.join(OUT, `${name}${SFX}-chromium.pdf`), truthBytes);
  result.truth = await pdfPages(pdfjs, truthBytes);

  // ---- Garri, entirely in the page
  await page.addScriptTag({ url: `${rootBase}/dist/garri.standalone.js` });
  const ours = await page.evaluate(async () => {
    try {
      const t = performance.now();
      const r = await globalThis.Garri.render(document.body);
      return {
        ok: true,
        // base64, not Array.from: a multi-megabyte PDF as a JSON array of
        // numbers takes minutes to cross the CDP boundary.
        b64: (() => { let s2 = ''; const u = r.bytes;
          for (let i = 0; i < u.length; i += 0x8000) s2 += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
          return btoa(s2); })(),
        pages: r.pages,
        ms: Math.round(performance.now() - t),
        diagnostics: r.diagnostics.map((d) => ({ code: d.code, count: d.count, message: d.message })),
        emitted: r.stats.emitted,
        fonts: globalThis.Garri.discoverFonts().map((f) => f.family),
      };
    } catch (e) {
      return { ok: false, error: e.message, stack: String(e.stack).split('\n').slice(0, 3).join(' | ') };
    }
  });
  await page.close();

  if (!ours.ok) { result.failed = ours.error; result.stack = ours.stack; return result; }

  const bytes = Buffer.from(ours.b64, 'base64');
  fs.writeFileSync(path.join(OUT, `${name}${SFX}-garri.pdf`), bytes);
  result.ours = await pdfPages(pdfjs, bytes);
  result.meta = {
    ms: ours.ms, bytes: bytes.byteLength, truthBytes: truthBytes.byteLength,
    diagnostics: ours.diagnostics, emitted: ours.emitted, fonts: ours.fonts,
  };

  // ---- rasterise and diff, page by page
  result.pageDiffs = [];
  const n = Math.min(result.truth.length, result.ours.length);
  for (let i = 1; i <= n; i++) {
    const a = raster(path.join(OUT, `${name}${SFX}-chromium.pdf`), path.join(OUT, `${name}${SFX}-p${i}-chromium`), i);
    const b = raster(path.join(OUT, `${name}${SFX}-garri.pdf`), path.join(OUT, `${name}${SFX}-p${i}-garri`), i);
    // One path, used both to write the file and to record it: a hand-built
    // second copy of the name is how the fair run came to record the
    // as-authored diff images.
    const diffPath = path.join(OUT, `${name}${SFX}-p${i}-diff.png`);
    const d = (a && b) ? diff(a, b, diffPath) : null;
    result.pageDiffs.push({
      page: i, a: a && path.basename(a), b: b && path.basename(b),
      diffImg: d ? path.basename(diffPath) : null,
      pct: d ? d.pct : null, tint: d ? d.tint : null, mean: d ? d.mean : null,
      textExact: result.truth[i - 1].text === result.ours[i - 1].text,
      truthChars: result.truth[i - 1].text.length,
      ourChars: result.ours[i - 1].text.length,
    });
  }
  return result;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { server, port } = await serve(ROOT);
  // The server roots at the repo, so demos resolve under /kami and the built
  // bundle under /dist.
  const rootBase = `http://127.0.0.1:${port}`;
  // Kami's CJK fonts are 18MB each; fontkit parsing and subsetting one takes
  // long enough to blow the default 30s CDP timeout.
  const browser = await puppeteer.launch({ headless: true, protocolTimeout: 600000 });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const names = fs.readdirSync(path.join(KAMI, 'demos'))
    .filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, '')).sort();

  const all = [];
  for (const n of names) {
    process.stdout.write(`  ${n.padEnd(24)}`);
    const r = await runDemo(browser, `${rootBase}/kami`, rootBase, pdfjs, n);
    if (r.failed) console.log(`FAILED — ${r.failed}`);
    else {
      const worst = r.pageDiffs.length ? Math.max(...r.pageDiffs.map((p) => p.pct ?? 0)) : null;
      console.log(`chromium ${String(r.truth.length).padStart(2)}p  garri ${String(r.ours.length).padStart(2)}p  `
        + `worst diff ${worst === null ? '  n/a' : worst.toFixed(2) + '%'}  ${r.meta.ms}ms`);
    }
    all.push(r);
  }

  await browser.close();
  server.close();
  const tag = FAIR ? 'results-fair.json' : 'results.json';
  fs.writeFileSync(path.join(OUT, tag), JSON.stringify(all, null, 2));
  console.log(`\nraw -> kami/out/${tag}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
