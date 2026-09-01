/**
 * Build the distributable bundles.
 *
 * No bundler dependency: the sources are already self-contained classic scripts
 * that install `globalThis.__pdf_*`, so a bundle is an ordered concatenation.
 * Adding rollup or esbuild would buy minification and tree-shaking that this
 * code cannot use anyway — every module is pure side effect.
 *
 * Four outputs cover the package's supported loading paths:
 *
 *   dist/garri.js             browser IIFE with peer dependencies supplied
 *   dist/garri.mjs            ES module
 *   dist/garri.cjs            CommonJS module
 *   dist/garri.standalone.js  browser IIFE with PDF dependencies included
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
 * boxes.js needs paintOrder. The order is derived from which globals each
 * module consumes rather than installs.
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
  'src/text/sfnt.js',
  'src/text/fontRegistry.js',
  'src/pagination/furniture.js',
  'src/index.js',
];

/** Extractors with no emitter wired into the entry point. */
const EXTRA = [
  'src/capture/boxes.js',
];

/**
 * Named ES exports. This list is asserted against the runtime API surface
 * after the bundle is written.
 */
/** Vendored into the standalone build so one file is all a page needs. */
const VENDOR = [
  'node_modules/pdf-lib/dist/pdf-lib.min.js',
  // fontkit's complex-script shaper is transpiled with generators. Latin text
  // never reaches that code path, which let the missing runtime hide until a
  // standalone consumer rendered Arabic, Hebrew or Devanagari.
  'node_modules/regenerator-runtime/runtime.js',
  'node_modules/@pdf-lib/fontkit/dist/fontkit.umd.min.js',
];

const EXPORTS = [
  'render', 'renderToBlob', 'download', 'open',
  'discoverFonts', 'unhandledContent',
  'extractTextRuns', 'materializeGenerated', 'extractMarkers', 'FontRegistry', 'furniture', 'emit',
  'version',
];

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

async function main() {
  const full = process.argv.includes('--all');
  const files = full ? [...EXTRA, ...CORE] : CORE;

  for (const f of files) {
    if (!fs.existsSync(path.join(ROOT, f))) throw new Error(`missing source: ${f}`);
  }
  fs.mkdirSync(DIST, { recursive: true });

  // Types travel with the bundles: `types` in package.json points at
  // dist/garri.d.ts, and TypeScript also finds garri.mjs -> garri.d.mts.
  const dts = fs.readFileSync(path.join(ROOT, 'src', 'index.d.ts'), 'utf8');
  for (const name of ['garri.d.ts', 'garri.d.mts', 'garri.d.cts']) {
    fs.writeFileSync(path.join(DIST, name), dts);
  }

  const body = concat(files);

  // ---- IIFE: for a <script> tag ----------------------------------------
  const iife = `${banner('browser bundle (IIFE)', files)}(function () {\n'use strict';\n${body}\n})();\n`;
  fs.writeFileSync(path.join(DIST, 'garri.js'), iife);

  // ---- CJS: same bundle, exporting the API object -----------------------
  // Must be .cjs — package.json sets type=module, so Node parses a .js file as
  // ESM and `module.exports` would be a ReferenceError.
  const cjs = `${banner('CommonJS bundle', files)}(function () {\n'use strict';\n${body}\n})();\n\n`
    + 'module.exports = globalThis.Garri;\n';
  fs.writeFileSync(path.join(DIST, 'garri.cjs'), cjs);

  // ---- ESM: named exports, read back after evaluation -------------------
  // `open` is a reserved-ish name in some tooling, so bind through the API
  // object rather than emitting `export const open = globalThis.open`.
  const exportLines = EXPORTS
    .map((name) => `export const ${name} = /* @__PURE__ */ __api[${JSON.stringify(name)}];`)
    .join('\n');
  const esm = `${banner('ES module', files)}(function () {\n'use strict';\n${body}\n})();\n\n`
    + 'const __api = globalThis.Garri;\n'
    + `${exportLines}\nexport default __api;\n`;
  fs.writeFileSync(path.join(DIST, 'garri.mjs'), esm);

  // ---- standalone: pdf-lib + fontkit + the pipeline, in one file --------
  const missing = VENDOR.filter((v) => !fs.existsSync(path.join(ROOT, v)));
  if (missing.length) {
    throw new Error(`cannot build standalone bundle; missing: ${missing.join(', ')}`);
  }
  const vendor = VENDOR.map((v) => `// ===== vendored: ${v} =====\n`
    + fs.readFileSync(path.join(ROOT, v), 'utf8').trimEnd() + '\n').join('\n');
  const standalone = `${banner('standalone browser SDK (pdf-lib + fontkit included)', files)}`
    + `${vendor}\n(function () {\n'use strict';\n${body}\n})();\n`;
  fs.writeFileSync(path.join(DIST, 'garri.standalone.js'), standalone);

  console.log(`built ${files.length} module(s)${full ? ' (--all)' : ''}\n`);
  console.log('  file'.padEnd(28), 'raw'.padStart(9), 'gzipped'.padStart(9));
  const outputs = [
    ['dist/garri.js', iife], ['dist/garri.mjs', esm], ['dist/garri.cjs', cjs],
    ['dist/garri.standalone.js', standalone],
  ];
  for (const [name, src] of outputs) {
    console.log(`  ${name}`.padEnd(28), `${kb(src)} KB`.padStart(9), `${gz(src)} KB`.padStart(9));
  }
  // ---- assert the public surfaces agree --------------------------------
  const mod = await import(`./dist/garri.mjs?v=${files.length}-${iife.length}`);
  const exported = Object.keys(mod).filter((k) => k !== 'default').sort();
  const surface = Object.keys(mod.default || {}).sort();
  const notExported = surface.filter((k) => !exported.includes(k));
  const notOnApi = exported.filter((k) => !surface.includes(k));
  if (notExported.length || notOnApi.length) {
    console.error('\n  SURFACE MISMATCH — the build is wrong, not the consumer:');
    if (notExported.length) console.error(`    on the API but not exported : ${notExported.join(', ')}`);
    if (notOnApi.length) console.error(`    exported but not on the API : ${notOnApi.join(', ')}`);
    process.exit(1);
  }
  const undef = exported.filter((k) => mod[k] === undefined);
  if (undef.length) {
    console.error(`\n  EXPORTS RESOLVED TO undefined: ${undef.join(', ')}`);
    process.exit(1);
  }
  const { createRequire } = await import('node:module');
  const cjsApi = createRequire(import.meta.url)('./dist/garri.cjs');
  const cjsKeys = Object.keys(cjsApi).sort();
  if (JSON.stringify(cjsKeys) !== JSON.stringify(surface)) {
    console.error(`\n  CJS SURFACE MISMATCH: ${cjsKeys.join(', ')}`);
    process.exit(1);
  }
  console.log(`  public surface: ${exported.length} exports — ESM, CJS and global all agree`);

  console.log('\n  peer dependencies the consumer must also load:');
  for (const [name, range] of Object.entries(pkg.peerDependencies || {})) {
    const p = path.join(ROOT, 'node_modules', name, 'package.json');
    const installed = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).version : '(not installed)';
    console.log(`    ${name.padEnd(22)} ${range.padEnd(10)} installed ${installed}`);
  }
}

await main();
