/**
 * Turn kami/out/results.json into a readable comparison document.
 *
 *   node experiments/kami-report.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KAMI = path.join(ROOT, 'kami');
const OUT = path.join(KAMI, 'out');
const SRC = 'https://github.com/tw93/Kami/blob/main/assets/demos';

const results = JSON.parse(fs.readFileSync(path.join(OUT, 'results.json'), 'utf8'));

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const pct = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(2)} %`);

/** What each demo leans on, read from its own source. */
function features(name) {
  const src = fs.readFileSync(path.join(KAMI, 'demos', `${name}.html`), 'utf8');
  const has = [];
  const add = (re, label) => { if (re.test(src)) has.push(label); };
  add(/@font-face/, '`@font-face`');
  add(/@page/, '`@page`');
  add(/@media\s+print/, '`@media print`');
  add(/<svg/i, 'SVG');
  add(/<img/i, 'images');
  add(/gradient\(/, 'gradients');
  add(/box-shadow\s*:(?!\s*none)/, '`box-shadow`');
  add(/display\s*:\s*grid/, 'grid');
  add(/display\s*:\s*flex/, 'flex');
  add(/position\s*:\s*(fixed|absolute)/, 'positioned');
  add(/<table/i, 'tables');
  add(/break-(before|after|inside)/, 'break-*');
  add(/counter\(/, 'counters');
  add(/[぀-ヿ一-鿿가-힯]/, 'CJK');
  return has;
}

const lines = [];
const P = (s = '') => lines.push(s);

P('# Garri vs Chromium — Kami demo documents');
P();
P('Every fixture in this repository was written by us, to probe one mechanism at');
P('a time. These ten are not: they are the demo documents from');
P('[tw93/Kami](https://github.com/tw93/Kami/tree/main/assets/demos), written by');
P('someone else for their own tool. They are the first test of whether any of');
P('this survives a document we did not design.');
P();
P('For each demo, the same page in the same browser produces two PDFs —');
P("Chromium's own `printToPDF` and Garri's — which are then rasterised at 110 dpi");
P('and compared pixel by pixel. The diff images mark **red where only Chromium');
P('put ink** and **blue where only Garri did**.');
P();
P('Reproduce with `node experiments/kami-compare.js && node experiments/kami-report.js`.');
P();

// ---------------------------------------------------------------- summary --
const ok = results.filter((r) => !r.failed);
const pagesMatch = ok.filter((r) => r.truth.length === r.ours.length).length;
const worstAll = ok.flatMap((r) => r.pageDiffs.map((p) => p.pct)).filter((v) => v !== null);

P('## Summary');
P();
P(`| Demo | Chromium | Garri | Pages | Worst page diff | Garri time | Size |`);
P('| --- | ---: | ---: | :---: | ---: | ---: | ---: |');
for (const r of results) {
  if (r.failed) {
    P(`| [${r.name}](${SRC}/${r.name}.html) | — | — | ❌ | — | — | failed |`);
    continue;
  }
  const w = r.pageDiffs.map((p) => p.pct).filter((v) => v !== null);
  const same = r.truth.length === r.ours.length;
  P(`| [${r.name}](${SRC}/${r.name}.html) | ${r.truth.length} | ${r.ours.length} `
    + `| ${same ? '✅' : '⚠️'} | ${w.length ? pct(Math.max(...w)) : '—'} `
    + `| ${r.meta.ms} ms | ${kb(r.meta.bytes)} |`);
}
P();
P(`**${pagesMatch} of ${results.length}** demos paginate to exactly the same page count as`);
P(`Chromium. Worst single page difference across all of them: `
  + `**${pct(Math.max(...worstAll))}**; median `
  + `**${pct(worstAll.sort((a, b) => a - b)[Math.floor(worstAll.length / 2)])}**.`);
P();

// -------------------------------------------------------------- per demo ---
P('## What this exercise found');
P();
P('Running against documents we did not write surfaced four defects that every');
P('synthetic fixture had missed. Three are fixed; the fourth is inherent.');
P();
P('**Fragmentation was defeated by `max-width`.** Real documents routinely carry');
P('`@media screen { body { max-width: 210mm; padding: 25mm } }`. Garri reads the');
P('*screen* layout, so that clamped the container it widens to fragment: it stayed');
P('794px instead of the 14,536px asked for, making the derived column pitch **33px');
P('instead of 606px**. Every line landed in a different column — `demo-resume-ko`');
P('came out as 43 pages against Chromium\'s 2, `demo-mole` 20 against 1. The');
P('container is being repurposed, so its author box constraints are now');
P('neutralised, and `PDF_CONTAINER_CLAMPED` fires if anything still clamps it.');
P();
P('**WOFF2 hung the renderer forever.** pdf-lib\'s subsetter never returns on a');
P('WOFF2 face — not slowly, permanently. Subsetting is Garri\'s default and WOFF2 is');
P('what most sites serve, so this would have hung on the majority of real');
P('documents. It was invisible to every fixture here because they all use a TTF.');
P('Compressed faces are now embedded whole, with `PDF_FONT_NOT_SUBSET` naming the');
P('size cost.');
P();
P('**One CJK character killed the whole document.** When a font has no embeddable');
P('bytes Garri substitutes a standard PDF font, and those are WinAnsi-only, so');
P('pdf-lib *throws* rather than dropping the glyph. `demo-tesla` failed entirely on');
P('a single `特`. Unencodable text is now skipped with `PDF_TEXT_NOT_ENCODABLE`.');
P();
P('**Same characters, different order.** Several demos extract the same character');
P('count as Chromium but not the same sequence — Garri emits paint, then flow, then');
P('furniture, while Chromium interleaves in document order. The content is all');
P('there; the reading order a copy-paste produces can differ.');
P();
P('---');
P();
for (const r of results) {
  P(`## ${r.name}`);
  P();
  P(`[Source HTML](${SRC}/${r.name}.html) · `
    + `[local copy](demos/${r.name}.html) · `
    + `[Chromium PDF](out/${r.name}-chromium.pdf) · `
    + `[Garri PDF](out/${r.name}-garri.pdf)`);
  P();
  P(`**Uses:** ${features(r.name).join(' · ')}`);
  P();

  if (r.failed) {
    P(`> **Failed:** \`${r.failed}\``);
    if (r.stack) P(`>`), P(`> \`${r.stack}\``);
    P();
    continue;
  }

  P(`| | Chromium | Garri | Diff |`);
  P('| --- | --- | --- | --- |');
  for (const p of r.pageDiffs) {
    const a = p.a ? `<img src="out/${p.a}" width="240">` : '—';
    const b = p.b ? `<img src="out/${p.b}" width="240">` : '—';
    const d = p.diffImg ? `<img src="out/${p.diffImg}" width="240">` : '—';
    P(`| **p${p.page}**<br>${pct(p.pct)} | ${a} | ${b} | ${d} |`);
  }
  if (r.ours.length > r.truth.length) {
    P();
    P(`> Garri produced ${r.ours.length} pages to Chromium's ${r.truth.length}; `
      + 'only the pages both have are compared above.');
  }
  P();

  const e = r.meta.emitted || {};
  const parts = Object.entries(e).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`);
  P(`**Emitted:** ${parts.length ? parts.join(' · ') : 'text only'}`);
  P();
  P(`**Text extraction:** `
    + `${r.pageDiffs.filter((p) => p.textExact).length}/${r.pageDiffs.length} pages character-exact `
    + `(Chromium ${r.truth.reduce((s, p) => s + p.text.length, 0)} chars, `
    + `Garri ${r.ours.reduce((s, p) => s + p.text.length, 0)})`);
  P();
  if (r.meta.diagnostics.length) {
    P('<details><summary>Diagnostics</summary>');
    P();
    for (const d of r.meta.diagnostics) {
      P(`- \`${d.code}\`${d.count > 1 ? ` ×${d.count}` : ''} — ${d.message}`);
    }
    P();
    P('</details>');
    P();
  }
  P('---');
  P();
}

fs.writeFileSync(path.join(KAMI, 'COMPARISON.md'), lines.join('\n'));
console.log(`wrote kami/COMPARISON.md (${lines.length} lines)`);
