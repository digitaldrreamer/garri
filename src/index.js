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

  /**
   * CSS absolute lengths, in px. `0` is valid with no unit; nothing else is.
   */
  const UNITS = { px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };
  function lengthPx(token) {
    const t = String(token).trim().toLowerCase();
    if (/^0(\.0+)?$/.test(t)) return 0;                    // unitless zero
    const m = t.match(/^(-?[\d.]+)(px|pt|pc|in|cm|mm|q)$/);
    return m ? parseFloat(m[1]) * UNITS[m[2]] : null;
  }

  /**
   * The named page sizes from css-page-3, in mm. Every real document uses these
   * rather than an explicit `210mm 297mm` — all ten Kami demos say `size: A4`,
   * and a parser that only understood the explicit form silently rendered every
   * one of them at a guessed default, landscape included.
   */
  const PAGE_SIZES = {
    a5: [148, 210], a4: [210, 297], a3: [297, 420],
    b5: [176, 250], b4: [250, 353],
    'jis-b5': [182, 257], 'jis-b4': [257, 364],
    letter: [215.9, 279.4], legal: [215.9, 355.6], ledger: [279.4, 431.8],
  };

  /** `size: A4 landscape` / `size: 210mm 297mm` / `size: 8.5in 11in` -> mm. */
  function parseSize(value) {
    const t = String(value || '').trim().toLowerCase();
    if (!t || t === 'auto') return null;
    const tokens = t.split(/\s+/);
    const named = tokens.find((x) => PAGE_SIZES[x]);
    const landscape = tokens.includes('landscape');

    if (named) {
      const [w, h] = PAGE_SIZES[named];
      return landscape ? { wMm: h, hMm: w } : { wMm: w, hMm: h };
    }
    // explicit lengths, in any absolute unit
    const lens = tokens.map(lengthPx).filter((v) => v !== null && v > 0);
    if (lens.length >= 2) {
      const [w, h] = [lens[0] / UNITS.mm, lens[1] / UNITS.mm];
      return landscape && h > w ? { wMm: h, hMm: w } : { wMm: w, hMm: h };
    }
    if (lens.length === 1) {                                // square page
      const side = lens[0] / UNITS.mm;
      return { wMm: side, hMm: side };
    }
    // `landscape` alone flips the default
    return landscape ? { wMm: DEFAULT_PAGE.heightMm, hMm: DEFAULT_PAGE.widthMm } : null;
  }

  /** The 1-to-4 value margin shorthand, in px. */
  function parseMargin(value) {
    const parts = String(value || '').trim().split(/\s+/).map(lengthPx);
    if (!parts.length || parts.some((v) => v === null)) return null;
    const [a, b = a, c = a, d = b] = parts;                 // top right bottom left
    return { top: a, right: b, bottom: c, left: d };
  }

  /** Page geometry in CSS px, from a parsed @page rule or the caller's override. */
  function geometryOf(rule, override) {
    const size = parseSize(rule && rule.size);
    const wMm = override?.widthMm ?? (size ? size.wMm : DEFAULT_PAGE.widthMm);
    const hMm = override?.heightMm ?? (size ? size.hMm : DEFAULT_PAGE.heightMm);

    let m = parseMargin(rule && rule.margin);
    if (override?.marginMm !== undefined) {
      const v = mmToPx(override.marginMm);
      m = { top: v, right: v, bottom: v, left: v };
    }
    if (!m) {
      const v = mmToPx(DEFAULT_PAGE.marginMm);
      m = { top: v, right: v, bottom: v, left: v };
    }

    const w = mmToPx(wMm), h = mmToPx(hMm);
    // Rounded because a fractional margin makes the content box fractional too,
    // and the column height must be an integer number of CSS pixels to
    // fragment the same way twice.
    const mTop = Math.round(m.top), mBottom = Math.round(m.bottom);
    const mLeft = Math.round(m.left), mRight = Math.round(m.right);
    return {
      w, h,
      mTop, mBottom, mLeft, mRight,
      contentW: w - mLeft - mRight,
      contentH: h - mTop - mBottom,
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
      // The element is being repurposed as a fragmentation container, so its
      // author box constraints must not interfere. A real document commonly
      // carries `@media screen { body { max-width: 210mm; padding: 25mm } }`,
      // which clamps the width we just set: the container stays 794px instead
      // of the 14,536px asked for, the derived pitch comes out 33px instead of
      // 606px, and every line lands in a different "column" — one Chromium page
      // becomes twenty. Padding goes too: the PDF's margin comes from @page,
      // and leaving screen padding in place insets the content twice.
      maxWidth: 'none',
      minWidth: '0',
      padding: '0',
      margin: '0',
      border: '0',
    });
    container.getBoundingClientRect();                        // force layout

    const box = () => container.getBoundingClientRect();
    // Measured, never assumed: the used column width is what indexes columns.
    const pitch = () => box().width / columns;
    // If something still clamps the container, the pitch is meaningless and
    // every subsequent page number is wrong. Say so rather than emit nonsense.
    const wanted = geo.contentW * columns;
    const got = box().width;
    const clamped = got < wanted - 1;
    const columnOfElement = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return Math.floor((r.left - box().left) / pitch() + 1e-3);
    };
    const columnOfRun = (run) => Math.floor((run.rect.left - box().left) / pitch() + 1e-3);
    const close = () => { container.style.cssText = prev; };
    return { box, pitch, columnOfElement, columnOfRun, close, clamped, wanted, got };
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
    const { PDFDocument, PDFName, rgb, setCharacterSpacing, degrees } = opts.pdfLib;
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
    // `materializeGenerated` returns the list markers it measured as well as
    // inserting the pseudo-elements. That return value used to be discarded, so
    // every real `<ol>`/`<ul>` marker — computed here against a placement rule
    // derived from Chromium's own output — was simply never drawn. A changelog
    // with two numbered lists came out with all eleven markers missing.
    if (opts.generatedContent) {
      const gen = globalThis.__pdf_materializeGenerated(root) || {};
      for (const d of gen.diagnostics || []) {
        diag(d.code || 'PDF_GENERATED_CONTENT_PARTIAL', d.message || d.detail || String(d), d);
      }
    }
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
      // Fragmentation needs ONE column height for the whole run, so it must use
      // the geometry of a TYPICAL page — index 1, not 0. Taking page 1's
      // geometry here applies any `@page :first` override to every page:
      // kaku's `@page:first { margin: 0 }` made every column 8.7% taller and
      // lost a page in eight. Each page is still DRAWN with its own geometry
      // below, so `:first` still moves page one's content.
      const commonRule = F.rulesForPage(rules, run.page, 1);
      const geo = geometryOf(commonRule, opts.page);

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

      // `@page :first` can give page one a different content box, and a
      // multicolumn container has exactly one column height — so a run whose
      // first page differs cannot be fragmented in a single pass.
      //
      // kaku is the case in point: a `.cover` exactly 297mm tall, which fits
      // page one only because `@page:first { margin: 0 }` removes the margins.
      // Fragmented at the typical page's height it splits in two, and the
      // document comes out a page long.
      //
      // So when the first page differs, fragment it separately: measure what
      // lands in column 0 at the FIRST page's height, and if that set ends on a
      // clean element boundary, hide it and fragment the remainder at the
      // typical height. A boundary that falls mid-element is not safe to split
      // this way, and is reported rather than guessed at.
      const firstGeo = geometryOf(F.rulesForPage(rules, run.page, 0), opts.page);
      let firstPageEls = null;
      if (firstGeo.contentH !== geo.contentH || firstGeo.contentW !== geo.contentW) {
        const probe = openFragmentation(root, firstGeo, opts.columns);
        const children = [...root.children].filter((el) => {
          const cs = getComputedStyle(el);
          return cs.display !== 'none' && cs.visibility !== 'hidden';
        });
        const colOf = probe.columnOfElement;
        const spans = children.map((el) => {
          const first = colOf(el);
          // an element straddles if its own box starts in 0 but ends past it
          const r = el.getBoundingClientRect();
          const b = probe.box();
          const endCol = Math.floor((r.right - 1 - b.left) / probe.pitch() + 1e-3);
          return { el, first, endCol };
        });
        const onFirst = spans.filter((x) => x.first === 0);
        const straddles = onFirst.some((x) => x.endCol > 0);
        probe.close();
        if (onFirst.length && !straddles && onFirst.length < children.length) {
          firstPageEls = onFirst.map((x) => x.el);
        } else {
          diag('PDF_FIRST_PAGE_GEOMETRY_UNUSED',
            'the first page has a different content box, but its content does not end on a '
            + 'clean element boundary, so the whole run was fragmented at the typical page '
            + 'height. Page assignment may be off by one.',
            { firstContentH: firstGeo.contentH, typicalContentH: geo.contentH });
        }
      }

      // Page one, fragmented at its own height, then held out of the main pass.
      const heldOut = [];
      let firstPagePayload = null;
      if (firstPageEls) {
        const p1 = openFragmentation(root, firstGeo, opts.columns);
        const box1 = p1.box(), pitch1 = p1.pitch();
        const ex1 = globalThis.__pdf_extractTextRuns(root).runs
          .filter((r) => p1.columnOfRun(r) === 0);
        const paint1 = (globalThis.__pdf_extractPaint
          ? globalThis.__pdf_extractPaint(root).items : [])
          .filter((i) => Math.floor((i.box.x - box1.left) / pitch1 + 1e-3) === 0);
        firstPagePayload = { geo: firstGeo, runs: ex1, paint: paint1, box: box1, pitch: pitch1 };
        p1.close();
        for (const el of firstPageEls) { heldOut.push([el, el.style.display]); el.style.display = 'none'; }
      }

      const frag = openFragmentation(root, geo, opts.columns);
      if (frag.clamped) {
        diag('PDF_CONTAINER_CLAMPED',
          `the render root could not be widened for fragmentation (asked for `
          + `${Math.round(frag.wanted)}px, got ${Math.round(frag.got)}px). Page assignment `
          + 'will be wrong. Give the element being rendered no max-width, or render an '
          + 'inner wrapper instead.', { wanted: frag.wanted, got: frag.got });
      }
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
      // Measured HERE, inside the fragmented layout, not during setup: the
      // container changes every box on the page.
      const markerAll = (opts.generatedContent && globalThis.__pdf_extractMarkers)
        ? (globalThis.__pdf_extractMarkers(root).markers || []) : [];
      const markersByCol = bucket(markerAll, (m) => m.right);
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

      if (firstPagePayload) {
        pages.push({
          geo: firstPagePayload.geo, pageName: run.page || '',
          runs: firstPagePayload.runs,
          furniture: [], paint: firstPagePayload.paint,
          images: [], svg: [], canvas: [], forms: [], links: [], markers: [],
          box: firstPagePayload.box, pitch: firstPagePayload.pitch,
        });
      }

      for (const c of indices) {
        // This page's own geometry: `:first` and the spread-side rules apply
        // per page, and the page box itself may differ.
        const pageGeo = geometryOf(F.rulesForPage(rules, run.page, pages.length), opts.page);
        if (pageGeo.contentH !== geo.contentH || pageGeo.contentW !== geo.contentW) {
          diag('PDF_PAGE_GEOMETRY_VARIES',
            `page ${pages.length + 1} has a different content box (${Math.round(pageGeo.contentW)}×`
            + `${Math.round(pageGeo.contentH)}px) from the run's typical page `
            + `(${Math.round(geo.contentW)}×${Math.round(geo.contentH)}px). Content is assigned to `
            + 'pages using the typical geometry, so this page may hold more or less than the '
            + 'browser would put on it.', { page: pages.length + 1 });
        }
        pages.push({
          geo: pageGeo, pageName: run.page || '',
          runs: byColumn.get(c) || [],
          furniture: furnitureByColumn.get(c) || [],
          paint: paintByCol.get(c) || [],
          images: imagesByCol.get(c) || [],
          svg: svgByCol.get(c) || [],
          canvas: canvasByCol.get(c) || [],
          forms: formsByCol.get(c) || [],
          links: linksByCol.get(c) || [],
          markers: markersByCol.get(c) || [],
          box, pitch,
        });
      }

      frag.close();
      F.clearSpacers();
      for (const [el, display] of heldOut) el.style.display = display;
      for (const [el, display] of hidden) el.style.display = display;
    }

    if (!pages.length) {
      diag('PDF_NO_CONTENT', 'nothing was extracted from the given root');
    }

    // ---- 5. write the PDF -------------------------------------------------
    const doc = await PDFDocument.create();
    doc.registerFontkit(opts.fontkit);

    /** A ToUnicode CMap, in sections of 100 as PDF 32000-1 §9.10.3 requires. */
    function buildCMap(map) {
      const hex4 = (v) => v.toString(16).toUpperCase().padStart(4, '0');
      const dst = (str) => [...str].map((c) => {
        const cp = c.codePointAt(0);
        if (cp <= 0xFFFF) return hex4(cp);
        const v = cp - 0x10000;                       // surrogate pair, as UTF-16BE
        return hex4(0xD800 + (v >> 10)) + hex4(0xDC00 + (v & 0x3FF));
      }).join('');
      const entries = [...map.entries()].sort((a, b) => a[0] - b[0]);
      const out = [
        '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
        '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
        '1 begincodespacerange', '<0000><ffff>', 'endcodespacerange',
      ];
      for (let i = 0; i < entries.length; i += 100) {
        const chunk = entries.slice(i, i + 100);
        out.push(`${chunk.length} beginbfchar`);
        for (const [gid, str] of chunk) out.push(`<${hex4(gid)}> <${dst(str)}>`);
        out.push('endbfchar');
      }
      out.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
      return out.join('\n');
    }

    const embedded = new Map();
    /**
     * Which registered face backs each embedded pdf-lib font, and every
     * distinct string drawn with it. Both feed the ToUnicode rewrite below.
     */
    const faceOfFont = new Map();
    const textOfFont = new Map();
    const recordDrawn = (pdfFont, text) => {
      const set = textOfFont.get(pdfFont);
      if (set) set.add(text);
    };

    async function embedFor(face) {
      const key = `${face.family}|${face.weight}|${face.style}`;
      if (!embedded.has(key)) {
        // Subset by default. An earlier build disabled subsetting for WOFF and
        // WOFF2 on the belief that the subsetter hung on them; it does not —
        // measured in this browser, a WOFF2 subsets in 18 ms and an 18 MB CJK
        // TTF in 40 ms, while embedding that TTF whole takes 1.1 s and 12 MB.
        // Worse, embedding whole is what BROKE those fonts: a `wOFF`/`wOF2`
        // container is not a TrueType program, so the PDF got an unusable
        // FontFile2 and the text drew nothing at all. Faces that genuinely
        // cannot be embedded are refused by the registry before we get here.
        //
        // OpenType/CFF is the exception, and it has to go the other way:
        // fontkit's CFF subsetter is not usable. On one CFF face it produced a
        // font poppler refuses outright — "Couldn't create a font" — and every
        // glyph drew as an empty box, which is how an entire Korean document
        // came out as 90 % less ink than Chromium with no diagnostic at all. On
        // another it threw RangeError from CFFSubset.encode, which would take
        // the whole render down. So a CFF face is embedded whole, and the size
        // that costs is reported rather than paid silently.
        const isCFF = !!(face.fk && face.fk.directory && face.fk.directory.tables
          && face.fk.directory.tables['CFF ']);
        if (isCFF && opts.subset !== false) {
          diag('PDF_FONT_NOT_SUBSET',
            `"${face.family}" has OpenType/CFF outlines, whose subsetter produces a font that `
            + 'draws nothing, so the whole face is embedded. The PDF is much larger than it needs '
            + `to be — ${Math.round(face.bytes.byteLength / 1024)} KB for this face. Supply a `
            + 'TrueType-outline (TTF) version, or a CFF font already cut down to the glyphs you '
            + 'need.', { family: face.family, bytes: face.bytes.byteLength });
        }
        const pdfFont = await doc.embedFont(face.bytes, {
          subset: opts.subset !== false && !isCFF,
        });
        embedded.set(key, pdfFont);
        // Only a WHOLE-embedded font keeps the source font's glyph ids in the
        // PDF; a subset renumbers them, so a map built from fontkit ids would
        // be nonsense. That is fine, because the whole-embedded case is the one
        // pdf-lib gets wrong.
        if (isCFF || opts.subset === false) {
          faceOfFont.set(pdfFont, face);
          textOfFont.set(pdfFont, new Set());
        }
      }
      return embedded.get(key);
    }

    /**
     * Registered face if the page gave us bytes; otherwise a standard font.
     * Returns `substituted` because the 14 standard fonts are WinAnsi-only —
     * they cannot encode CJK, Arabic, Devanagari or anything else outside
     * Latin-1, and pdf-lib throws rather than dropping the glyph.
     */
    async function fontFor(f) {
      const face = registry.metricsFace({
        fontFamily: f.family, fontWeight: f.weight, fontStyle: f.style,
      });
      if (face) return { font: await embedFor(face), substituted: false, face };
      const std = standardFontFor(f.family, f.weight, f.style);
      if (!embedded.has(std)) embedded.set(std, await doc.embedFont(std));
      diag('PDF_FONT_SUBSTITUTED',
        `no embeddable bytes for "${f.family}" ${f.weight} ${f.style} — substituted the standard `
        + `font ${std}. Word positions still come from the browser's own measurements; only glyph `
        + 'shapes differ. Declare an @font-face to embed the real font.',
        { requested: f.family, substituted: std });
      return { font: embedded.get(std), substituted: true };
    }

    /**
     * Split a measured word into segments that one embedded face can draw.
     *
     * `fontRegistry` resolves metrics and glyphs separately on purpose: the
     * inline box comes from the primary family, the glyph from the first
     * declared family that COVERS the character. Until now only the metrics
     * half was wired in — the whole word went to the primary face, and pdf-lib
     * maps an uncovered code point to glyph 0 without complaining. A page of
     * Chinese set in a Latin family came out as several hundred U+0000 with no
     * diagnostic, which is the exact failure the registry was written to stop.
     *
     * Each segment carries its own measured x, so a fallback segment lands
     * where the browser put it rather than after an advance we computed.
     * Returns { segments, missing }.
     */
    function segmentWord(word, resolve) {
      // Older captures have no per-character extents; treat the word as one
      // segment so behaviour degrades to the previous path rather than throwing.
      const chars = word.chars || [{ ch: word.text, left: word.left, right: word.right }];
      const segments = [];
      const missing = [];
      let cur = null;
      for (const c of chars) {
        const key = resolve(c.ch.codePointAt(0));
        if (!key) {
          missing.push(c.ch);
          cur = null;                       // never emit a glyph we do not have
          continue;
        }
        if (cur && cur.key === key) { cur.text += c.ch; cur.chars.push(c); }
        else { cur = { key, text: c.ch, left: c.left, chars: [c] }; segments.push(cur); }
      }
      return { segments, missing };
    }

    /**
     * Split a segment wherever the font's own advances have drifted from where
     * the browser measured the characters.
     *
     * Word origins are already exact — they come from the browser. What is not
     * exact is the distance *inside* a word once a face has been substituted:
     * the standard font's advances are not the system font's, so letters walk
     * away from their measured positions as the string goes on. Measured on
     * `demo-mole`, string origins landed within 0.12 pt while string widths
     * were out by a median of 1.94 pt and as much as 5.60 pt.
     *
     * Splitting at a drift bound rather than at every character keeps whole
     * words in one text-showing operation wherever the font tracks the
     * measurement — which is every embedded face, so nothing changes for them —
     * and cuts only where it has actually gone wrong. Chromium's own output is
     * chunked the same way, so this costs nothing in extraction.
     */
    // Swept across the suite: 0.04 pt gave mean 2.86 %, 0.12 gave 2.88 %, 0.25
    // gave 2.88 %, with output size flat and extraction unchanged at every
    // setting. Nothing is bought by cutting finer, so this takes the loosest
    // bound that still holds drift below a fifth of a point.
    const DRIFT_LIMIT_PT = 0.12;
    function driftSplit(seg, font, sizePt, trackingPt) {
      const chars = seg.chars;
      if (!chars || chars.length < 2) return [{ text: seg.text, left: seg.left }];
      const out = [];
      let startIdx = 0;
      let expected = chars[0].left;                     // in CSS px
      for (let i = 1; i < chars.length; i++) {
        let adv;
        try {
          adv = font.widthOfTextAtSize(chars[i - 1].ch, sizePt) / PT + trackingPt / PT;
        } catch { adv = chars[i].left - chars[i - 1].left; }
        expected += adv;
        if (Math.abs(expected - chars[i].left) * PT > DRIFT_LIMIT_PT) {
          out.push({
            text: chars.slice(startIdx, i).map((c) => c.ch).join(''),
            left: chars[startIdx].left,
          });
          startIdx = i;
          expected = chars[i].left;                     // re-anchor on the measurement
        }
      }
      out.push({
        text: chars.slice(startIdx).map((c) => c.ch).join(''),
        left: chars[startIdx].left,
      });
      return out;
    }

    /** Resolver for a registered family: the face that covers this code point. */
    const faceResolver = (runFont) => {
      const cs = {
        fontFamily: runFont.family, fontWeight: runFont.weight, fontStyle: runFont.style,
      };
      return (cp) => registry.faceForCodePoint(cp, cs);
    };

    /**
     * WinAnsiEncoding, which is all the 14 standard fonts can encode: ASCII,
     * Latin-1 — and the 0x80–0x9F block, which is easy to forget and holds the
     * punctuation real documents are full of. The previous test was
     * `codePoint <= 0xFF`, which rejected all of it: a single en dash in
     * "300–400K tokens regardless of the model." made that whole line vanish
     * from the page, even though WinAnsi encodes an en dash perfectly well.
     */
    const WIN_ANSI_ABOVE_LATIN1 = new Set([
      0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030,
      0x0160, 0x2039, 0x0152, 0x017D, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022,
      0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x017E, 0x0178,
    ]);
    const winAnsiResolver = (font) => (cp) => (
      ((cp >= 0x20 && cp <= 0x7E) || (cp >= 0xA0 && cp <= 0xFF) || WIN_ANSI_ABOVE_LATIN1.has(cp))
        ? font : null);

    /**
     * Margin boxes and furniture draw a whole string at one measured x, so
     * they cannot be split into segments. Drop only the characters the
     * substituted font cannot encode, rather than the entire string: losing a
     * running header because one character in it is unencodable is far worse
     * than losing that character.
     */
    function stripUnencodable(text, family) {
      const ok = winAnsiResolver(true);
      let out = '', missing = [];
      for (const ch of text) {
        if (ok(ch.codePointAt(0))) out += ch;
        else missing.push(ch);
      }
      if (missing.length) {
        reportMissing('PDF_TEXT_NOT_ENCODABLE', family, missing,
          'The family had no embeddable bytes and the substituted standard font is '
          + 'WinAnsi-only. Declare an @font-face covering this script.');
      }
      return out;
    }

    /** Report dropped characters once per family, accumulating which they were. */
    function reportMissing(code, family, missing, advice) {
      const d = diag(code,
        `"${family}": some characters could not be drawn and are omitted rather than written `
        + `as U+0000. ${advice} See detail.chars for which.`,
        { family, chars: '', total: 0 });
      d.detail.total += missing.length;
      for (const ch of missing) {
        if (d.detail.chars.length < 40 && !d.detail.chars.includes(ch)) d.detail.chars += ch;
      }
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

    /**
     * The root element's background propagates to the canvas, so it paints the
     * whole page rather than just the root's box. `extractPaint` walks
     * `root.querySelectorAll('*')`, which never includes the root itself, so a
     * document that sets `html, body { background: … }` came out on white.
     */
    const canvasBackground = (() => {
      const TRANSPARENT = /^(rgba\(0,\s*0,\s*0,\s*0\)|transparent)$/;
      for (const el of [document.documentElement, document.body, root]) {
        if (!el) continue;
        const c = getComputedStyle(el).backgroundColor;
        if (c && !TRANSPARENT.test(c)) return c;
      }
      // `@page { background: … }` is not standard but Chromium honours it.
      for (const r of rules.values()) {
        if (r.background && !TRANSPARENT.test(r.background)) return r.background;
      }
      return null;
    })();

    const emitStats = { backgrounds: 0, gradients: 0, bgImages: 0, borders: 0,
      images: 0, svg: 0, links: 0, shadows: 0, blends: 0, canvases: 0,
      formFields: 0, formsFlattened: 0 };

    // Flattened form text is drawn with a standard font.
    const flattenFont = opts.forms === 'flatten' ? await doc.embedFont('Helvetica') : null;
    const addStats = (into, from) => { for (const k in from) into[k] = (into[k] || 0) + from[k]; };

    for (let i = 0; i < pages.length; i++) {
      const { geo, runs: pageRuns, box, pitch, pageName } = pages[i];
      const pdfPage = doc.addPage([geo.ptW, geo.ptH]);

      /**
       * Offset of a viewport x within its own column.
       *
       * This must use the SAME rule the fragmenter used to assign a box to a
       * column — floor with a 1e-3 epsilon, as in `columnOfRun` and
       * `colOfBox`. A raw `x % pitch` does not: a word that measures a
       * fraction of a pixel left of its column's origin, which the first word
       * of a line routinely does, gives `pitch - ε` instead of `-ε` and is
       * drawn a whole column away — at the far right of the page, on the line
       * it belongs to, in a document that otherwise looks fine.
       */
      const offsetInColumn = (vx) => {
        const rel = vx - box.left;
        return rel - Math.floor(rel / pitch + 1e-3) * pitch;
      };

      // ---- everything that is not text, painted beneath it -----------------
      // Viewport px -> page pt for THIS page's column.
      const xf = {
        PT,
        x: (vx) => (geo.mLeft + offsetInColumn(vx)) * PT,
        y: (vy) => geo.ptH - (geo.mTop + (vy - box.top)) * PT,
        /**
         * The x translation for an affine matrix that maps viewport x to page
         * x, for the column `refX` falls in.
         *
         * `x()` is deliberately NOT affine — it folds the column offset in —
         * so a matrix built as `{ a: PT, e: xf.x(0) }` is only right in the
         * first column. Every SVG from the second page onward was drawn at its
         * absolute viewport x, which is off the page entirely: a chart on
         * slide 5 simply was not there, while the identical chart on slide 1
         * was fine.
         */
        originX: (refX) => (geo.mLeft + offsetInColumn(refX) - refX) * PT,
      };
      // Canvas background first: it sits under everything, including the
      // page's own margins, which element boxes never reach.
      if (canvasBackground) {
        const c = cssColorToRgb(canvasBackground, rgb);
        pdfPage.drawRectangle({ x: 0, y: 0, width: geo.ptW, height: geo.ptH, color: c });
        emitStats.canvasBackground = (emitStats.canvasBackground || 0) + 1;
      }
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
        let { text } = F.resolveMarginContent(mb.content, i + 1, pages.length);
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

        const mbf = await fontFor({
          family, weight: mb.font.weight || DEF.weight, style: mb.font.style || DEF.style,
        });
        const font = mbf.font;
        if (mbf.substituted) {
          text = stripUnencodable(text, family);
          if (!text) continue;
        }

        recordDrawn(font, text);
        const width = font.widthOfTextAtSize(text, size * PT);
        let x;
        if (place.align === 'left') x = place.contentL * PT;
        else if (place.align === 'right') x = place.contentR * PT - width;
        else x = ((place.contentL + place.contentR) / 2) * PT - width / 2;

        try {
          pdfPage.drawText(text, {
            x, y: geo.ptH - place.baseline * PT, size: size * PT, font, color: rgb(0, 0, 0),
          });
        } catch (e) {
          diag('PDF_GLYPH_UNAVAILABLE', `margin box ${mb.slot}: ${e.message}`);
        }
      }
      const drawFurniture = async (want) => {
        for (const item of pages[i].furniture) {
          if (want === 'fixed' ? item.kind !== 'fixed' : item.kind === 'fixed') continue;

        for (const p of item.placed) {
          const ff = await fontFor(p.run.font);
          const font = ff.font;
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
            const wordText = ff.substituted
              ? stripUnencodable(word.text, p.run.font.family) : word.text;
            if (!wordText) continue;
            recordDrawn(font, wordText);
            try {
              pdfPage.drawText(wordText, {
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

      // Positioned content is written after in-flow content — the one way
      // Chromium's text order departs from document order. Runs are keyed by
      // the tree index of their nearest positioned ancestor, which is the order
      // step 8 of CSS 2.1 Appendix E paints those elements in; -1 (in flow)
      // sorts first. Stable, so everything else keeps DOM order.
      const keys = pageRuns.map((r) => r.positionedKey).filter((d) => typeof d === 'number');
      const orderedRuns = keys.length === pageRuns.length && new Set(keys).size > 1
        ? [...pageRuns].sort((a, b) => a.positionedKey - b.positionedKey)
        : pageRuns;

      // List markers. The placement rule is the one derived from Chromium's own
      // output: a numeric marker's RIGHT edge sits one space-advance before the
      // list item's content box, and a bullet is a synthesised disc rather than
      // the font's glyph, because Chromium paints it as a path. Each is drawn
      // immediately before the first run of the item it belongs to, which is
      // where Chromium writes it.
      async function drawMarker(mk) {
        const yPt = geo.ptH - (geo.mTop + (mk.baseline - box.top)) * PT;
        const rightPt = (geo.mLeft + offsetInColumn(mk.right)) * PT;

        if (mk.kind === 'text') {
          const mf = await fontFor({
            family: mk.fontFamily, weight: mk.fontWeight, style: 'normal',
          });
          const text = mf.substituted ? stripUnencodable(mk.text, mk.fontFamily) : mk.text;
          if (!text) return;
          recordDrawn(mf.font, text);
          const sizePt = mk.fontSize * PT;
          try {
            pdfPage.drawText(text, {
              x: rightPt - mf.font.widthOfTextAtSize(text, sizePt),
              y: yPt, size: sizePt, font: mf.font, color: cssColorToRgb(mk.color, rgb),
            });
          } catch (e) {
            diag('PDF_GLYPH_UNAVAILABLE', `list marker: ${e.message}`);
          }
          emitStats.markers = (emitStats.markers || 0) + 1;
        } else if (E && emitCtx) {
          const rad = (mk.size / 2) * PT;
          const c = cssColorToRgb(mk.color, rgb);
          pdfPage.drawCircle({
            x: rightPt - rad, y: yPt + rad, size: rad,
            color: mk.shape === 'disc' ? c : undefined,
            borderColor: mk.shape === 'disc' ? undefined : c,
            borderWidth: mk.shape === 'disc' ? 0 : 0.7,
          });
          emitStats.markers = (emitStats.markers || 0) + 1;
        }
      }

      const pendingMarkers = new Map();
      for (const mk of pages[i].markers || []) if (mk.li) pendingMarkers.set(mk.li, mk);

      const drawMarkerFor = async (el) => {
        if (!pendingMarkers.size || !el) return;
        for (let e = el; e; e = e.parentElement) {
          const mk = pendingMarkers.get(e);
          if (!mk) continue;
          pendingMarkers.delete(e);
          if (Number.isFinite(mk.baseline)) await drawMarker(mk);
          return;
        }
      };

      for (const run of orderedRuns) {
        await drawMarkerFor(run.el);
        const { font, substituted, face: metrics } = await fontFor(run.font);
        // Either way the run is segmented per character: by which registered
        // face covers it, or by what WinAnsi can encode. Nothing is dropped at
        // run granularity any more.
        const resolve = substituted ? winAnsiResolver(font) : faceResolver(run.font);

        // baseline = font-box top + ascent (findings 01; source-confirmed)
        const yPx = geo.mTop + (run.baselineCandidates.topPlusFontAscent - box.top);
        const y = geo.ptH - yPx * PT;

        const ls = parseFloat(run.font.letterSpacing);
        const tracking = Number.isFinite(ls) ? ls * PT : 0;
        if (tracking) pdfPage.pushOperators(setCharacterSpacing(tracking));

        for (const word of run.words) {
          // Per-word measured positions: the browser already decided where each
          // word sits, so shaping divergence cannot accumulate across a line.
          const draw = (text, leftPx, f) => {
            const xPx = geo.mLeft + offsetInColumn(leftPx);
            recordDrawn(f, text);
            try {
              pdfPage.drawText(text, {
                x: xPx * PT, y,
                size: run.font.size * PT,
                font: f,
                color: cssColorToRgb(run.color, rgb),
                // pdf-lib rotates about the text origin, which is exactly the
                // baseline origin the SVG DOM reported.
                ...(run.rotationDeg && degrees ? { rotate: degrees(run.rotationDeg) } : {}),
              });
            } catch (e) {
              diag('PDF_GLYPH_UNAVAILABLE', `could not draw ${JSON.stringify(text)}: ${e.message}`,
                { family: run.font.family });
            }
          };

          const { segments, missing } = segmentWord(word, resolve);
          for (const seg of segments) {
            const f = substituted ? font
              : (seg.key === metrics ? font : await embedFor(seg.key));
            for (const piece of driftSplit(seg, f, run.font.size * PT, tracking)) {
              draw(piece.text, piece.left, f);
            }
          }
          if (missing.length) {
            // The message must not name the characters: `diag` dedups on it,
            // and a page of Chinese would otherwise report several hundred
            // near-identical entries instead of one with a count. The
            // characters go in `detail`, which accumulates across the run.
            const d = diag(substituted ? 'PDF_TEXT_NOT_ENCODABLE' : 'PDF_GLYPH_UNAVAILABLE',
              substituted
                ? `"${run.font.family}" had no embeddable bytes, and the substituted standard `
                  + 'font is WinAnsi-only, so some characters are omitted. Declare an @font-face '
                  + 'covering this script. See detail.chars for which.'
                : `No declared family in "${run.font.family}" has a glyph for some of this text. `
                  + 'Those characters are omitted rather than written as U+0000. Declare an '
                  + '@font-face covering this script. See detail.chars for which.',
              { family: run.font.family, chars: '', total: 0 });
            d.detail.total += missing.length;
            for (const ch of missing) {
              if (d.detail.chars.length < 40 && !d.detail.chars.includes(ch)) d.detail.chars += ch;
            }
          }
        }
        if (tracking) pdfPage.pushOperators(setCharacterSpacing(0));
      }

      // Any marker whose item produced no text run at all still has to be
      // drawn; the rest went out interleaved, above.
      for (const mk of pendingMarkers.values()) {
        if (Number.isFinite(mk.baseline)) await drawMarker(mk);
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

    // ---- ToUnicode, written from what was actually drawn -----------------
    //
    // pdf-lib derives its ToUnicode from the glyphs it has cached, mapping each
    // through fontkit's REVERSE cmap. That is wrong for any glyph a font's GSUB
    // table substituted in: shaping "28K" with Source Han Serif KR yields the
    // alternate figures 22581 and 22587, and pdf-lib wrote glyph 22581 -> U+0E2F
    // and no entry at all for 22587 — so a résumé that says "28K" copied out of
    // the PDF as "堵堻K". It also emits every entry in a single `beginbfchar`
    // section, 22 410 of them where PDF 32000-1 §9.10.3 allows 100.
    //
    // The forward direction is not in doubt: `layout()` returns glyphs whose
    // `codePoints` are the characters that produced them. Every glyph in this
    // document came from a string we drew, so laying those strings out again
    // gives a map that is both correct and complete — and far smaller, since
    // pdf-lib's covered most of the font.
    async function rewriteToUnicode() {
      if (!PDFName || !doc.context || typeof doc.context.flateStream !== 'function') return;
      for (const [pdfFont, face] of faceOfFont) {
        const texts = textOfFont.get(pdfFont);
        if (!texts || !texts.size || !face.fk) continue;
        const map = new Map();
        for (const t of texts) {
          let glyphs;
          try { glyphs = face.fk.layout(t).glyphs; } catch { continue; }
          for (const g of glyphs) {
            if (!g || !g.codePoints || !g.codePoints.length || map.has(g.id)) continue;
            map.set(g.id, String.fromCodePoint(...g.codePoints));
          }
        }
        if (!map.size) continue;
        try {
          await pdfFont.embed();                     // create the dict now
          const dict = doc.context.lookup(pdfFont.ref);
          if (!dict || typeof dict.set !== 'function') continue;
          // Drop the map being replaced; pdf-lib keeps no reference count, so
          // leaving it behind carries its 315 KB into every saved file.
          const old = dict.get(PDFName.of('ToUnicode'));
          if (old && typeof doc.context.delete === 'function') doc.context.delete(old);
          dict.set(PDFName.of('ToUnicode'), doc.context.register(
            doc.context.flateStream(buildCMap(map))));
        } catch (e) {
          diag('PDF_TOUNICODE_NOT_REWRITTEN',
            'The PDF text layer keeps pdf-lib\'s own character map, which is wrong for glyphs a '
            + `font substitutes: ${e.message}`, { family: face.family });
        }
      }
    }
    await rewriteToUnicode();

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

  /**
   * THE public surface — one object, so the browser global and the ES module
   * exports cannot drift apart. They previously did: `download`, `open` and
   * `renderToBlob` existed only on the global, while `FontRegistry` and
   * `furniture` existed only as ES exports. build.js now asserts this list
   * against what it exports and fails the build on a mismatch.
   */
  const API = {
    // rendering
    render,
    renderToBlob,
    download,
    open: open_,
    // inspection, for deciding what to do before rendering
    discoverFonts,
    unhandledContent,
    // lower-level pieces, for callers driving the pipeline themselves
    extractTextRuns: globalThis.__pdf_extractTextRuns,
    materializeGenerated: globalThis.__pdf_materializeGenerated,
    extractMarkers: globalThis.__pdf_extractMarkers,
    FontRegistry: globalThis.__pdf_FontRegistry,
    furniture: globalThis.__pdf_furniture,
    emit: globalThis.__pdf_emit,
    version: '0.1.0-alpha.2',
  };

  // `Garri` is the package name; `PeeDeeEff` is kept as an alias so existing
  // script tags and the demo keep working.
  globalThis.Garri = API;
  globalThis.PeeDeeEff = API;
})();
