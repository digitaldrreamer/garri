/**
 * PeeDeeEff — entry point.
 *
 * Everything before this file was an extractor validated in isolation against
 * Chromium's own `printToPDF`. Nothing assembled them: every experiment wired
 * the pipeline by hand, which is why there was no library, only mechanisms.
 *
 * This is the seam. One call takes a DOM subtree and returns PDF bytes.
 *
 *   const { bytes, pages, diagnostics } =
 *     await __pdf_render(document.body, { pdfLib: PDFLib, fontkit, fonts: [...] });
 *
 * Two deliberate constraints:
 *
 * 1. `pdf-lib` and `fontkit` are INJECTED, not imported. These sources are
 *    loaded into a page as classic scripts (that is how every experiment, and
 *    therefore the whole regression suite, consumes them). Importing would
 *    force a module system on the extractors before there is a build step.
 *
 * 2. It renders what there are EMITTERS for, and says so about the rest.
 *    `src/` holds extractors for boxes, paint, images, links and SVG, but the
 *    code that writes those into a PDF still lives in the experiments. Emitting
 *    text while silently dropping a background would be worse than refusing, so
 *    unhandled content is reported as a diagnostic rather than ignored.
 *
 * Installs globalThis.__pdf_render.
 */
(function () {
  const PT = 72 / 96;
  const mmToPx = (mm) => (mm / 25.4) * 96;

  const DEFAULT_PAGE = { widthMm: 210, heightMm: 297, marginMm: 20 };

  /** Modules this entry point drives, and the global each installs. */
  const REQUIRED = {
    __pdf_extractTextRuns: 'src/capture/textRuns.js',
    __pdf_furniture: 'src/pagination/furniture.js',
    __pdf_materializeGenerated: 'src/capture/generated.js',
    __pdf_FontRegistry: 'src/text/fontRegistry.js',
  };

  function assertEnvironment(opts) {
    const missing = Object.keys(REQUIRED).filter((k) => typeof globalThis[k] === 'undefined');
    if (missing.length) {
      throw new Error(
        `PDF_MODULE_UNAVAILABLE: load ${missing.map((m) => REQUIRED[m]).join(', ')} before calling __pdf_render`);
    }
    if (!opts.pdfLib || !opts.pdfLib.PDFDocument) {
      throw new Error('PDF_DEPENDENCY_UNAVAILABLE: pdf-lib was not found. Use the standalone '
        + 'build, or pass options.pdfLib.');
    }
    if (!opts.fontkit) {
      throw new Error('PDF_DEPENDENCY_UNAVAILABLE: @pdf-lib/fontkit was not found. Use the '
        + 'standalone build, or pass options.fontkit.');
    }
    // No @font-face and no explicit list is NOT fatal: the page is probably
    // using system fonts, whose bytes cannot be read. Those fall back to the
    // PDF standard fonts, which every reader already has.
  }

  /** Page geometry in CSS px, from a parsed @page rule or the caller's override. */
  function geometryOf(rule, override) {
    const size = String((rule && rule.size) || '').match(/([\d.]+)mm\s+([\d.]+)mm/);
    const marg = String((rule && rule.margin) || '').match(/([\d.]+)mm(?:\s+([\d.]+)mm)?/);

    const wMm = override?.widthMm ?? (size ? +size[1] : DEFAULT_PAGE.widthMm);
    const hMm = override?.heightMm ?? (size ? +size[2] : DEFAULT_PAGE.heightMm);
    const mV = override?.marginMm ?? (marg ? +marg[1] : DEFAULT_PAGE.marginMm);
    const mH = override?.marginMm ?? (marg && marg[2] !== undefined ? +marg[2] : mV);

    const w = mmToPx(wMm), h = mmToPx(hMm);
    const mTop = Math.round(mmToPx(mV)), mLeft = Math.round(mmToPx(mH));
    return {
      w, h,
      mTop, mBottom: mTop, mLeft, mRight: mLeft,
      contentW: w - 2 * mLeft,
      contentH: h - 2 * mTop,
      // PDF page box, in points
      ptW: w * PT, ptH: h * PT,
    };
  }

  /**
   * Content this pipeline can extract but cannot yet WRITE.
   * Reported rather than dropped: a renderer that silently omits a background
   * is more dangerous than one that refuses to pretend.
   */
  function unhandledContent(root, hasEmitters = !!globalThis.__pdf_emit) {
    const found = new Map();
    const note = (code, el) => {
      if (!found.has(code)) found.set(code, { code, count: 0, first: null });
      const e = found.get(code);
      e.count += 1;
      if (!e.first) e.first = el.id ? `#${el.id}` : el.tagName.toLowerCase();
    };
    const TRANSPARENT = /^(rgba\(0,\s*0,\s*0,\s*0\)|transparent)$/;

    for (const el of root.querySelectorAll('*')) {
      const tag = el.tagName.toLowerCase();
      const cs = getComputedStyle(el);
      if (cs.filter && cs.filter !== 'none') note('PDF_FILTER_NOT_EMITTED', el);

      // The rest are emitted when src/pdf/emit.js is loaded — the small bundle
      // omits it, and then these are real omissions worth reporting.
      if (hasEmitters) continue;
      if (tag === 'canvas') note('PDF_CANVAS_NOT_EMITTED', el);
      if (tag === 'input' || tag === 'textarea' || tag === 'select') note('PDF_FORM_NOT_EMITTED', el);
      if (cs.boxShadow && cs.boxShadow !== 'none') note('PDF_SHADOW_NOT_EMITTED', el);
      if (tag === 'img') note('PDF_IMAGE_NOT_EMITTED', el);
      else if (tag === 'svg') note('PDF_SVG_NOT_EMITTED', el);
      if (!TRANSPARENT.test(cs.backgroundColor)) note('PDF_BACKGROUND_NOT_EMITTED', el);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') note('PDF_BACKGROUND_IMAGE_NOT_EMITTED', el);
      const bw = ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'];
      if (bw.some((p) => parseFloat(cs[p]) > 0)) note('PDF_BORDER_NOT_EMITTED', el);
    }
    if (!hasEmitters && root.querySelectorAll('a[href]').length) {
      note('PDF_LINK_NOT_EMITTED', root.querySelector('a[href]'));
    }
    return [...found.values()];
  }

  /**
   * Fragment one already-isolated subtree with the multicolumn oracle.
   *
   * The geometry is applied ONCE and left in place: `reserve` re-measures
   * between passes, so the column mapping must be live closures over the
   * container rather than a snapshot taken before any spacer was inserted.
   */
  function openFragmentation(container, geo, columns) {
    const prev = container.style.cssText;
    Object.assign(container.style, {
      width: `${geo.contentW * columns}px`,
      height: `${geo.contentH}px`,
      columnWidth: `${geo.contentW}px`,
      columnGap: '0px',
      columnFill: 'auto',
    });
    container.getBoundingClientRect();                        // force layout

    const box = () => container.getBoundingClientRect();
    // Measured, never assumed: the used column width is what indexes columns.
    const pitch = () => box().width / columns;
    const columnOfElement = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return Math.floor((r.left - box().left) / pitch() + 1e-3);
    };
    const columnOfRun = (run) => Math.floor((run.rect.left - box().left) / pitch() + 1e-3);
    const close = () => { container.style.cssText = prev; };
    return { box, pitch, columnOfElement, columnOfRun, close };
  }

  /**
   * Runs for one furniture element, in column-relative coordinates, captured
   * while the multicolumn layout is still applied.
   */
  function furnitureRuns(el, box, pitch) {
    const extracted = globalThis.__pdf_extractTextRuns(el);
    const b = box(), p = pitch();
    return extracted.runs.map((run) => ({
      run,
      top: run.rect.top - b.top,
      baseline: run.baselineCandidates.topPlusFontAscent - b.top,
      // resolved here, so drawing never has to know which space this came from
      words: run.words.map((w) => ({ text: w.text, x: (w.left - b.left) % p })),
    }));
  }

  /**
   * Every @font-face the document declares, with an absolute URL for its bytes.
   * This is what makes the SDK work without configuration: the page already
   * told the browser where its fonts are, so ask the CSSOM rather than the
   * caller. Cross-origin stylesheets throw on .cssRules and are skipped.
   */
  function discoverFonts() {
    const out = [];
    const seen = new Set();
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }        // cross-origin
      for (const rule of Array.from(rules || [])) {
        if (rule.type !== 5 /* CSSFontFaceRule */) continue;
        const family = String(rule.style.fontFamily || '').replace(/["']/g, '').trim();
        const m = String(rule.style.src || '').match(/url\(\s*["']?([^"')]+)["']?\s*\)/);
        if (!family || !m) continue;
        let href;
        try { href = new URL(m[1], sheet.href || document.baseURI).href; } catch { continue; }
        const weight = parseInt(rule.style.fontWeight, 10) || 400;
        const style = rule.style.fontStyle || 'normal';
        const key = `${family}|${weight}|${style}|${href}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ family, src: href, weight, style });
      }
    }
    return out;
  }

  /**
   * A system font has no bytes to embed, so fall back to one of the 14 standard
   * PDF fonts. Glyph shapes differ slightly from the screen; POSITIONS do not,
   * because every word is placed from geometry the browser measured. That is
   * what makes this fallback acceptable rather than a corruption.
   */
  function standardFontFor(family, weight, style) {
    const f = String(family || '').toLowerCase();
    const bold = parseInt(weight, 10) >= 600 || weight === 'bold';
    const italic = String(style || '').startsWith('italic') || String(style || '').startsWith('oblique');
    const serif = /(^|,)\s*(serif|times|georgia|garamond|book)/.test(f) && !/sans/.test(f);
    const mono = /(mono|courier|consolas|menlo)/.test(f);
    // Exact StandardFonts values — 'Times-Roman', not 'TimesRoman'. pdf-lib
    // treats an unrecognised string as base64 font bytes and fails with the
    // unhelpful "Unknown font format".
    if (mono) return `Courier${bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : ''}`;
    if (serif) return `Times${bold && italic ? '-BoldItalic' : bold ? '-Bold' : italic ? '-Italic' : '-Roman'}`;
    return `Helvetica${bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : ''}`;
  }

  async function render(root, options = {}) {
    const opts = {
      columns: 24,
      generatedContent: true,
      forms: 'fields',                 // 'fields' | 'flatten' | 'none'
      pdfLib: globalThis.PDFLib,
      fontkit: globalThis.fontkit,
      ...options,
    };
    if (!opts.fonts) opts.fonts = discoverFonts();
    assertEnvironment(opts);

    const t0 = performance.now();
    const { PDFDocument, rgb, setCharacterSpacing } = opts.pdfLib;
    const F = globalThis.__pdf_furniture;
    const diagnostics = [];
    // One entry per distinct problem, with a count — not one per run. A
    // missing face otherwise reports itself once for every line of text.
    const seen = new Map();
    const diag = (code, message, detail) => {
      const key = `${code}|${message}`;
      if (seen.has(key)) { seen.get(key).count += 1; return seen.get(key); }
      const d = { code, message, count: 1, ...(detail !== undefined ? { detail } : {}) };
      seen.set(key, d);
      diagnostics.push(d);
      if (typeof opts.onDiagnostic === 'function') opts.onDiagnostic(d);
      return d;
    };

    // ---- 1. fonts, registered explicitly ---------------------------------
    const registry = new globalThis.__pdf_FontRegistry();
    for (const spec of opts.fonts) registry.register(spec);
    await registry.load();
    for (const d of registry.diagnostics || []) diag(d.code || 'PDF_FONT_DIAGNOSTIC', d.message || String(d), d);

    // ---- 2. make the browser resolve what it will -------------------------
    if (opts.generatedContent) globalThis.__pdf_materializeGenerated(root);
    F.translatePageBreaks(root);

    for (const u of unhandledContent(root)) {
      diag(u.code, `${u.count} element(s) carry content this build does not emit `
        + `(first: ${u.first}). Extractors exist; the PDF emitters do not yet.`, u);
    }

    // ---- 3. split into runs of uniform page geometry ----------------------
    const rules = F.pageRules();
    const runs = F.segmentByPage(root);
    const allRunElements = new Set(runs.flatMap((r) => r.elements));

    // ---- 4. fragment each run with its own geometry -----------------------
    const pages = [];       // { geo, pageName, runs, furniture, box, pitch }
    for (const run of runs) {
      const merged = F.rulesForPage(rules, run.page, pages.length);
      const geo = geometryOf(merged, opts.page);

      // A run's elements are not necessarily contiguous siblings once runs
      // nest, so isolate by hiding the others rather than by wrapping.
      const hidden = [];
      if (runs.length > 1) {
        for (const el of allRunElements) {
          if (run.elements.includes(el)) continue;
          hidden.push([el, el.style.display]);
          el.style.display = 'none';
        }
      }

      const furniture = F.identify(root);

      // Fixed elements must be measured BEFORE detach() sets display:none, and
      // they position against the viewport rather than the column box — so
      // their x is absolute, not modulo the column pitch.
      const fixedPlacements = new Map();
      for (const f of furniture.fixed) {
        // A fixed element anchors to the PAGE BOX when printing, not to the
        // viewport it was laid out against, so `right: 0` in a 1400px window
        // would otherwise land far off a 794px-wide page.
        //
        // getComputedStyle is no help: Chromium returns USED values, so an
        // element written as `right: 0` reports `left: 1312.97px` as well —
        // the authored side is unrecoverable from the computed style.
        //
        // So anchor to whichever viewport edge the element is NEARER, and carry
        // that gap onto the page box. Exact for the usual cases (corners and
        // edges); ambiguous only for a roughly centred element, which is
        // reported rather than guessed at silently.
        const r = f.el.getBoundingClientRect();
        const vw = document.documentElement.clientWidth;
        const vh = document.documentElement.clientHeight;
        const gap = { left: r.left, right: vw - r.right, top: r.top, bottom: vh - r.bottom };
        //
        // An author who knows better can say so and skip the guess entirely:
        //   <div class="stamp" data-pdf-anchor="top right">
        // Accepts any of top / bottom / left / right, in either order.
        const declared = String(f.el.dataset.pdfAnchor || '').toLowerCase().split(/[\s-]+/);
        const declaredX = declared.includes('right') ? 'right' : declared.includes('left') ? 'left' : null;
        const declaredY = declared.includes('bottom') ? 'bottom' : declared.includes('top') ? 'top' : null;

        const anchorX = declaredX || (gap.right < gap.left ? 'right' : 'left');
        const anchorY = declaredY || (gap.bottom < gap.top ? 'bottom' : 'top');

        // The precondition that makes ALL of this exact: if the layout viewport
        // is the width of the page box, a fixed element already resolves where
        // it will print, and no re-anchoring is needed. Measured: at a 794px
        // viewport an A4 page places a centred stamp with 0.00pt error; at
        // 1400px the same element is 227pt out. Re-anchoring carries an
        // ABSOLUTE edge gap, so it cannot rescue a proportional offset
        // (`left: 50%`) no matter which edge is chosen — hence a warning about
        // the viewport, not just about the anchor.
        if (Math.abs(vw - geo.w) > 2) {
          diag('PDF_VIEWPORT_MISMATCH',
            `a fixed element was laid out against a ${Math.round(vw)}px viewport but the page box `
            + `is ${Math.round(geo.w)}px. Re-render with the viewport at page width for exact `
            + 'placement; percentage offsets such as `left: 50%` cannot be corrected otherwise.',
            { viewportWidth: vw, pageWidth: geo.w });
        } else if (!declaredX && Math.abs(gap.left - gap.right) < 8) {
          diag('PDF_FIXED_ANCHOR_AMBIGUOUS',
            'a fixed element sits near the horizontal centre, so which page edge it '
            + 'anchors to is a guess — declare it with data-pdf-anchor="top left"',
            { element: f.el.id ? `#${f.el.id}` : f.el.className || f.el.tagName.toLowerCase() });
        }
        const runs = globalThis.__pdf_extractTextRuns(f.el).runs.map((run) => ({
          run,
          baseline: run.baselineCandidates.topPlusFontAscent - r.top,
          words: run.words.map((w) => ({ text: w.text, x: w.left - r.left })),
        }));
        fixedPlacements.set(f.el, {
          runs, gap, anchorX, anchorY,
          size: { w: r.width, h: r.height },
        });
      }

      F.detach(furniture);

      const frag = openFragmentation(root, geo, opts.columns);
      const hasFurniture = furniture.fixed.length > 0 || furniture.tables.length > 0;
      if (hasFurniture) {
        // reserve() re-measures each pass and wants an element->column mapping
        F.reserve(furniture, () => frag.columnOfElement);
      }

      // A repeated <thead> is NOT excluded from the flow list: its single
      // occurrence in the multicolumn layout legitimately lands in column 0,
      // and `emit` deliberately supplies it only for columns >= 1. Excluding it
      // here would drop the header from the first page. The mirror image holds
      // for <tfoot>, whose flow position is the LAST page.
      const extracted = globalThis.__pdf_extractTextRuns(root);
      const box = frag.box(), pitch = frag.pitch();
      const byColumn = new Map();
      for (const r of extracted.runs) {
        const c = frag.columnOfRun(r);
        if (!byColumn.has(c)) byColumn.set(c, []);
        byColumn.get(c).push(r);
      }

      // Everything that is not text, captured under the SAME layout so it lands
      // in the same columns. Each is optional: the small bundle omits them and
      // the pipeline degrades to text with diagnostics.
      const colOfBox = (bx) => Math.floor((bx - box.left) / pitch + 1e-3);
      const bucket = (list, getX) => {
        const m = new Map();
        for (const item of list || []) {
          const c = colOfBox(getX(item));
          if (!m.has(c)) m.set(c, []);
          m.get(c).push(item);
        }
        return m;
      };

      const paintAll = globalThis.__pdf_extractPaint
        ? globalThis.__pdf_extractPaint(root) : { items: [], unsupported: [] };
      for (const u of paintAll.unsupported || []) {
        diag('PDF_PAINT_UNSUPPORTED', `${u.feature} on ${u.id}: ${u.detail}`, u);
      }
      const paintByCol = bucket(paintAll.items, (i) => i.box.x);
      const imagesByCol = bucket(
        globalThis.__pdf_extractImages ? globalThis.__pdf_extractImages(root) : [],
        (i) => i.content.x);
      // extractSvg returns { shapes, unsupported }, not a bare array.
      const svgAll = globalThis.__pdf_extractSvg
        ? globalThis.__pdf_extractSvg(root) : { shapes: [], unsupported: [] };
      for (const u of svgAll.unsupported || []) {
        diag('PDF_SVG_UNSUPPORTED', `${u.feature || 'unsupported'} on ${u.id}`, u);
      }
      const svgByCol = bucket(svgAll.shapes,
        (i) => (i.viewportClip ? i.viewportClip.x : i.ctm.e));
      const canvasAll = globalThis.__pdf_extractCanvas
        ? globalThis.__pdf_extractCanvas(root) : [];
      for (const c of canvasAll) {
        if (c.tainted) {
          diag('PDF_CANVAS_TAINTED',
            `<canvas> ${c.id} has drawn cross-origin content, so its pixels cannot be read back `
            + 'and it was not embedded.', { id: c.id });
        }
      }
      const canvasByCol = bucket(canvasAll, (i) => i.box.x);
      const formsByCol = bucket(
        globalThis.__pdf_extractForms ? globalThis.__pdf_extractForms(root) : [],
        (i) => i.box.x);
      const linksByCol = new Map();
      for (const ln of (globalThis.__pdf_extractLinks ? globalThis.__pdf_extractLinks(root) : [])) {
        // one link may wrap across a column boundary; split its rects
        for (const r of ln.rects) {
          const c = colOfBox(r.x);
          if (!linksByCol.has(c)) linksByCol.set(c, []);
          const list = linksByCol.get(c);
          const found = list.find((x) => x.href === ln.href);
          if (found) found.rects.push(r);
          else list.push({ ...ln, rects: [r] });
        }
      }

      // Pages come from the union of EVERY column anything landed in, not just
      // text: a document of nothing but boxes or SVG still has pages.
      const allCols = new Set([
        ...byColumn.keys(), ...paintByCol.keys(), ...imagesByCol.keys(),
        ...svgByCol.keys(), ...linksByCol.keys(), ...canvasByCol.keys(),
        ...formsByCol.keys(),
      ].filter((c) => Number.isFinite(c) && c >= 0));
      if (!allCols.size) allCols.add(0);
      const indices = [...allCols].sort((a, b) => a - b);
      const columnCount = indices[indices.length - 1] + 1;
      if (columnCount > opts.columns) {
        diag('PDF_COLUMN_BUDGET_EXCEEDED',
          `content needed ${columnCount} columns but only ${opts.columns} were available; `
          + 'raise options.columns', { needed: columnCount });
      }

      // Furniture per page, with geometry captured before the layout is undone.
      const perPage = hasFurniture ? F.emit(furniture, frag.columnOfElement, columnCount) : [];
      const furnitureByColumn = new Map();
      for (let c = 0; c < perPage.length; c++) {
        const items = [];
        for (const item of perPage[c] || []) {
          if (item.kind === 'fixed') {
            const fp = fixedPlacements.get(item.el);
            if (fp) items.push({ kind: item.kind, placed: fp.runs, fixed: fp });
            continue;
          }
          const placed = furnitureRuns(item.el, frag.box, frag.pitch);
          let dy = 0;
          if (item.kind === 'table-header' && item.anchor) {
            // sits directly above the first body row on this continuation page
            const aTop = item.anchor.getBoundingClientRect().top - box.top;
            const own = placed.length ? Math.min(...placed.map((p) => p.top)) : 0;
            dy = (aTop - item.height) - own;
          } else if (item.kind === 'table-footer' && item.anchor) {
            const aBottom = item.anchor.getBoundingClientRect().bottom - box.top;
            const own = placed.length ? Math.min(...placed.map((p) => p.top)) : 0;
            dy = aBottom - own;
          }
          items.push({ kind: item.kind, placed, dy });
        }
        if (items.length) furnitureByColumn.set(c, items);
      }

      for (const c of indices) {
        pages.push({
          geo, pageName: run.page || '',
          runs: byColumn.get(c) || [],
          furniture: furnitureByColumn.get(c) || [],
          paint: paintByCol.get(c) || [],
          images: imagesByCol.get(c) || [],
          svg: svgByCol.get(c) || [],
          canvas: canvasByCol.get(c) || [],
          forms: formsByCol.get(c) || [],
          links: linksByCol.get(c) || [],
          box, pitch,
        });
      }

      frag.close();
      F.clearSpacers();
      for (const [el, display] of hidden) el.style.display = display;
    }

    if (!pages.length) {
      diag('PDF_NO_CONTENT', 'nothing was extracted from the given root');
    }

    // ---- 5. write the PDF -------------------------------------------------
    const doc = await PDFDocument.create();
    doc.registerFontkit(opts.fontkit);

    const embedded = new Map();
    async function embedFor(face) {
      const key = `${face.family}|${face.weight}|${face.style}`;
      if (!embedded.has(key)) {
        embedded.set(key, await doc.embedFont(face.bytes, { subset: opts.subset !== false }));
      }
      return embedded.get(key);
    }

    /** Registered face if the page gave us bytes; otherwise a standard font. */
    async function fontFor(f) {
      const face = registry.metricsFace({
        fontFamily: f.family, fontWeight: f.weight, fontStyle: f.style,
      });
      if (face) return embedFor(face);
      const std = standardFontFor(f.family, f.weight, f.style);
      if (!embedded.has(std)) embedded.set(std, await doc.embedFont(std));
      diag('PDF_FONT_SUBSTITUTED',
        `no embeddable bytes for "${f.family}" ${f.weight} ${f.style} — substituted the standard `
        + `font ${std}. Word positions still come from the browser's own measurements; only glyph `
        + 'shapes differ. Declare an @font-face to embed the real font.',
        { requested: f.family, substituted: std });
      return embedded.get(std);
    }

    const ctx = document.createElement('canvas').getContext('2d');
    const DEF = F.MARGIN_BOX_DEFAULT_FONT;

    // ---- emitters for everything that is not text -------------------------
    const E = globalThis.__pdf_emit;
    const emitCtx = E ? E.createContext(doc, opts.pdfLib) : null;
    const imageCache = new Map();

    /** Fetch and embed an image, passing the original bytes through if we can. */
    async function loadImage(src) {
      if (imageCache.has(src)) return imageCache.get(src);
      let result = null;
      try {
        const buf = new Uint8Array(await (await fetch(src)).arrayBuffer());
        const isPng = buf[0] === 0x89 && buf[1] === 0x50;
        const isJpg = buf[0] === 0xFF && buf[1] === 0xD8;
        if (isPng) result = { img: await doc.embedPng(buf), bytes: buf.length, mode: 'png' };
        else if (isJpg) result = { img: await doc.embedJpg(buf), bytes: buf.length, mode: 'jpg' };
        else {
          // PDF has no WebP/AVIF/GIF; re-encode through a canvas. Lossless to
          // PNG, but the original compression is gone — hence the diagnostic.
          const el = new Image();
          el.crossOrigin = 'anonymous';
          el.src = src;
          await el.decode();
          const c = document.createElement('canvas');
          c.width = el.naturalWidth; c.height = el.naturalHeight;
          c.getContext('2d').drawImage(el, 0, 0);
          const bin = atob(c.toDataURL('image/png').split(',')[1]);
          const re = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) re[i] = bin.charCodeAt(i);
          diag('PDF_IMAGE_REENCODED',
            `${src.split('/').pop()} is not a format PDF can embed; re-encoded to PNG `
            + `(${buf.length} → ${re.length} bytes).`, { src });
          result = { img: await doc.embedPng(re), bytes: re.length, mode: 'reencoded' };
        }
      } catch (e) {
        diag('PDF_RESOURCE_INACCESSIBLE',
          `could not read image bytes for ${src.split('/').pop()}: ${e.message}. `
          + 'The browser may still display it; a PDF needs the bytes.', { src });
      }
      imageCache.set(src, result);
      return result;
    }

    const emitStats = { backgrounds: 0, gradients: 0, bgImages: 0, borders: 0,
      images: 0, svg: 0, links: 0, shadows: 0, blends: 0, canvases: 0,
      formFields: 0, formsFlattened: 0 };

    // Flattened form text is drawn with a standard font.
    const flattenFont = opts.forms === 'flatten' ? await doc.embedFont('Helvetica') : null;
    const addStats = (into, from) => { for (const k in from) into[k] = (into[k] || 0) + from[k]; };

    for (let i = 0; i < pages.length; i++) {
      const { geo, runs: pageRuns, box, pitch, pageName } = pages[i];
      const pdfPage = doc.addPage([geo.ptW, geo.ptH]);

      // ---- everything that is not text, painted beneath it -----------------
      // Viewport px -> page pt for THIS page's column.
      const xf = {
        PT,
        x: (vx) => (geo.mLeft + ((vx - box.left) % pitch)) * PT,
        y: (vy) => geo.ptH - (geo.mTop + (vy - box.top)) * PT,
      };
      if (E && emitCtx) {
        addStats(emitStats, await E.emitPaint(pdfPage, pages[i].paint, emitCtx, xf, {
          loadImage,
          onUnsupported: (why, it) => diag('PDF_SHADOW_NOT_EMITTED',
            `inset box-shadow on ${it.id} has no raster fallback`, { id: it.id }),
        }));
        addStats(emitStats, await E.emitImages(pdfPage, pages[i].images, emitCtx, xf, { loadImage }));
        addStats(emitStats, await E.emitCanvas(pdfPage, pages[i].canvas, emitCtx, xf, {}));
        const sv = E.emitSvg(pdfPage, pages[i].svg, emitCtx, xf);
        emitStats.svg += sv.shapes;
        if (sv.skipped) {
          diag('PDF_SVG_PARTIAL', `${sv.skipped} SVG shape(s) use a paint server or clip this `
            + 'build cannot resolve and were skipped', { skipped: sv.skipped });
        }
      }

      // Chromium's own content stream orders a page as: margin boxes, then
      // repeated table sections, then flow, then fixed elements. Matching that
      // order is what makes copied text come out in the same sequence.
      // ---- margin boxes: running headers, footers, page numbers ----------
      const merged = F.rulesForPage(rules, pageName, i);
      for (const mb of merged.boxes || []) {
        const { text } = F.resolveMarginContent(mb.content, i + 1, pages.length);
        if (!text) continue;
        const size = mb.font.size || DEF.size;
        const family = mb.font.family || DEF.family;
        ctx.font = `${mb.font.style || DEF.style} ${mb.font.weight || DEF.weight} ${size}px ${family}`;
        const m = ctx.measureText('Hxpg');
        const place = F.marginBoxPlacement(mb.slot, {
          w: geo.w, h: geo.h,
          marginTop: geo.mTop, marginBottom: geo.mBottom,
          marginLeft: geo.mLeft, marginRight: geo.mRight,
        }, { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent });

        const font = await fontFor({
          family, weight: mb.font.weight || DEF.weight, style: mb.font.style || DEF.style,
        });

        const width = font.widthOfTextAtSize(text, size * PT);
        let x;
        if (place.align === 'left') x = place.contentL * PT;
        else if (place.align === 'right') x = place.contentR * PT - width;
        else x = ((place.contentL + place.contentR) / 2) * PT - width / 2;

        pdfPage.drawText(text, {
          x, y: geo.ptH - place.baseline * PT, size: size * PT, font, color: rgb(0, 0, 0),
        });
      }
      const drawFurniture = async (want) => {
        for (const item of pages[i].furniture) {
          if (want === 'fixed' ? item.kind !== 'fixed' : item.kind === 'fixed') continue;

        for (const p of item.placed) {
          const font = await fontFor(p.run.font);
          // Fixed furniture is anchored to the page box; table furniture sits
          // in the content box at a column-relative offset.
          let originX, originY;
          if (item.fixed) {
            const { gap: g, anchorX: ax, anchorY: ay, size } = item.fixed;
            originX = ax === 'right' ? geo.w - g.right - size.w : g.left;
            originY = ay === 'bottom' ? geo.h - g.bottom - size.h : g.top;
          } else {
            originX = geo.mLeft;
            originY = geo.mTop + item.dy;
          }
          const yPx = originY + p.baseline;
          for (const word of p.words) {
            const xPx = originX + word.x;
            try {
              pdfPage.drawText(word.text, {
                x: xPx * PT, y: geo.ptH - yPx * PT,
                size: p.run.font.size * PT, font, color: cssColorToRgb(p.run.color, rgb),
              });
            } catch (e) {
              diag('PDF_GLYPH_UNAVAILABLE', `furniture: ${e.message}`);
            }
          }
        }
        }
      };

      await drawFurniture('table');

      for (const run of pageRuns) {
        const font = await fontFor(run.font);

        // baseline = font-box top + ascent (findings 01; source-confirmed)
        const yPx = geo.mTop + (run.baselineCandidates.topPlusFontAscent - box.top);
        const y = geo.ptH - yPx * PT;

        const ls = parseFloat(run.font.letterSpacing);
        const tracking = Number.isFinite(ls) ? ls * PT : 0;
        if (tracking) pdfPage.pushOperators(setCharacterSpacing(tracking));

        for (const word of run.words) {
          // Per-word measured positions: the browser already decided where each
          // word sits, so shaping divergence cannot accumulate across a line.
          const xPx = geo.mLeft + ((word.left - box.left) % pitch);
          try {
            pdfPage.drawText(word.text, {
              x: xPx * PT, y,
              size: run.font.size * PT,
              font,
              color: cssColorToRgb(run.color, rgb),
            });
          } catch (e) {
            diag('PDF_GLYPH_UNAVAILABLE', `could not draw ${JSON.stringify(word.text)}: ${e.message}`,
              { family: run.font.family });
          }
        }
        if (tracking) pdfPage.pushOperators(setCharacterSpacing(0));
      }

      await drawFurniture('fixed');

      // Form fields, like links, are page objects rather than drawing.
      if (E && emitCtx && pages[i].forms.length && opts.forms !== 'none') {
        const fs = E.emitForms(pdfPage, pages[i].forms, emitCtx, xf, {
          mode: opts.forms,
          font: flattenFont,
          onUnsupported: (f) => diag('PDF_FORM_NOT_EMITTED',
            `<${f.kind === 'unsupported' ? f.reason : f.kind}> has no AcroForm equivalent`
            + ' and was not emitted', { name: f.name, reason: f.reason }),
        });
        emitStats.formFields += fs.fields;
        emitStats.formsFlattened += fs.flattened;
      }

      // Link annotations are page objects rather than content-stream drawing.
      if (E && emitCtx && pages[i].links.length) {
        emitStats.links += E.emitLinks(pdfPage, pages[i].links, emitCtx, xf).links;
      }
    }

    const bytes = await doc.save();
    return {
      bytes,
      pages: pages.length,
      diagnostics,
      stats: {
        totalMs: performance.now() - t0,
        runs: pages.reduce((s, p) => s + p.runs.length, 0),
        furniture: pages.map((p) => p.furniture.map((f) => `${f.kind}:${f.placed.length}`).join(',')),
        emitted: emitStats,
      },
    };
  }

  /** `rgb(r, g, b)` / `rgba(...)` as pdf-lib's colour. Anything else is black. */
  function cssColorToRgb(css, rgb) {
    const m = String(css || '').match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
    if (!m) return rgb(0, 0, 0);
    return rgb(+m[1] / 255, +m[2] / 255, +m[3] / 255);
  }

  /** The same render, handed back as a Blob. */
  async function renderToBlob(root, options) {
    const r = await render(root, options);
    return Object.assign(new Blob([r.bytes], { type: 'application/pdf' }), {});
  }

  /** Render and hand the user a file. Returns the render result. */
  async function download(root, filename = 'document.pdf', options) {
    const r = await render(root, options);
    const url = URL.createObjectURL(new Blob([r.bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return r;
  }

  /** Open the rendered PDF in a new tab. */
  async function open_(root, options) {
    const r = await render(root, options);
    const url = URL.createObjectURL(new Blob([r.bytes], { type: 'application/pdf' }));
    globalThis.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return r;
  }

  globalThis.__pdf_render = render;
  globalThis.__pdf_render.unhandledContent = unhandledContent;
  globalThis.__pdf_render.discoverFonts = discoverFonts;

  // The public SDK surface.
  globalThis.PeeDeeEff = {
    render, renderToBlob, download, open: open_, discoverFonts, unhandledContent,
  };
})();
