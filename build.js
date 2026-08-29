/**
 * Build the distributable bundles.
 *
 * No bundler dependency: the sources are already self-contained classic scripts
 * that install `globalThis.__pdf_*`, so a bundle is an ordered concatenation.
 * Adding rollup or esbuild would buy minification and tree-shaking that this
 * code cannot use anyway — every module is pure side effect.
 *
 * Two outputs, because there are two ways people will consume this:
 *
 *   dist/garri.js    IIFE. Drop into a <script> tag; installs the globals.
 *   dist/garri.mjs   ES module. `import { render } from 'peedeeeff'`.
 *
 * The sources are deliberately NOT converted to ES modules. Every experiment in
 * this repo — the entire regression suite — loads them as classic scripts via
 * addScriptTag. Converting the sources would break all of it to gain nothing a
 * build step cannot provide. The .mjs wrapper reads the globals back out after
 * evaluation, which is a little impure and completely honest about what these
 * modules are.
 *
 *   node build.js
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');

/**
 * Load order matters: index.js asserts its dependencies are present, and
 * boxes.js needs paintOrder. Derived from which globals each module CONSUMES
 * rather than installs — see findings 18.
 */
const CORE = [
  'src/capture/paintOrder.js',
  'src/capture/textRuns.js',
  'src/capture/generated.js',
  'src/capture/paint.js',
  'src/capture/images.js',
  'src/capture/canvas.js',
  'src/capture/forms.js',
  'src/capture/links.js',
  'src/capture/svg.js',
  'src/pdf/svgPath.js',
  'src/pdf/emit.js',
  'src/text/fontRegistry.js',
  'src/pagination/furniture.js',
  'src/index.js',
];

/** Extractors with no emitter wired into the entry point. */
const EXTRA = [
  'src/capture/boxes.js',
];

/** Globals the ES module re-exports as named bindings. */
/** Vendored into the standalone build so one file is all a page needs. */
const VENDOR = [
  'node_modules/pdf-lib/dist/pdf-lib.min.js',
  'node_modules/@pdf-lib/fontkit/dist/fontkit.umd.min.js',
];

const EXPORTS = {
  render: '__pdf_render',
  extractTextRuns: '__pdf_extractTextRuns',
  materializeGenerated: '__pdf_materializeGenerated',
  FontRegistry: '__pdf_FontRegistry',
  furniture: '__pdf_furniture',
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function banner(kind, files) {
  return `/*! ${pkg.name} ${pkg.version} — ${kind}\n`
    + ` * ${pkg.description}\n`
    + ` * Requires pdf-lib and @pdf-lib/fontkit to be supplied by the caller.\n`
    + ` * Bundled modules: ${files.map((f) => path.basename(f)).join(', ')}\n`
    + ' */\n';
}

function concat(files) {
  return files.map((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    return `// ===== ${f} =====\n${src.trimEnd()}\n`;
  }).join('\n');
}

const kb = (s) => (s.length / 1024).toFixed(1);
const gz = (s) => (zlib.gzipSync(s).length / 1024).toFixed(1);

function main() {
  const full = process.argv.includes('--all');
  const files = full ? [...EXTRA, ...CORE] : CORE;

  for (const f of files) {
    if (!fs.existsSync(path.join(ROOT, f))) throw new Error(`missing source: ${f}`);
  }
  fs.mkdirSync(DIST, { recursive: true });

  const body = concat(files);

  // ---- IIFE: for a <script> tag ----------------------------------------
  const iife = `${banner('browser bundle (IIFE)', files)}(function () {\n'use strict';\n${body}\n})();\n`;
  fs.writeFileSync(path.join(DIST, 'garri.js'), iife);

  // ---- ESM: named exports, read back after evaluation -------------------
  const exportLines = Object.entries(EXPORTS)
    .map(([name, g]) => `export const ${name} = globalThis.${g};`)
    .join('\n');
  const esm = `${banner('ES module', files)}(function () {\n'use strict';\n${body}\n})();\n\n`
    + `${exportLines}\nexport default { ${Object.keys(EXPORTS).join(', ')} };\n`;
  fs.writeFileSync(path.join(DIST, 'garri.mjs'), esm);

  // ---- standalone: pdf-lib + fontkit + the pipeline, in one file --------
  const missing = VENDOR.filter((v) => !fs.existsSync(path.join(ROOT, v)));
  let standalone = null;
  if (missing.length) {
    console.log(`  standalone build SKIPPED, missing: ${missing.join(', ')}`);
  } else {
    const vendor = VENDOR.map((v) => `// ===== vendored: ${v} =====\n`
      + fs.readFileSync(path.join(ROOT, v), 'utf8').trimEnd() + '\n').join('\n');
    standalone = `${banner('standalone browser SDK (pdf-lib + fontkit included)', files)}`
      + `${vendor}\n(function () {\n'use strict';\n${body}\n})();\n`;
    fs.writeFileSync(path.join(DIST, 'garri.standalone.js'), standalone);
  }

  console.log(`built ${files.length} module(s)${full ? ' (--all)' : ''}\n`);
  console.log('  file'.padEnd(28), 'raw'.padStart(9), 'gzipped'.padStart(9));
  const outputs = [['dist/garri.js', iife], ['dist/garri.mjs', esm]];
  if (standalone) outputs.push(['dist/garri.standalone.js', standalone]);
  for (const [name, src] of outputs) {
    console.log(`  ${name}`.padEnd(28), `${kb(src)} KB`.padStart(9), `${gz(src)} KB`.padStart(9));
  }
  console.log('\n  peer dependencies the consumer must also load:');
  for (const [name, range] of Object.entries(pkg.peerDependencies || {})) {
    const p = path.join(ROOT, 'node_modules', name, 'package.json');
    const installed = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).version : '(not installed)';
    console.log(`    ${name.padEnd(22)} ${range.padEnd(10)} installed ${installed}`);
  }
}

main();
