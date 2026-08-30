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
/**
 * The same run with one embeddable face forced on BOTH sides, which separates
 * "does Garri reproduce the browser's layout" from "can Garri read the font".
 */
const fairPath = path.join(OUT, 'results-fair.json');
const fair = fs.existsSync(fairPath)
  ? Object.fromEntries(JSON.parse(fs.readFileSync(fairPath, 'utf8')).map((r) => [r.name, r]))
  : {};
const worstOf = (r) => {
  const v = (r.pageDiffs || []).map((p) => p.pct).filter((x) => x !== null);
  return v.length ? Math.max(...v) : null;
};

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
P(`| Demo | Chromium | Garri | Pages | Worst diff | …with an embeddable font | Time |`);
P('| --- | ---: | ---: | :---: | ---: | ---: | ---: |');
for (const r of results) {
  if (r.failed) {
    P(`| [${r.name}](${SRC}/${r.name}.html) | — | — | ❌ | — | — | failed |`);
    continue;
  }
  const w = r.pageDiffs.map((p) => p.pct).filter((v) => v !== null);
  const same = r.truth.length === r.ours.length;
  const fw = fair[r.name] ? worstOf(fair[r.name]) : null;
  P(`| [${r.name}](${SRC}/${r.name}.html) | ${r.truth.length} | ${r.ours.length} `
    + `| ${same ? '✅' : '⚠️'} | ${w.length ? pct(Math.max(...w)) : '—'} `
    + `| ${fw === null ? '—' : pct(fw)} | ${r.meta.ms} ms |`);
}
P();
{
  const fairAll = Object.values(fair).flatMap((r) => (r.pageDiffs || []).map((p) => p.pct))
    .filter((v) => v !== null).sort((a, b) => a - b);
  if (fairAll.length) {
    P();
    P('The last column re-runs each document with **one embeddable font forced on both');
    P('sides**. That separates two things the raw number conflates: whether Garri');
    P('reproduces the layout the browser produced, and whether it could read the font');
    P('at all. Across every page:');
    P();
    P('| | Worst | Median | Mean |');
    P('| --- | ---: | ---: | ---: |');
    const m = (v) => v[Math.floor(v.length / 2)];
    const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
    const raw = worstAll.slice().sort((a, b) => a - b);
    P(`| As authored | ${pct(Math.max(...raw))} | ${pct(m(raw))} | ${pct(mean(raw))} |`);
    P(`| Embeddable font | ${pct(Math.max(...fairAll))} | ${pct(m(fairAll))} | ${pct(mean(fairAll))} |`);
    P();
    // Computed, not asserted: a hard-coded "roughly half" is a number that
    // goes stale the first time either side moves.
    const drop = 1 - mean(fairAll) / mean(raw);
    P(`**Forcing an embeddable face removes ${(drop * 100).toFixed(0)} % of the mean difference.**`);
    P('That share is font substitution rather than rendering. What is left is the');
    P('honest residue: sub-pixel placement, glyph rasterisation, and the handful of');
    P('features listed below.');
  }
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
P('**`@page { size: A4 }` was not understood.** The size parser only handled the');
P('explicit `210mm 297mm` form. Not one of these ten documents uses it — every one');
P('says `size: A4` — so every one silently fell back to a guessed default.');
P('`demo-agent-slides` is `A4 landscape` and was rendered portrait; `margin: 0`');
P('parsed as nothing and became a 20mm margin. The parser now handles the named');
P('sizes from css-page-3, `landscape`/`portrait`, every absolute unit, and the');
P('1-to-4 value margin shorthand including a unitless zero.');
P();
P('**One column height cannot express two page geometries.** `demo-kaku` has a');
P('`.cover` exactly 297mm tall that fits page one only because');
P('`@page:first { margin: 0 }` removes the margins. A multicolumn container has a');
P('single column height, so fragmenting the run at the typical page height split');
P('the cover in two and made the document a page longer; fragmenting it all at the');
P('first page\'s height made every column 8.7% taller and lost a page instead.');
P('Neither is a rounding error — they are the same structural limit from opposite');
P('sides. The first page is now fragmented in its own pass when its geometry');
P('differs and its content ends on a clean element boundary; when it does not,');
P('`PDF_FIRST_PAGE_GEOMETRY_UNUSED` says so rather than quietly being off by one.');
P();
P('**`text-transform` was ignored.** A Range walk reports the DOM text while the');
P('rects it measures belong to the *transformed* glyphs, so a heading styled');
P('`text-transform: uppercase` was drawn lowercase at uppercase positions —');
P('Chromium extracted `PRODUCTBRIEF`, Garri `ProductBrief`. Eight of these ten');
P('documents use it. Now applied per character, so indices still line up with the');
P('probes.');
P();
P('**An element whose only paint was a shadow never reached the emitter.**');
P('`extractPaint` pushed an item only if it had a background, border, gradient or');
P('clip — `shadow` was missing from that list, so shadows silently vanished from');
P('documents that had them.');
P();
P('**The page background was never painted.** `extractPaint` walks');
P('`root.querySelectorAll("*")`, which never includes the root itself, so a');
P('document setting `html, body { background: … }` came out on white. The root');
P('background propagates to the canvas in CSS, so it now fills each page first.');
P();
P('**And one thing that is not a bug.** `demo-mole` is the worst page here at');
P('16.74 %, and none of it is misplacement: matching every uniquely identifiable');
P('string between the two PDFs gives a median Δx of **&minus;0.10 pt** and Δy of');
P('**&minus;0.20 pt**. What differs is glyph *width* — median &minus;1.90 pt,');
P('consistently narrower. The document asks for');
P('`Charter, Georgia, Palatino, "Times New Roman", serif` with no `@font-face`:');
P('all system fonts, whose bytes a page cannot read, so Chromium draws the real');
P('system serif and Garri substitutes Times-Roman. Re-running the same document');
P('with a font that *can* be embedded takes it from **16.74 % to 1.32 %** with no');
P('diagnostics at all. This is the documented limit, not a defect, and it is the');
P('single largest contributor to pixel difference across every demo here.');
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
  // The forced-font run produces its own PDFs and page images. They back the
  // last column of the summary table, so link them rather than leave a pile of
  // committed artefacts nothing points at.
  if (fair[r.name] && !fair[r.name].failed) {
    const f = fair[r.name];
    const imgs = (f.pageDiffs || []).filter((p) => p.diffImg)
      .map((p) => `[p${p.page} diff](out/${p.diffImg})`).join(' · ');
    P(`*Embeddable font forced on both sides:* `
      + `[Chromium PDF](out/${r.name}-fair-chromium.pdf) · `
      + `[Garri PDF](out/${r.name}-fair-garri.pdf)`
      + (imgs ? ` · ${imgs}` : ''));
    P();
  }
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
