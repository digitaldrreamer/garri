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
 * The same run with matching embeddable font families forced on both sides,
 * separating layout reproduction from font availability.
 */
const fairPath = path.join(OUT, 'results-fair.json');
const fair = fs.existsSync(fairPath)
  ? Object.fromEntries(JSON.parse(fs.readFileSync(fairPath, 'utf8')).map((r) => [r.name, r]))
  : {};
const worstOf = (r) => {
  const v = (r.pageDiffs || []).map((p) => p.pct).filter((x) => x !== null);
  return v.length ? Math.max(...v) : null;
};

const pct = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(2)} %`);

const lines = [];
const P = (s = '') => lines.push(s);

P('# Garri vs Chromium — Kami demo documents');
P();
P('Comparison of Chromium vs Garri when tested on native PDF generation of');
P('[Kami demo documents](https://github.com/tw93/Kami/tree/main/assets/demos).');
P();
P("For each demo, the same page in the same browser produces two PDFs: Chromium's");
P("own `printToPDF` and Garri's. They are rasterised at 110 dpi and compared pixel");
P('by pixel. Generated PDFs, page images, and red/blue diff images are written to');
P('the ignored `kami/out/` directory.');
P();
P('Reproduction requires Node.js 22.13 or newer, Chrome, `pdftoppm`, `curl`,');
P('and the GitHub CLI (`gh`). Then run:');
P();
P('```bash');
P('npm install');
P('npm run build');
P('sh kami/fetch-assets.sh');
P('node experiments/kami-compare.js');
P('node experiments/kami-compare.js --fair-fonts');
P('node experiments/kami-report.js');
P('```');
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
    P('The last column re-runs each document with the same embeddable Latin, CJK, and');
    P('Korean font families forced on both sides. That separates layout reproduction');
    P('from font availability and glyph substitution. Across every page:');
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
    P('The remaining difference includes sub-pixel placement, glyph rasterisation,');
    P('and unsupported features.');
    P();
    const tints = results.flatMap((r) => (r.pageDiffs || []).map((p) => p.tint))
      .filter((v) => v !== null && v !== undefined);
    if (tints.length) {
      P('The headline difference counts pixels whose worst colour channel differs by');
      P('more than **32**/255, avoiding noise from antialiasing. The generated result');
      P('also records a **2**/255 threshold for inspecting broad, low-contrast changes;');
      P(`the worst page measures ${pct(Math.max(...tints))} at that threshold.`);
    }
  }
}
P();
P(`**${pagesMatch} of ${results.length}** demos paginate to exactly the same page count as`);
P(`Chromium. Worst single page difference across all of them: `
  + `**${pct(Math.max(...worstAll))}**; median `
  + `**${pct(worstAll.sort((a, b) => a - b)[Math.floor(worstAll.length / 2)])}**.`);
P();

fs.writeFileSync(path.join(ROOT, 'COMPARISON.md'), lines.join('\n'));
console.log(`wrote COMPARISON.md (${lines.length} lines)`);
