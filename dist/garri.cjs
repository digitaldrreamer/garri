/*! garri 0.1.0-alpha.1 — CommonJS bundle
 * Client-side HTML to PDF in the browser: native PDF with selectable text, embedded fonts and vector graphics, by reusing the browser as the layout engine
 * Requires pdf-lib and @pdf-lib/fontkit to be supplied by the caller.
 * Bundled modules: paintOrder.js, textRuns.js, generated.js, paint.js, images.js, canvas.js, forms.js, links.js, svg.js, svgPath.js, emit.js, fontRegistry.js, furniture.js, index.js
 */
(function () {
'use strict';
// ===== src/capture/paintOrder.js =====
/**
 * Static paint-order reconstruction.
 *
 * Plan §12: DOM order is not paint order. Chromium decides painting from
 * stacking contexts, z-index, positioning and a handful of properties that
 * silently create new contexts. None of that is exposed directly — but all of
 * its *inputs* are readable from computed style, so the order can be recomputed
 * rather than observed.
 *
 * This implements the CSS 2.1 Appendix E painting algorithm over the subset a
 * document renderer actually meets. It is the one place in the architecture
 * where we deliberately reimplement browser logic, because there is no API that
 * will answer the question for us.
 *
 * Installs globalThis.__pdf_paintOrder(root) -> ordered array of elements.
 */
(function () {
  /**
   * Does this element establish a stacking context?
   * Subset of the full list, covering what documents actually use.
   */
  function isStackingContext(el, cs) {
    if (el === document.documentElement) return true;

    const positioned = cs.position !== 'static';
    const zAuto = cs.zIndex === 'auto';

    // Positioned with an explicit z-index.
    if (positioned && !zAuto) return true;
    // Fixed and sticky always do, regardless of z-index.
    if (cs.position === 'fixed' || cs.position === 'sticky') return true;

    if (parseFloat(cs.opacity) < 1) return true;
    if (cs.transform && cs.transform !== 'none') return true;
    if (cs.filter && cs.filter !== 'none') return true;
    if (cs.perspective && cs.perspective !== 'none') return true;
    if (cs.clipPath && cs.clipPath !== 'none') return true;
    if (cs.mask && cs.mask !== 'none' && cs.mask !== 'match-source') return true;
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') return true;
    if (cs.isolation === 'isolate') return true;
    if (cs.contain && /paint|layout|strict|content/.test(cs.contain)) return true;
    if (cs.willChange && /transform|opacity|filter/.test(cs.willChange)) return true;

    // A flex or grid item with an explicit z-index.
    const parent = el.parentElement;
    if (parent && !zAuto) {
      const pd = getComputedStyle(parent).display;
      if (/flex|grid/.test(pd)) return true;
    }
    return false;
  }

  function visible(cs) {
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  function zIndexOf(cs) {
    return cs.zIndex === 'auto' ? null : parseInt(cs.zIndex, 10);
  }

  /**
   * Paint one stacking context, returning its elements in painting order.
   *
   * CSS 2.1 Appendix E, steps that matter for block-level document content:
   *   1. the context root's own background and borders
   *   2. child stacking contexts with negative z-index, most negative first
   *   3. in-flow, non-positioned, block-level descendants
   *   4. non-positioned floats
   *   5. in-flow inline-level descendants
   *   6. positioned descendants with z-index auto/0
   *   7. child stacking contexts with positive z-index, ascending
   */
  function paintStackingContext(root) {
    const flow = [];      // step 3
    const floats = [];    // step 4
    const inlines = [];   // step 5
    const negZ = [];      // step 2
    const zeroZ = [];     // step 6
    const posZ = [];      // step 7

    function walk(el) {
      for (const child of el.children) {
        const cs = getComputedStyle(child);
        if (!visible(cs)) continue;

        const sc = isStackingContext(child, cs);
        const positioned = cs.position !== 'static';
        const z = zIndexOf(cs);

        if (sc) {
          // Atomic: its whole subtree paints together, at its own z position.
          if (z !== null && z < 0) negZ.push({ el: child, z });
          else if (z !== null && z > 0) posZ.push({ el: child, z });
          else zeroZ.push({ el: child, atomic: true });
          continue;
        }

        if (positioned) {
          // Positioned with z-index:auto — paints in step 6, but does NOT
          // establish a context, so its descendants still participate here.
          zeroZ.push({ el: child, atomic: false });
          continue;
        }

        if (cs.float !== 'none') {
          floats.push(child);
          walk(child);
          continue;
        }

        if (/^inline/.test(cs.display)) inlines.push(child);
        else flow.push(child);
        walk(child);
      }
    }

    walk(root);

    negZ.sort((a, b) => a.z - b.z);
    posZ.sort((a, b) => a.z - b.z);

    const out = [root];
    for (const n of negZ) out.push(...paintStackingContext(n.el));
    out.push(...flow, ...floats, ...inlines);
    for (const item of zeroZ) {
      // Both cases paint their subtree here; only a real stacking context
      // re-runs the full algorithm internally.
      out.push(...paintStackingContext(item.el));
    }
    for (const p of posZ) out.push(...paintStackingContext(p.el));
    return out;
  }

  globalThis.__pdf_paintOrder = function (root) {
    return paintStackingContext(root);
  };
  globalThis.__pdf_isStackingContext = isStackingContext;
})();

// ===== src/capture/textRuns.js =====
/**
 * In-page text-run extractor.
 *
 * Runs inside the rendered document and treats the browser as a layout oracle:
 * it never decides where a line *should* break, only observes where Chromium
 * already broke it.
 *
 * Installs globalThis.__pdf_extractTextRuns(root, opts) -> { runs, stats }
 */
(function () {
  const PX_PER_LINE_BUCKET = 0.5; // tolerance when grouping chars into a line

  /** Font ascent/descent in px for a given computed style, via canvas metrics. */
  const metricsCache = new Map();
  function fontMetrics(style) {
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} / normal ${style.fontFamily}`;
    if (metricsCache.has(font)) return metricsCache.get(font);
    const ctx = (fontMetrics._ctx ||= document.createElement('canvas').getContext('2d'));
    ctx.font = font;
    const m = ctx.measureText('Hxlpqg');
    const out = {
      font,
      ascent: m.fontBoundingBoxAscent,
      descent: m.fontBoundingBoxDescent,
      // alphabetic baseline metrics of the actual sample, for cross-checking
      actualAscent: m.actualBoundingBoxAscent,
      actualDescent: m.actualBoundingBoxDescent,
    };
    metricsCache.set(font, out);
    return out;
  }

  /**
   * Split one text node into the line fragments Chromium actually produced.
   *
   * Strategy: probe every character with a 1-char Range and bucket by the
   * rect's vertical position. This is the O(n) correctness baseline described
   * in the plan; grouping optimisations come later, once it is known to be
   * right.
   */
  function lineFragments(textNode) {
    const data = textNode.data;
    const range = document.createRange();
    const chars = [];

    for (let i = 0; i < data.length; i++) {
      range.setStart(textNode, i);
      range.setEnd(textNode, i + 1);
      const rects = range.getClientRects();
      if (rects.length === 0) continue; // collapsed whitespace, not rendered
      // A single char can report >1 rect only in odd cases; take the first.
      const r = rects[0];
      if (r.width === 0 && data[i].trim() === '') continue; // collapsed at line edge
      chars.push({ i, ch: data[i], top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    }

    // Group consecutive characters sharing a line box.
    const lines = [];
    let cur = null;
    for (const c of chars) {
      if (!cur || Math.abs(c.top - cur.top) > PX_PER_LINE_BUCKET) {
        cur = {
          top: c.top, bottom: c.bottom,
          left: c.left, right: c.right,
          startOffset: c.i, endOffset: c.i + 1,
          text: c.ch,
        };
        lines.push(cur);
      } else {
        cur.left = Math.min(cur.left, c.left);
        cur.right = Math.max(cur.right, c.right);
        cur.bottom = Math.max(cur.bottom, c.bottom);
        cur.endOffset = c.i + 1;
        cur.text += c.ch;
      }
    }

    // Trim collapsed whitespace at the fragment edges. A leading space is part
    // of the text node but is not part of the painted run: Chromium starts the
    // glyph run at the first non-space glyph, so including it would shift the
    // run's origin left by one space advance.
    for (const ln of lines) {
      let s = ln.startOffset;
      let e = ln.endOffset;
      while (s < e && /\s/.test(data[s])) s++;
      while (e > s && /\s/.test(data[e - 1])) e--;
      ln.startOffset = s;
      ln.endOffset = e;
      ln.text = data.slice(s, e);
    }

    // Recover each line's exact extents with one Range over the whole line,
    // rather than trusting the union of per-character rects.
    for (const ln of lines) {
      range.setStart(textNode, ln.startOffset);
      range.setEnd(textNode, ln.endOffset);
      const r = range.getBoundingClientRect();
      ln.rangeRect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };

      // Word-level origins, measured rather than derived. Letter-spacing,
      // word-spacing, kerning and justification all move glyphs in ways a PDF
      // font's own advances will not reproduce; taking each word's x from the
      // browser makes those differences structurally impossible.
      ln.words = [];
      let w = null;
      for (let i = ln.startOffset; i < ln.endOffset; i++) {
        if (/\s/.test(data[i])) { w = null; continue; }
        range.setStart(textNode, i);
        range.setEnd(textNode, i + 1);
        const cr = range.getBoundingClientRect();
        if (!w) {
          w = { text: data[i], left: cr.left, right: cr.right };
          ln.words.push(w);
        } else {
          w.text += data[i];
          // Take the extent across every character, not the first and last.
          // In RTL the first logical character is the RIGHTMOST one, so
          // first/last would report the word's box inside out and every word
          // would be drawn on top of its neighbour.
          w.left = Math.min(w.left, cr.left);
          w.right = Math.max(w.right, cr.right);
        }
      }
    }

    range.detach?.();
    return lines.filter((ln) => ln.text.length > 0);
  }

  function isRendered(el) {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  }

  function extractTextRuns(root, opts = {}) {
    const t0 = performance.now();
    const runs = [];
    let charProbes = 0;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.data || !node.data.trim()) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p || !isRendered(p)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node;
    while ((node = walker.nextNode())) {
      const el = node.parentElement;
      const style = getComputedStyle(el);
      const fm = fontMetrics(style);
      charProbes += node.data.length;

      for (const ln of lineFragments(node)) {
        runs.push({
          text: ln.text,
          words: ln.words,
          // Geometry exactly as the browser reported it.
          rect: ln.rangeRect,
          // Candidate baselines to be scored against Chromium's own PDF output.
          baselineCandidates: {
            topPlusFontAscent: ln.rangeRect.top + fm.ascent,
            topPlusActualAscent: ln.rangeRect.top + fm.actualAscent,
            bottomMinusFontDescent: ln.rangeRect.bottom - fm.descent,
          },
          font: {
            family: style.fontFamily,
            size: parseFloat(style.fontSize),
            weight: style.fontWeight,
            style: style.fontStyle,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
            wordSpacing: style.wordSpacing,
            ascent: fm.ascent,
            descent: fm.descent,
          },
          color: style.color,
          selector: el.id ? `#${el.id}` : el.tagName.toLowerCase(),
        });
      }
    }

    return {
      runs,
      stats: {
        runCount: runs.length,
        charProbes,
        extractMs: performance.now() - t0,
      },
    };
  }

  globalThis.__pdf_extractTextRuns = extractTextRuns;
})();

// ===== src/capture/generated.js =====
/**
 * Generated content: ::before, ::after, counters, and list markers.
 *
 * Pseudo-elements have no DOM node, so there is no rect to read and no Range to
 * walk — the text extractor cannot see them at all. Findings 03 caught this as
 * missing `::marker` text; it affects `::before`/`::after`/`counter()` the same
 * way.
 *
 * Two different strategies, because the browser exposes two different amounts:
 *
 *   ::before / ::after  MATERIALISE. Replace the pseudo with a real inline
 *                       element carrying its computed style and resolved text,
 *                       then the existing text pipeline measures it exactly and
 *                       no new geometry code is needed.
 *
 *   ::marker            COMPUTE. Chrome reports `content: normal` and no text,
 *                       and an outside marker sits in the padding area where a
 *                       materialised span would not land. Its placement rule was
 *                       derived from Chromium's own output instead (see below).
 *
 * Installs globalThis.__pdf_materializeGenerated(root).
 */
(function () {
  // ---------------------------------------------------------------- counters
  //
  // getComputedStyle resolves attr() for us but NOT counter(): the content
  // string comes back as `"Step " counter(step) ": "`. So counters have to be
  // run here.

  function parseCounterDecl(v) {
    // "step 1" | "a 2 b 3" | "none"
    const out = [];
    if (!v || v === 'none') return out;
    const toks = String(v).trim().split(/\s+/);
    for (let i = 0; i < toks.length; i++) {
      const name = toks[i];
      const num = parseInt(toks[i + 1], 10);
      if (Number.isFinite(num)) { out.push({ name, value: num }); i++; }
      else out.push({ name, value: null });
    }
    return out;
  }

  const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];

  function formatCounter(n, style) {
    switch (style) {
      case 'decimal-leading-zero': return (n < 10 && n >= 0 ? '0' : '') + n;
      case 'lower-alpha': case 'lower-latin': case 'upper-alpha': case 'upper-latin': {
        let s = '', v = n;
        while (v > 0) { const r = (v - 1) % 26; s = String.fromCharCode(97 + r) + s; v = Math.floor((v - 1) / 26); }
        s = s || String(n);
        return /upper/.test(style) ? s.toUpperCase() : s;
      }
      case 'lower-roman': case 'upper-roman': {
        let v = n, s = '';
        if (v <= 0 || v > 3999) return String(n);
        for (const [val, sym] of ROMAN) while (v >= val) { s += sym; v -= val; }
        return style === 'upper-roman' ? s.toUpperCase() : s;
      }
      case 'none': return '';
      default: return String(n);
    }
  }

  /**
   * Walk the tree maintaining CSS counter scopes. Nested scopes are modelled as
   * a stack per name: `counter-reset` pushes for the element's subtree.
   */
  function buildCounters(root) {
    const scopes = new Map();            // name -> [{ value, owner }]
    const valuesFor = new WeakMap();     // element -> { before:{}, after:{}, self:{} }

    const readAll = () => {
      const snap = {};
      for (const [name, stack] of scopes) if (stack.length) snap[name] = stack[stack.length - 1].value;
      return snap;
    };
    const allOf = (name) => (scopes.get(name) || []).map((s) => s.value);

    function increment(decl, def) {
      for (const { name, value } of parseCounterDecl(decl)) {
        let stack = scopes.get(name);
        if (!stack || !stack.length) { stack = [{ value: 0, owner: null }]; scopes.set(name, stack); }
        stack[stack.length - 1].value += (value === null ? def : value);
      }
    }

    (function walk(el) {
      const cs = getComputedStyle(el);
      const opened = [];

      for (const { name, value } of parseCounterDecl(cs.counterReset)) {
        let stack = scopes.get(name);
        if (!stack) { stack = []; scopes.set(name, stack); }
        stack.push({ value: value === null ? 0 : value, owner: el });
        opened.push(name);
      }

      const beforeCS = getComputedStyle(el, '::before');
      increment(beforeCS.counterIncrement, 1);
      const beforeSnap = { flat: readAll(), all: (n) => allOf(n) };

      increment(cs.counterIncrement, 1);
      const selfSnap = readAll();

      valuesFor.set(el, { before: beforeSnap.flat, self: selfSnap, allBefore: beforeSnap.all });

      for (const child of el.children) walk(child);

      const afterCS = getComputedStyle(el, '::after');
      increment(afterCS.counterIncrement, 1);
      const rec = valuesFor.get(el);
      rec.after = readAll();

      for (const name of opened) scopes.get(name).pop();
    })(root);

    return valuesFor;
  }

  /** Turn a computed `content` value into text, resolving counter()/counters(). */
  function resolveContent(content, counterValues, allValues) {
    if (!content || content === 'none' || content === 'normal') return null;
    let out = '';
    // tokens: quoted strings, counter(...), counters(...), url(...)
    const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|counters\(([^)]*)\)|counter\(([^)]*)\)|(\S+)/g;
    let m, sawUnknown = false;
    while ((m = re.exec(content)) !== null) {
      if (m[1] !== undefined) out += m[1].replace(/\\(.)/g, '$1');
      else if (m[2] !== undefined) out += m[2].replace(/\\(.)/g, '$1');
      else if (m[3] !== undefined) {
        const parts = m[3].split(',').map((s) => s.trim());
        const name = parts[0];
        const sep = (parts[1] || '""').replace(/^["']|["']$/g, '');
        const style = parts[2] || 'decimal';
        out += (allValues(name) || []).map((v) => formatCounter(v, style)).join(sep);
      } else if (m[4] !== undefined) {
        const parts = m[4].split(',').map((s) => s.trim());
        const v = counterValues[parts[0]] ?? 0;
        out += formatCounter(v, parts[1] || 'decimal');
      } else if (m[5] && m[5] !== 'normal') {
        sawUnknown = true;                       // url(), open-quote, etc.
      }
    }
    return { text: out, sawUnknown };
  }

  // ------------------------------------------------------------ list markers
  //
  // Placement rule, derived from Chromium's own PDF rather than assumed:
  // every marker's RIGHT edge sits one space-advance before the list item's
  // content-box left edge. Measured at 16px Roboto the gap was 3.97px against a
  // space advance of 3.96px, across decimal and roman markers of differing
  // widths.

  // Bullets are emitted as their Unicode glyph rather than a synthesised
  // shape. Chromium paints them as paths, but the ink measured identical in
  // size -- it is drawing the glyph outline. Going through the font means the
  // side bearings position the ink for us, instead of needing a second,
  // bullet-specific placement rule (an earlier synthesised circle sat 8.00 px
  // too far right for exactly that reason). It also keeps the bullet copyable.
  const BULLET = { disc: 1, circle: 1, square: 1 };
  // Measured against Chromium at two font sizes:
  //    16 px -> diameter 6.40 (0.400 em), gap 11.60 (0.725 em)
  //    26 px -> diameter 9.60 (0.369 em), gap 15.60 (0.600 em)
  // The rule is NOT linear in em, so these constants are exact at 16 px and an
  // approximation elsewhere. Deliberately not generalised from one data point.
  const BULLET_SIZE_EM = 0.40;
  const BULLET_GAP_EM = 0.725;
  const BULLET_CALIBRATED_PX = 16;

  function markerOrdinal(li) {
    const explicit = parseInt(li.getAttribute('value'), 10);
    if (Number.isFinite(explicit)) return explicit;
    const parent = li.parentElement;
    const items = [...parent.children].filter((c) => c.tagName === 'LI');
    const idx = items.indexOf(li);
    const start = parseInt(parent.getAttribute('start'), 10);
    if (parent.hasAttribute('reversed')) {
      const base = Number.isFinite(start) ? start : items.length;
      return base - idx;
    }
    let n = Number.isFinite(start) ? start : 1;
    for (let i = 0; i < idx; i++) {
      const v = parseInt(items[i].getAttribute('value'), 10);
      if (Number.isFinite(v)) n = v + 1; else n++;
    }
    return n;
  }

  const markerDiagnostics = [];
  function extractMarkers(root, spaceWidthOf) {
    const out = [];
    markerDiagnostics.length = 0;
    for (const li of root.querySelectorAll('li')) {
      const cs = getComputedStyle(li);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const type = cs.listStyleType;
      if (type === 'none' || cs.listStylePosition !== 'outside') continue;

      const r = li.getBoundingClientRect();
      const contentLeft = r.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
      const mcs = getComputedStyle(li, '::marker');
      const fontSize = parseFloat(mcs.fontSize || cs.fontSize);
      const color = mcs.color || cs.color;

      if (BULLET[type]) {
        // Chromium paints bullets as paths, and NOT from the font's own bullet
        // glyph: Roboto's U+2022 ink is 3.2 px at 16 px where Chromium's marker
        // is 6.4 px. So the shape is synthesised, with both size and gap
        // expressed in em and checked at two font sizes.
        if (Math.abs(fontSize - BULLET_CALIBRATED_PX) > 0.5) {
          markerDiagnostics.push({
            code: 'PDF_MARKER_APPROXIMATE',
            detail: `bullet at ${fontSize}px; placement calibrated at ${BULLET_CALIBRATED_PX}px and does not scale linearly`,
          });
        }
        out.push({
          kind: 'shape', shape: type, color,
          size: fontSize * BULLET_SIZE_EM,
          right: contentLeft - fontSize * BULLET_GAP_EM,
          li,
        });
      } else {
        out.push({
          kind: 'text', text: formatCounter(markerOrdinal(li), type) + '.', color,
          fontSize, fontFamily: mcs.fontFamily || cs.fontFamily,
          fontWeight: mcs.fontWeight || cs.fontWeight,
          right: contentLeft - spaceWidthOf(cs), li,
        });
      }
    }
    return out;
  }

  // -------------------------------------------------------- materialisation
  const STYLE_ID = '__pdf_pseudo_suppress';

  function materialize(root) {
    const counterMap = buildCounters(document.documentElement);
    const diagnostics = [];
    let count = 0;

    // Suppress the originals once, so nothing is painted twice.
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent =
        '.__pdf_mat::before,.__pdf_mat::after{content:none !important;}';
      document.head.appendChild(st);
    }

    const COPY = [
      'color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
      'letterSpacing', 'wordSpacing', 'textTransform', 'textDecoration',
      'backgroundColor', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
      'borderRadius', 'verticalAlign', 'display', 'whiteSpace',
    ];

    for (const el of [...root.querySelectorAll('*')]) {
      const rec = counterMap.get(el) || { before: {}, after: {}, allBefore: () => [] };

      // Read BOTH pseudo-elements before touching the element. Adding the
      // suppression class for ::before also suppresses ::after, so reading
      // them one at a time silently loses the second.
      const pending = [];
      for (const which of ['::before', '::after']) {
        const pcs = getComputedStyle(el, which);
        const resolved = resolveContent(pcs.content, which === '::before' ? rec.before : rec.after, rec.allBefore);
        if (resolved) pending.push({ which, pcs, resolved });
      }

      for (const { which, pcs, resolved } of pending) {
        if (resolved.sawUnknown) {
          diagnostics.push({
            code: 'PDF_GENERATED_CONTENT_PARTIAL', selector: (el.id ? '#' + el.id : el.tagName.toLowerCase()) + which,
            message: `content contains a value this extractor does not resolve: ${pcs.content}`,
          });
        }
        if (!resolved.text) continue;

        const span = document.createElement('span');
        span.setAttribute('data-pdf-pseudo', which);
        span.textContent = resolved.text;
        for (const p of COPY) {
          const v = pcs[p];
          if (v) span.style[p] = v;
        }
        // a pseudo defaults to inline; keep it so unless the author changed it
        if (pcs.display === 'block' || pcs.display === 'inline-block') span.style.display = pcs.display;
        else span.style.display = 'inline';

        el.classList.add('__pdf_mat');
        if (which === '::before') el.insertBefore(span, el.firstChild);
        else el.appendChild(span);
        count++;
      }
    }
    return { count, diagnostics };
  }

  globalThis.__pdf_materializeGenerated = function (root) {
    const ctx = document.createElement('canvas').getContext('2d');
    const spaceWidthOf = (cs) => {
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      return ctx.measureText(' ').width;
    };
    // Markers must be read BEFORE materialisation changes the line boxes.
    const markers = extractMarkers(root, spaceWidthOf);
    const mat = materialize(root);
    return { markers, ...mat, diagnostics: [...mat.diagnostics, ...markerDiagnostics] };
  };
  globalThis.__pdf_formatCounter = formatCounter;
})();

// ===== src/capture/paint.js =====
/**
 * Paint features beyond flat fills: gradients, background images, and clips.
 *
 * These were the largest remaining untested group. Each is read from computed
 * style — which is already resolved (colours are rgb(), lengths are px) — and
 * described structurally so the backend can emit a native PDF construct rather
 * than a raster approximation.
 *
 * Installs globalThis.__pdf_extractPaint(root).
 */
(function () {
  const parseColor = (s) => {
    const m = String(s).match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.%]+))?\s*\)/);
    if (!m) return null;
    let a = m[4] === undefined ? 1 : (String(m[4]).endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return { r: +m[1], g: +m[2], b: +m[3], a };
  };

  /** Split a function's argument list on top-level commas. */
  function splitArgs(s) {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  const pct = (tok, base) => {
    const t = String(tok).trim();
    if (t.endsWith('%')) return (parseFloat(t) / 100) * base;
    return parseFloat(t);
  };

  /** Colour stops, filling in positions CSS left implicit. */
  function parseStops(tokens) {
    const stops = tokens.map((t) => {
      const c = parseColor(t);
      const posMatch = t.replace(/rgba?\([^)]*\)/, '').trim();
      const p = posMatch ? parseFloat(posMatch) / 100 : null;
      return { color: c, pos: (posMatch && posMatch.endsWith('%')) ? p : null };
    }).filter((s) => s.color);

    if (!stops.length) return stops;
    if (stops[0].pos === null) stops[0].pos = 0;
    if (stops[stops.length - 1].pos === null) stops[stops.length - 1].pos = 1;
    // even distribution between anchored stops
    let i = 0;
    while (i < stops.length) {
      if (stops[i].pos !== null) { i++; continue; }
      let j = i;
      while (j < stops.length && stops[j].pos === null) j++;
      const before = stops[i - 1].pos, after = stops[j].pos;
      const n = j - i + 1;
      for (let k = i; k < j; k++) stops[k].pos = before + ((after - before) * (k - i + 1)) / n;
      i = j;
    }
    return stops;
  }

  /**
   * CSS linear-gradient -> the gradient line, in element-local px (y down).
   * Angle 0deg points up; it increases clockwise.
   */
  function linearGeometry(angleDeg, w, h) {
    const a = (angleDeg * Math.PI) / 180;
    const dx = Math.sin(a), dy = -Math.cos(a);
    const len = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
    const cx = w / 2, cy = h / 2;
    return {
      x0: cx - (dx * len) / 2, y0: cy - (dy * len) / 2,
      x1: cx + (dx * len) / 2, y1: cy + (dy * len) / 2,
    };
  }

  function parseLinear(args, w, h) {
    let angle = 180;                     // CSS default is `to bottom`
    let rest = args;
    const first = args[0];
    if (/^[-\d.]+deg$/.test(first)) { angle = parseFloat(first); rest = args.slice(1); }
    else if (/^to\s/.test(first)) {
      const dirs = first.slice(3).trim().split(/\s+/).sort().join(' ');
      const table = {
        top: 0, right: 90, bottom: 180, left: 270,
        'right top': 45, 'right bottom': 135, 'bottom left': 225, 'left top': 315,
      };
      angle = table[first.slice(3).trim()] ?? table[dirs] ?? 180;
      rest = args.slice(1);
    }
    return { kind: 'linear', angle, line: linearGeometry(angle, w, h), stops: parseStops(rest) };
  }

  function parseRadial(args, w, h) {
    let shape = 'ellipse', cx = w / 2, cy = h / 2, rest = args;
    const first = args[0];
    if (!/rgba?\(/.test(first)) {
      rest = args.slice(1);
      if (/\bcircle\b/.test(first)) shape = 'circle';
      const at = first.match(/at\s+(.+)$/);
      if (at) {
        const parts = at[1].trim().split(/\s+/);
        cx = pct(parts[0], w);
        cy = pct(parts[1] ?? '50%', h);
      }
    }
    // default sizing keyword is farthest-corner
    const dx = Math.max(cx, w - cx);
    const dy = Math.max(cy, h - cy);
    const rx = shape === 'circle' ? Math.hypot(dx, dy) : dx * Math.SQRT2;
    const ry = shape === 'circle' ? Math.hypot(dx, dy) : dy * Math.SQRT2;
    return { kind: 'radial', shape, cx, cy, rx, ry, stops: parseStops(rest) };
  }

  function parseGradient(img, w, h) {
    const m = String(img).match(/^(repeating-)?(linear|radial)-gradient\((.*)\)$/s);
    if (!m) return null;
    if (m[1]) return { kind: 'unsupported', reason: 'repeating-gradient' };
    const args = splitArgs(m[3]);
    const g = m[2] === 'linear' ? parseLinear(args, w, h) : parseRadial(args, w, h);
    if (!g.stops.length) return null;
    // PDF shadings carry no alpha; that needs a soft mask.
    if (g.stops.some((s) => s.color.a < 1)) g.alpha = true;
    return g;
  }

  const radius = (v) => {
    const p = String(v).split(/\s+/).map((x) => parseFloat(x) || 0);
    return p.length === 1 ? [p[0], p[0]] : [p[0], p[1]];
  };

  /** clip-path: the basic shapes documents actually use. */
  function parseClipPath(cp, w, h) {
    const s = String(cp).trim();
    let m = s.match(/^circle\(([^)]*)\)$/);
    if (m) {
      const parts = m[1].split(/\s+at\s+/);
      const rTok = parts[0].trim();
      const ref = Math.hypot(w, h) / Math.SQRT2;      // CSS closest-side default ref box
      const r = rTok.endsWith('%') ? (parseFloat(rTok) / 100) * ref : parseFloat(rTok);
      let cx = w / 2, cy = h / 2;
      if (parts[1]) {
        const p = parts[1].trim().split(/\s+/);
        cx = pct(p[0], w); cy = pct(p[1] ?? '50%', h);
      }
      return { kind: 'circle', cx, cy, r };
    }
    m = s.match(/^polygon\(([^)]*)\)$/);
    if (m) {
      const pts = m[1].split(',').map((p) => {
        const xy = p.trim().split(/\s+/);
        return { x: pct(xy[0], w), y: pct(xy[1], h) };
      });
      return { kind: 'polygon', points: pts };
    }
    m = s.match(/^inset\(([^)]*)\)$/);
    if (m) {
      const v = m[1].trim().split(/\s+/).map((t) => pct(t, w));
      const [t, r2 = t, b = t, l = r2] = v;
      return { kind: 'rect', x: l, y: t, w: w - l - r2, h: h - t - b };
    }
    return { kind: 'unsupported', raw: s };
  }

  function extractPaint(root) {
    const out = [];
    const unsupported = [];

    for (const el of root.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;

      const bw = {
        t: parseFloat(cs.borderTopWidth) || 0, r: parseFloat(cs.borderRightWidth) || 0,
        b: parseFloat(cs.borderBottomWidth) || 0, l: parseFloat(cs.borderLeftWidth) || 0,
      };
      const item = {
        id: el.id || el.tagName.toLowerCase(),
        box: { x: r.left, y: r.top, w: r.width, h: r.height },
        radii: {
          tl: radius(cs.borderTopLeftRadius), tr: radius(cs.borderTopRightRadius),
          br: radius(cs.borderBottomRightRadius), bl: radius(cs.borderBottomLeftRadius),
        },
        gradient: null, bgImage: null, clip: null, overflowClip: false,
        borders: null, shadow: null, blend: null,
      };

      // --- gradients and background images
      const bg = cs.backgroundImage;
      if (bg && bg !== 'none') {
        const g = parseGradient(bg, r.width, r.height);
        if (g && g.kind === 'unsupported') {
          unsupported.push({ id: item.id, feature: g.reason, detail: bg.slice(0, 60) });
        } else if (g) {
          if (g.alpha) unsupported.push({ id: item.id, feature: 'gradient with alpha stops', detail: 'needs a soft mask' });
          item.gradient = g;
        } else {
          const u = bg.match(/^url\(["']?(.+?)["']?\)$/);
          if (u) {
            item.bgImage = {
              src: u[1], size: cs.backgroundSize, position: cs.backgroundPosition,
              repeat: cs.backgroundRepeat,
            };
          } else {
            unsupported.push({ id: item.id, feature: 'background-image', detail: bg.slice(0, 60) });
          }
        }
      }

      // --- clipping
      if (cs.clipPath && cs.clipPath !== 'none') {
        const c = parseClipPath(cs.clipPath, r.width, r.height);
        if (c.kind === 'unsupported') unsupported.push({ id: item.id, feature: 'clip-path', detail: c.raw });
        else item.clip = c;
      }
      if (/hidden|clip|auto|scroll/.test(cs.overflow) && cs.overflow !== 'visible') {
        item.overflowClip = true;
      }

      // --- borders, including the non-uniform case
      if (bw.t || bw.r || bw.b || bw.l) {
        const styles = [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle];
        // dashed and dotted are emitted (findings 10); the rest are not.
        const EMITTED = /^(solid|dashed|dotted|none|hidden)$/;
        const bad = styles.find((st) => !EMITTED.test(st));
        if (bad) {
          unsupported.push({ id: item.id, feature: `border-style: ${bad}`, detail: 'not emitted' });
        }
        item.borders = {
          widths: bw,
          colors: {
            t: parseColor(cs.borderTopColor), r: parseColor(cs.borderRightColor),
            b: parseColor(cs.borderBottomColor), l: parseColor(cs.borderLeftColor),
          },
          styles: { t: cs.borderTopStyle, r: cs.borderRightStyle, b: cs.borderBottomStyle, l: cs.borderLeftStyle },
        };
      }

      // --- shadow: no PDF primitive; this is raster-fallback territory (§26)
      // No PDF primitive for a shadow; it is rasterised (findings 08 — and
      // Chromium's own export takes the same route).
      if (cs.boxShadow && cs.boxShadow !== 'none') item.shadow = cs.boxShadow;

      // PDF ExtGState has a /BM entry whose names match the CSS keywords, so
      // this maps across directly rather than needing a fallback.
      if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') item.blend = cs.mixBlendMode;

      const bgColor = parseColor(cs.backgroundColor);
      item.background = bgColor && bgColor.a > 0 ? bgColor : null;

      // Clipping is inherited paint state: an ancestor with overflow!=visible
      // clips this element even though nothing on this element says so.
      // Collect those ancestors so the backend can apply them in order.
      item.ancestorClips = [];
      for (let p = el.parentElement; p && p !== root.parentElement; p = p.parentElement) {
        const pcs = getComputedStyle(p);
        if (pcs.overflow === 'visible') continue;
        const pr = p.getBoundingClientRect();
        item.ancestorClips.unshift({
          x: pr.left, y: pr.top, w: pr.width, h: pr.height,
          radii: {
            tl: radius(pcs.borderTopLeftRadius), tr: radius(pcs.borderTopRightRadius),
            br: radius(pcs.borderBottomRightRadius), bl: radius(pcs.borderBottomLeftRadius),
          },
        });
      }

      if (item.gradient || item.bgImage || item.clip || item.borders || item.background ||
          item.ancestorClips.length) {
        out.push(item);
      }
    }
    return { items: out, unsupported };
  }

  globalThis.__pdf_extractPaint = extractPaint;
  globalThis.__pdf_parseGradient = parseGradient;
})();

// ===== src/capture/images.js =====
/**
 * Image extraction.
 *
 * Plan §20. The browser has already decoded, fitted and clipped the image; we
 * need its untransformed content box, the natural size, and the object-fit
 * mapping so the original encoded bytes can be embedded rather than re-encoded.
 *
 * Passthrough matters: re-encoding a JPEG to PNG inflates the file and loses
 * nothing but quality. The goal is native image resources (§2), so we embed the
 * source bytes wherever the backend can take them.
 *
 * Installs globalThis.__pdf_extractImages(root).
 */
(function () {
  function matrixOf(cs) {
    const t = cs.transform;
    if (!t || t === 'none') return null;
    const m = t.match(/^matrix\(([^)]+)\)$/);
    if (!m) return null;
    const n = m[1].split(',').map(Number);
    return { a: n[0], b: n[1], c: n[2], d: n[3], e: n[4], f: n[5] };
  }

  /**
   * getBoundingClientRect returns the *transformed* box. Recover the
   * untransformed border box in viewport coordinates, same method used for
   * boxes (findings 04, validated to 0.00 px on a rotated element).
   */
  function untransformedBox(el, cs, m) {
    const r = el.getBoundingClientRect();
    if (!m) return { x: r.left, y: r.top, w: r.width, h: r.height, originX: 0, originY: 0 };
    const ow = el.offsetWidth, oh = el.offsetHeight;
    const [ox, oy] = String(cs.transformOrigin).split(/\s+/).map(parseFloat);
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const ux = ow / 2 - ox, uy = oh / 2 - oy;
    const tx = m.a * ux + m.c * uy;
    const ty = m.b * ux + m.d * uy;
    return { x: cx - tx - ox, y: cy - ty - oy, w: ow, h: oh, originX: ox, originY: oy };
  }

  /** One length/percentage of object-position, resolved against a free span. */
  function resolvePos(token, free) {
    if (token === undefined) return free / 2;
    const t = String(token).trim();
    if (t.endsWith('%')) return (parseFloat(t) / 100) * free;
    const px = parseFloat(t);
    return Number.isFinite(px) ? px : free / 2;
  }

  /**
   * CSS object-fit: where the natural image lands inside the content box.
   * Returns the destination rect relative to the content box origin; the
   * caller clips to the content box, which is what makes cover/none correct.
   */
  function fitRect(fit, position, cw, ch, nw, nh) {
    if (!nw || !nh) return { dx: 0, dy: 0, dw: cw, dh: ch };
    let s;
    switch (fit) {
      case 'contain':    s = Math.min(cw / nw, ch / nh); break;
      case 'cover':      s = Math.max(cw / nw, ch / nh); break;
      case 'none':       s = 1; break;
      case 'scale-down': s = Math.min(1, Math.min(cw / nw, ch / nh)); break;
      case 'fill':
      default:           return { dx: 0, dy: 0, dw: cw, dh: ch };
    }
    const dw = nw * s, dh = nh * s;
    const parts = String(position || '50% 50%').trim().split(/\s+/);
    return {
      dx: resolvePos(parts[0], cw - dw),
      dy: resolvePos(parts[1], ch - dh),
      dw, dh,
    };
  }

  const radius = (v) => {
    const p = String(v).split(/\s+/).map((x) => parseFloat(x) || 0);
    return p.length === 1 ? [p[0], p[0]] : [p[0], p[1]];
  };

  function extractImages(root) {
    const out = [];
    for (const el of root.querySelectorAll('img')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (!el.currentSrc && !el.src) continue;

      const m = matrixOf(cs);
      const box = untransformedBox(el, cs, m);

      const bl = parseFloat(cs.borderLeftWidth) || 0;
      const bt = parseFloat(cs.borderTopWidth) || 0;
      const br = parseFloat(cs.borderRightWidth) || 0;
      const bb = parseFloat(cs.borderBottomWidth) || 0;
      const pl = parseFloat(cs.paddingLeft) || 0;
      const pt = parseFloat(cs.paddingTop) || 0;
      const pr = parseFloat(cs.paddingRight) || 0;
      const pb = parseFloat(cs.paddingBottom) || 0;

      const content = {
        x: box.x + bl + pl,
        y: box.y + bt + pt,
        w: box.w - bl - br - pl - pr,
        h: box.h - bt - bb - pt - pb,
      };
      if (content.w <= 0 || content.h <= 0) continue;

      const fit = fitRect(cs.objectFit || 'fill', cs.objectPosition,
        content.w, content.h, el.naturalWidth, el.naturalHeight);

      out.push({
        id: el.id || '(img)',
        src: el.currentSrc || el.src,
        natural: { w: el.naturalWidth, h: el.naturalHeight },
        content,
        fit: cs.objectFit || 'fill',
        objectPosition: cs.objectPosition,
        dest: fit,
        // A destination larger than the content box must be clipped; so must
        // any rounded corner.
        needsClip: fit.dx < -0.01 || fit.dy < -0.01 ||
                   fit.dx + fit.dw > content.w + 0.01 ||
                   fit.dy + fit.dh > content.h + 0.01,
        radii: {
          tl: radius(cs.borderTopLeftRadius), tr: radius(cs.borderTopRightRadius),
          br: radius(cs.borderBottomRightRadius), bl: radius(cs.borderBottomLeftRadius),
        },
        transform: m,
        origin: { x: box.originX, y: box.originY },
        box,
        opacity: parseFloat(cs.opacity ?? '1'),
      });
    }
    return out;
  }

  globalThis.__pdf_extractImages = extractImages;
})();

// ===== src/capture/canvas.js =====
/**
 * <canvas> capture.
 *
 * A canvas has no DOM structure to read — its content only exists as pixels.
 * That makes it the one element where rasterising is not a fallback but the
 * only correct answer, so it is read straight off the element.
 *
 * Installs globalThis.__pdf_extractCanvas(root).
 */
(function () {
  const radius = (v) => {
    const p = String(v).split(/\s+/).map(parseFloat);
    return [p[0] || 0, p.length > 1 ? p[1] : (p[0] || 0)];
  };

  function extractCanvas(root) {
    const out = [];
    for (const el of root.querySelectorAll('canvas')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (!el.width || !el.height) continue;          // nothing has been drawn

      let dataUrl = null;
      let tainted = false;
      try {
        dataUrl = el.toDataURL('image/png');
      } catch (e) {
        // A canvas that has drawn cross-origin content is tainted and cannot
        // be read back. Say so rather than dropping it silently.
        tainted = true;
      }

      out.push({
        id: el.id || '(canvas)',
        box: { x: r.left, y: r.top, w: r.width, h: r.height },
        pixels: { w: el.width, h: el.height },
        dataUrl,
        tainted,
        opacity: parseFloat(cs.opacity ?? '1'),
        radii: {
          tl: radius(cs.borderTopLeftRadius), tr: radius(cs.borderTopRightRadius),
          br: radius(cs.borderBottomRightRadius), bl: radius(cs.borderBottomLeftRadius),
        },
      });
    }
    return out;
  }

  globalThis.__pdf_extractCanvas = extractCanvas;
})();

// ===== src/capture/forms.js =====
/**
 * Form control capture.
 *
 * A form control has no PDF drawing equivalent, but it does have a PDF
 * *object* equivalent: AcroForm fields. Rasterising one would throw away the
 * only thing that makes it a control, so these map across as real fields and
 * the PDF stays fillable.
 *
 * Installs globalThis.__pdf_extractForms(root).
 */
(function () {
  /** Only what AcroForm can actually express. */
  const TEXTUAL = /^(text|email|url|tel|search|password|number|date|time|month|week|datetime-local)$/;

  function extractForms(root) {
    const out = [];
    let seq = 0;

    for (const el of root.querySelectorAll('input, textarea, select')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;

      const tag = el.tagName.toLowerCase();
      const type = tag === 'input' ? (el.type || 'text').toLowerCase() : tag;

      // A stable, unique field name: PDF requires uniqueness, the DOM does not.
      const name = `${el.name || el.id || type}_${seq++}`;
      const base = {
        name,
        label: el.getAttribute('aria-label') || el.name || el.id || '',
        box: { x: r.left, y: r.top, w: r.width, h: r.height },
        readOnly: el.readOnly || el.disabled,
        required: el.required,
        fontSize: parseFloat(cs.fontSize) || 12,
      };

      if (tag === 'textarea') {
        out.push({ ...base, kind: 'text', value: el.value || '', multiline: true });
      } else if (tag === 'select') {
        const options = [...el.options].map((o) => o.text);
        if (!options.length) continue;
        out.push({
          ...base,
          kind: el.multiple ? 'unsupported' : 'dropdown',
          reason: el.multiple ? 'multi-select' : undefined,
          options,
          value: el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : options[0],
        });
      } else if (type === 'checkbox') {
        out.push({ ...base, kind: 'checkbox', checked: el.checked });
      } else if (type === 'radio') {
        out.push({ ...base, kind: 'radio', group: el.name || name, checked: el.checked,
          value: el.value || 'on' });
      } else if (TEXTUAL.test(type)) {
        out.push({ ...base, kind: 'text', value: el.value || '', multiline: false });
      } else {
        // submit, button, file, colour, range: no faithful AcroForm equivalent.
        out.push({ ...base, kind: 'unsupported', reason: type });
      }
    }
    return out;
  }

  globalThis.__pdf_extractForms = extractForms;
})();

// ===== src/capture/links.js =====
/**
 * Link extraction.
 *
 * Plan §2: <a> elements should become PDF link annotations, not just styled
 * text. A link that wraps across lines occupies several disjoint rectangles,
 * which is exactly what getClientRects() reports — one annotation per rect.
 *
 * Installs globalThis.__pdf_extractLinks(root).
 */
(function () {
  function extractLinks(root) {
    const out = [];
    for (const el of root.querySelectorAll('a[href]')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;

      const href = el.href;                      // resolved absolute URL
      if (!href || href.startsWith('javascript:')) continue;

      // One rect per line fragment. A wrapped link is several rectangles, and
      // a single bounding box would make dead space clickable.
      const raw = [...el.getClientRects()];

      // getClientRects() on an INLINE anchor reports its line boxes only. A
      // link wrapping an image therefore comes back as a thin text-height
      // strip, leaving the image itself unclickable -- Chromium's own export
      // emits a second annotation for it. Add replaced and non-inline
      // descendants explicitly.
      for (const d of el.querySelectorAll('*')) {
        const ds = getComputedStyle(d);
        if (ds.display === 'none' || ds.visibility === 'hidden') continue;
        const replaced = /^(img|svg|canvas|video|object|iframe|input|button|select|textarea)$/
          .test(d.tagName.toLowerCase());
        if (replaced || ds.display !== 'inline') raw.push(d.getBoundingClientRect());
      }

      const rects = [];
      for (const r of raw) {
        if (r.width <= 0.01 || r.height <= 0.01) continue;
        const box = { x: r.left, y: r.top, w: r.width, h: r.height };
        const dup = rects.some((o) =>
          Math.abs(o.x - box.x) < 0.1 && Math.abs(o.y - box.y) < 0.1 &&
          Math.abs(o.w - box.w) < 0.1 && Math.abs(o.h - box.h) < 0.1);
        if (!dup) rects.push(box);
      }
      if (!rects.length) continue;

      out.push({
        id: el.id || '(a)',
        href,
        internal: href.startsWith(location.origin + location.pathname + '#'),
        text: (el.textContent || '').trim().slice(0, 60),
        rects,
      });
    }
    return out;
  }

  globalThis.__pdf_extractLinks = extractLinks;
})();

// ===== src/capture/svg.js =====
/**
 * SVG vector extraction.
 *
 * Plan §19: SVG should stay vector, not become a raster patch. The information
 * is all in the DOM, but SVG's coordinate resolution is genuinely fiddly --
 * viewBox, preserveAspectRatio, nested transforms, units.
 *
 * So apply the same principle used everywhere else in this architecture: don't
 * reimplement it, ask the browser. `getScreenCTM()` returns the fully resolved
 * matrix from an element's user space to viewport pixels, with viewBox and
 * every ancestor transform already folded in. That is the SVG equivalent of
 * using Range rects for text and multicolumn for pagination.
 *
 * Installs globalThis.__pdf_extractSvg(root).
 */
(function () {
  const NS = 'http://www.w3.org/2000/svg';

  const num = (el, a, d = 0) => {
    const v = parseFloat(el.getAttribute(a));
    return Number.isFinite(v) ? v : d;
  };

  /** Every shape becomes path data, so the backend needs one primitive. */
  function pathData(el) {
    const t = el.tagName.toLowerCase();
    if (t === 'path') return el.getAttribute('d') || '';

    if (t === 'rect') {
      const x = num(el, 'x'), y = num(el, 'y');
      const w = num(el, 'width'), h = num(el, 'height');
      if (w <= 0 || h <= 0) return '';
      let rx = el.hasAttribute('rx') ? num(el, 'rx') : NaN;
      let ry = el.hasAttribute('ry') ? num(el, 'ry') : NaN;
      if (!Number.isFinite(rx) && !Number.isFinite(ry)) rx = ry = 0;
      else if (!Number.isFinite(rx)) rx = ry;
      else if (!Number.isFinite(ry)) ry = rx;
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
      if (!rx || !ry) return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
      return [
        `M ${x + rx} ${y}`,
        `H ${x + w - rx}`,
        `A ${rx} ${ry} 0 0 1 ${x + w} ${y + ry}`,
        `V ${y + h - ry}`,
        `A ${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}`,
        `H ${x + rx}`,
        `A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry}`,
        `V ${y + ry}`,
        `A ${rx} ${ry} 0 0 1 ${x + rx} ${y}`,
        'Z',
      ].join(' ');
    }

    if (t === 'circle' || t === 'ellipse') {
      const cx = num(el, 'cx'), cy = num(el, 'cy');
      const r = num(el, 'r');
      const rx = t === 'circle' ? r : num(el, 'rx');
      const ry = t === 'circle' ? r : num(el, 'ry');
      if (rx <= 0 || ry <= 0) return '';
      // two arcs, because a single 360° arc is degenerate
      return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} ` +
             `A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
    }

    if (t === 'line') {
      return `M ${num(el, 'x1')} ${num(el, 'y1')} L ${num(el, 'x2')} ${num(el, 'y2')}`;
    }

    if (t === 'polyline' || t === 'polygon') {
      const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
      if (pts.length < 4) return '';
      let d = `M ${pts[0]} ${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += ` L ${pts[i]} ${pts[i + 1]}`;
      return t === 'polygon' ? d + ' Z' : d;
    }
    return '';
  }

  const parseColor = (s) => {
    const m = String(s).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    const a = m[4] === undefined ? 1 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a };
  };

  /** fill/stroke may be a paint server reference we cannot express directly. */
  function paint(value) {
    const v = String(value).trim();
    if (!v || v === 'none') return { kind: 'none' };
    if (v.startsWith('url(')) return { kind: 'ref', ref: v };
    const c = parseColor(v);
    return c ? { kind: 'color', color: c } : { kind: 'unknown', raw: v };
  }

  /** Resolve a `url(#id)` reference to the element it names. */
  function deref(value) {
    const m = String(value).match(/url\(["']?#([^"')]+)["']?\)/);
    if (!m) return null;
    return document.getElementById(m[1]);
  }

  /**
   * An SVG paint server. Coordinates come in two unit systems and the default
   * -- objectBoundingBox -- is a fraction of the shape's own bbox, so it can
   * only be resolved once the shape is known.
   */
  function paintServer(el, shapeEl) {
    const tag = el.tagName.toLowerCase();
    if (tag !== 'lineargradient' && tag !== 'radialgradient') return null;

    const stops = [...el.querySelectorAll('stop')].map((s) => {
      const cs = getComputedStyle(s);
      const c = parseColor(cs.stopColor || s.getAttribute('stop-color') || '#000');
      const off = parseFloat(s.getAttribute('offset') ?? '0');
      const so = parseFloat(cs.stopOpacity ?? s.getAttribute('stop-opacity') ?? '1');
      return { pos: String(s.getAttribute('offset') ?? '').endsWith('%') ? off / 100 : off,
               color: c ? { ...c, a: (c.a ?? 1) * (Number.isFinite(so) ? so : 1) } : null };
    }).filter((s) => s.color);
    if (!stops.length) return null;

    const units = el.getAttribute('gradientUnits') || 'objectBoundingBox';
    const bb = shapeEl.getBBox();
    // objectBoundingBox fractions -> the shape's own user-space box
    const fx = (v, d, span, origin) => {
      const t = v === null ? d : v;
      const num = parseFloat(t);
      if (units === 'userSpaceOnUse') return num;
      return origin + (String(t).endsWith('%') ? num / 100 : num) * span;
    };

    if (tag === 'lineargradient') {
      return {
        kind: 'linear', stops,
        x1: fx(el.getAttribute('x1'), '0', bb.width, bb.x),
        y1: fx(el.getAttribute('y1'), '0', bb.height, bb.y),
        x2: fx(el.getAttribute('x2'), '1', bb.width, bb.x),
        y2: fx(el.getAttribute('y2'), '0', bb.height, bb.y),
      };
    }
    return {
      kind: 'radial', stops,
      cx: fx(el.getAttribute('cx'), '0.5', bb.width, bb.x),
      cy: fx(el.getAttribute('cy'), '0.5', bb.height, bb.y),
      r: units === 'userSpaceOnUse'
        ? parseFloat(el.getAttribute('r') ?? '0')
        : parseFloat(el.getAttribute('r') ?? '0.5') * Math.max(bb.width, bb.height),
    };
  }

  /** A <clipPath>'s children, as path data in the clip's own units. */
  function clipPathOf(el, shapeEl) {
    const units = el.getAttribute('clipPathUnits') || 'userSpaceOnUse';
    const paths = [];
    for (const child of el.querySelectorAll('path,rect,circle,ellipse,polygon,polyline')) {
      const d = pathData(child);
      if (!d) continue;
      const m = child.getScreenCTM();
      paths.push({ d, ctm: m ? { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f } : null });
    }
    return paths.length ? { units, paths } : null;
  }

  function extractSvg(root) {
    const out = [];
    const unsupported = [];

    // <use> renders a shadow copy of its referent, and shadow content has no
    // reachable geometry. Rather than compose the use's matrix with the
    // referent's by hand, inline a real clone and let the browser resolve the
    // CTM — the same move the rest of this project makes everywhere else.
    const materialized = [];
    for (const use of root.querySelectorAll('use')) {
      const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
      if (!href.startsWith('#')) continue;
      const ref = root.ownerDocument.getElementById(href.slice(1));
      if (!ref) continue;

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      const x = parseFloat(use.getAttribute('x') || '0') || 0;
      const y = parseFloat(use.getAttribute('y') || '0') || 0;
      const own = use.getAttribute('transform');
      // A <use>'s x/y are an extra translate applied AFTER its own transform.
      g.setAttribute('transform', `${own ? own + ' ' : ''}translate(${x} ${y})`);
      for (const attr of ['fill', 'stroke', 'stroke-width', 'opacity', 'class', 'style']) {
        const v = use.getAttribute(attr);
        if (v !== null) g.setAttribute(attr, v);
      }

      // <symbol> is not itself rendered; its CHILDREN are.
      const src = ref.tagName.toLowerCase() === 'symbol' ? [...ref.children] : [ref];
      for (const child of src) g.appendChild(child.cloneNode(true));

      use.parentNode.insertBefore(g, use);
      const prevDisplay = use.style.display;
      use.style.display = 'none';
      materialized.push([use, g, prevDisplay]);
    }
    const restoreUses = () => {
      for (const [use, g, d] of materialized) { g.remove(); use.style.display = d; }
    };

    for (const svg of root.querySelectorAll('svg')) {
      // An outer <svg> establishes a viewport that CLIPS its content by
      // default. Content overflowing it is invisible in the browser, so a
      // renderer that ignores this paints ink Chromium never showed.
      const svgCS = getComputedStyle(svg);
      const vpRect = svg.getBoundingClientRect();
      const clipsToViewport = svgCS.overflow !== 'visible';

      const shapes = svg.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon');
      for (const el of shapes) {
        // Elements inside <defs> / <clipPath> are definitions, not paint.
        if (el.closest('defs, clipPath, mask, marker, pattern, symbol')) continue;

        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;

        const d = pathData(el);
        if (!d) continue;

        const m = el.getScreenCTM();
        if (!m) continue;

        const fill = paint(cs.fill);
        const stroke = paint(cs.stroke);
        const strokeWidth = parseFloat(cs.strokeWidth) || 0;

        // Resolve paint servers and clip paths; report only what stays
        // genuinely unexpressible.
        let gradient = null, clip = null;
        if (fill.kind === 'ref') {
          const ref = deref(fill.ref);
          gradient = ref ? paintServer(ref, el) : null;
          if (!gradient) unsupported.push({ id: el.id, feature: 'paint-server fill', detail: fill.ref });
          else if (gradient.stops.some((s) => s.color.a < 1)) {
            unsupported.push({ id: el.id, feature: 'gradient with alpha stops', detail: 'needs a soft mask' });
          }
        }
        if (stroke.kind === 'ref') unsupported.push({ id: el.id, feature: 'paint-server stroke', detail: stroke.ref });
        if (cs.clipPath && cs.clipPath !== 'none') {
          const ref = deref(cs.clipPath);
          clip = ref ? clipPathOf(ref, el) : null;
          if (!clip) unsupported.push({ id: el.id, feature: 'clip-path', detail: cs.clipPath });
        }
        if (cs.mask && cs.mask !== 'none' && cs.mask !== 'match-source') unsupported.push({ id: el.id, feature: 'mask', detail: cs.mask });
        if (cs.filter && cs.filter !== 'none') unsupported.push({ id: el.id, feature: 'filter', detail: cs.filter });

        const dash = (cs.strokeDasharray && cs.strokeDasharray !== 'none')
          ? cs.strokeDasharray.split(/[\s,]+/).map(parseFloat).filter(Number.isFinite)
          : null;

        // Painting a clipped shape without its clip puts ink outside the
        // region the author asked for -- worse than omitting it entirely.
        // Only shapes whose clip or paint we still cannot express get skipped.
        const unclippable = (cs.clipPath && cs.clipPath !== 'none' && !clip)
          || (cs.mask && cs.mask !== 'none' && cs.mask !== 'match-source');
        const unpaintable = fill.kind === 'ref' && !gradient && stroke.kind !== 'color';

        out.push({
          skip: !!(unclippable || unpaintable),
          gradient,
          clip,
          viewportClip: clipsToViewport
            ? { x: vpRect.left, y: vpRect.top, w: vpRect.width, h: vpRect.height }
            : null,
          id: el.id || el.tagName.toLowerCase(),
          tag: el.tagName.toLowerCase(),
          d,
          // The browser's own resolved user-space -> viewport matrix.
          ctm: { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f },
          fill: fill.kind === 'color' ? fill.color : null,
          fillRule: cs.fillRule || 'nonzero',
          fillOpacity: parseFloat(cs.fillOpacity ?? '1'),
          stroke: stroke.kind === 'color' ? stroke.color : null,
          strokeWidth,
          strokeOpacity: parseFloat(cs.strokeOpacity ?? '1'),
          strokeLinecap: cs.strokeLinecap || 'butt',
          strokeLinejoin: cs.strokeLinejoin || 'miter',
          strokeMiterlimit: parseFloat(cs.strokeMiterlimit) || 4,
          strokeDasharray: dash,
          strokeDashoffset: parseFloat(cs.strokeDashoffset) || 0,
          opacity: parseFloat(cs.opacity ?? '1'),
        });
      }
    }
    restoreUses();
    // `unsupported` is for things we could NOT do — a resolved <use> is a
    // success and has no business being reported as a limitation.
    return { shapes: out, unsupported, resolvedUses: materialized.length };
  }

  globalThis.__pdf_extractSvg = extractSvg;
})();

// ===== src/pdf/svgPath.js =====
/**
 * SVG path data -> PDF path operators.
 *
 * Written rather than delegated, for two reasons found by measurement:
 *   1. pdf-lib's drawSvgPath gives no control over fill rule, so `evenodd`
 *      silently filled holes that Chromium punches out.
 *   2. Its handling of the smooth-curve commands (S/T) disagreed with
 *      Chromium on the reflected control point.
 *
 * Emitting the operators ourselves fixes both and removes any dependence on a
 * third-party SVG parser for the one primitive SVG is actually made of.
 *
 * Coordinates are emitted unchanged, in SVG user space. The caller is expected
 * to have concatenated a matrix that maps user space to PDF space (including
 * the y-flip), which is exactly what getScreenCTM() provides.
 *
 * Installs globalThis.__pdf_svgPathToOps(d) -> array of operator strings.
 */
(function () {
  const N = '[-+]?(?:\\d*\\.\\d+|\\d+\\.?)(?:[eE][-+]?\\d+)?';
  const TOKEN = new RegExp(`([astvzqmhlcASTVZQMHLC])|(${N})`, 'g');

  function tokenize(d) {
    const out = [];
    let m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(d)) !== null) {
      if (m[1]) out.push({ cmd: m[1] });
      else out.push({ num: parseFloat(m[2]) });
    }
    return out;
  }

  const fmt = (n) => (Math.abs(n) < 1e-6 ? '0' : String(+n.toFixed(4)));

  /** Endpoint-parameterised arc -> a series of cubic Béziers (W3C F.6.5). */
  function arcToCubics(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2) {
    if (rx === 0 || ry === 0) return [[x2, y2, x2, y2, x2, y2]];
    rx = Math.abs(rx); ry = Math.abs(ry);
    const phi = (phiDeg * Math.PI) / 180;
    const cosP = Math.cos(phi), sinP = Math.sin(phi);

    const dx2 = (x1 - x2) / 2, dy2 = (y1 - y2) / 2;
    const x1p = cosP * dx2 + sinP * dy2;
    const y1p = -sinP * dx2 + cosP * dy2;

    // scale radii up if they are too small to span the endpoints
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }

    const sign = fa !== fs ? 1 : -1;
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    const co = sign * Math.sqrt(Math.max(0, num / den));
    const cxp = (co * rx * y1p) / ry;
    const cyp = (-co * ry * x1p) / rx;
    const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
    const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;

    const ang = (ux, uy, vx, vy) => {
      const dot = ux * vx + uy * vy;
      const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
      let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
      if (ux * vy - uy * vx < 0) a = -a;
      return a;
    };

    const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
    const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
    let theta = ang(1, 0, ux, uy);
    let dTheta = ang(ux, uy, vx, vy);
    if (!fs && dTheta > 0) dTheta -= 2 * Math.PI;
    if (fs && dTheta < 0) dTheta += 2 * Math.PI;

    const segs = Math.ceil(Math.abs(dTheta / (Math.PI / 2)));
    const delta = dTheta / segs;
    const t = (4 / 3) * Math.tan(delta / 4);
    const out = [];

    for (let i = 0; i < segs; i++) {
      const t1 = theta + i * delta;
      const t2 = t1 + delta;
      const cos1 = Math.cos(t1), sin1 = Math.sin(t1);
      const cos2 = Math.cos(t2), sin2 = Math.sin(t2);

      const p = (c, s) => [
        cosP * rx * c - sinP * ry * s + cx,
        sinP * rx * c + cosP * ry * s + cy,
      ];
      const [px1, py1] = p(cos1, sin1);
      const [px2, py2] = p(cos2, sin2);
      const [dx1, dy1] = [-rx * sin1, ry * cos1];
      const [ddx2, ddy2] = [-rx * sin2, ry * cos2];
      const d1 = [cosP * dx1 - sinP * dy1, sinP * dx1 + cosP * dy1];
      const d2 = [cosP * ddx2 - sinP * ddy2, sinP * ddx2 + cosP * ddy2];

      out.push([
        px1 + t * d1[0], py1 + t * d1[1],
        px2 - t * d2[0], py2 - t * d2[1],
        px2, py2,
      ]);
    }
    return out;
  }

  function svgPathToOps(d) {
    const toks = tokenize(d);
    const ops = [];
    let i = 0;
    let x = 0, y = 0;            // current point
    let sx = 0, sy = 0;          // subpath start
    let px = null, py = null;    // previous control point (for S / T)
    let prevCmd = '';
    let cmd = '';

    const next = () => (toks[i] && toks[i].num !== undefined ? toks[i++].num : null);
    const moveTo = (nx, ny) => { ops.push(`${fmt(nx)} ${fmt(ny)} m`); x = sx = nx; y = sy = ny; };
    const lineTo = (nx, ny) => { ops.push(`${fmt(nx)} ${fmt(ny)} l`); x = nx; y = ny; };
    const curveTo = (a, b, c, e, f, g) => {
      ops.push(`${fmt(a)} ${fmt(b)} ${fmt(c)} ${fmt(e)} ${fmt(f)} ${fmt(g)} c`);
      x = f; y = g;
    };

    while (i < toks.length) {
      if (toks[i].cmd !== undefined) { cmd = toks[i].cmd; i++; }
      // else: repeated parameter set, reuse the previous command
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();
      const ox = rel ? x : 0, oy = rel ? y : 0;

      if (C === 'M') {
        const nx = next() + ox, ny = next() + oy;
        moveTo(nx, ny);
        cmd = rel ? 'l' : 'L';           // subsequent pairs are implicit lineto
      } else if (C === 'L') {
        lineTo(next() + ox, next() + oy);
      } else if (C === 'H') {
        lineTo(next() + ox, y);
      } else if (C === 'V') {
        lineTo(x, next() + oy);
      } else if (C === 'C') {
        const a = next() + ox, b = next() + oy;
        const c = next() + ox, e = next() + oy;
        const f = next() + ox, g = next() + oy;
        px = c; py = e;
        curveTo(a, b, c, e, f, g);
      } else if (C === 'S') {
        // reflect the previous control point through the current point
        const refX = /[CS]/.test(prevCmd.toUpperCase()) && px !== null ? 2 * x - px : x;
        const refY = /[CS]/.test(prevCmd.toUpperCase()) && py !== null ? 2 * y - py : y;
        const c = next() + ox, e = next() + oy;
        const f = next() + ox, g = next() + oy;
        px = c; py = e;
        curveTo(refX, refY, c, e, f, g);
      } else if (C === 'Q' || C === 'T') {
        let qx, qy;
        if (C === 'Q') { qx = next() + ox; qy = next() + oy; }
        else {
          qx = /[QT]/.test(prevCmd.toUpperCase()) && px !== null ? 2 * x - px : x;
          qy = /[QT]/.test(prevCmd.toUpperCase()) && py !== null ? 2 * y - py : y;
        }
        const ex = next() + ox, ey = next() + oy;
        // quadratic -> cubic
        curveTo(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y),
                ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey);
        px = qx; py = qy;
      } else if (C === 'A') {
        const rx = next(), ry = next(), rot = next();
        const fa = next(), fs = next();
        const ex = next() + ox, ey = next() + oy;
        for (const c of arcToCubics(x, y, rx, ry, rot, !!fa, !!fs, ex, ey)) {
          curveTo(c[0], c[1], c[2], c[3], c[4], c[5]);
        }
        px = py = null;
      } else if (C === 'Z') {
        ops.push('h');
        x = sx; y = sy;
        px = py = null;
      } else {
        i++;                              // unknown token, skip defensively
        continue;
      }
      if (!/[CSQT]/.test(C)) { px = py = null; }
      prevCmd = cmd;
    }
    return ops;
  }

  globalThis.__pdf_svgPathToOps = svgPathToOps;
})();

// ===== src/pdf/emit.js =====
/**
 * PDF emitters — the half that was missing.
 *
 * `src/capture/` reads what the browser decided; this writes it into a PDF.
 * Until now every emitter lived in an experiment, which is why the entry point
 * could only draw text and had to report everything else as
 * `PDF_*_NOT_EMITTED`. These are promoted from the experiments that validated
 * them against Chromium's own output — paint-gaps.js, images-links.js and
 * svg-render.js — rather than rewritten.
 *
 * Everything works in VIEWPORT pixels and is mapped to page points by the
 * `xf` transform the caller supplies, because in a paginated document the same
 * element may sit in any column.
 *
 * Installs globalThis.__pdf_emit.
 */
(function () {
  const n = (v) => (Math.abs(v) < 1e-6 ? '0' : String(+v.toFixed(4)));
  const rgb01 = (c) => [c.r / 255, c.g / 255, c.b / 255];
  const col = (c) => `${n(c.r / 255)} ${n(c.g / 255)} ${n(c.b / 255)}`;

  /**
   * Per-document emitter state: shading and alpha resources are shared, so
   * they are registered once and referenced by name.
   */
  function createContext(doc, pdfLib) {
    const { PDFName, PDFOperator, PDFString,
      pushGraphicsState, popGraphicsState, concatTransformationMatrix } = pdfLib;
    let shCount = 0;
    const alphaCache = new Map();

    return {
      doc, pdfLib, PDFName, PDFOperator, PDFString,
      pushGraphicsState, popGraphicsState, concatTransformationMatrix,

      raw(page, s) { page.pushOperators(PDFOperator.of(s, [])); },

      /** Register a shading dictionary on this page, return its resource name. */
      addShading(page, dict) {
        const res = page.node.Resources();
        let shd = res.lookup(PDFName.of('Shading'));
        if (!shd) { shd = doc.context.obj({}); res.set(PDFName.of('Shading'), shd); }
        const name = `Sh${shCount++}`;
        shd.set(PDFName.of(name), doc.context.register(dict));
        return name;
      },

      /** An ExtGState for constant fill/stroke alpha, and optionally a blend mode. */
      alphaState(page, fillA, strokeA = fillA, blend = null) {
        const key = `${page.ref}|${n(fillA)}|${n(strokeA)}|${blend || ''}`;
        if (alphaCache.has(key)) return alphaCache.get(key);
        const res = page.node.Resources();
        let eg = res.lookup(PDFName.of('ExtGState'));
        if (!eg) { eg = doc.context.obj({}); res.set(PDFName.of('ExtGState'), eg); }
        const name = `GS${alphaCache.size}`;
        const dict = { Type: 'ExtGState', ca: fillA, CA: strokeA };
        if (blend) dict.BM = blend;
        eg.set(PDFName.of(name), doc.context.register(doc.context.obj(dict)));
        alphaCache.set(key, name);
        return name;
      },

      /** Colour stops -> a PDF function over [0,1]. */
      stopsToFunction(stops) {
        const s = stops.map((x) => ({ ...x }));
        if (s[0].pos > 0) s.unshift({ ...s[0], pos: 0 });
        if (s[s.length - 1].pos < 1) s.push({ ...s[s.length - 1], pos: 1 });
        if (s.length === 2) {
          return doc.context.obj({
            FunctionType: 2, Domain: [0, 1], C0: rgb01(s[0].color), C1: rgb01(s[1].color), N: 1,
          });
        }
        const fns = [], bounds = [], encode = [];
        for (let i = 0; i < s.length - 1; i++) {
          fns.push(doc.context.obj({
            FunctionType: 2, Domain: [0, 1],
            C0: rgb01(s[i].color), C1: rgb01(s[i + 1].color), N: 1,
          }));
          encode.push(0, 1);
          if (i > 0) bounds.push(s[i].pos);
        }
        return doc.context.obj({
          FunctionType: 3, Domain: [0, 1], Functions: fns, Bounds: bounds, Encode: encode,
        });
      },
    };
  }

  // ---------------------------------------------------------------- paths ---

  /** A rounded rectangle in PAGE space (y already flipped, x/y bottom-left). */
  function roundRectOps(x, y, w, h, r) {
    const K = 0.5523;
    const lim = (v, m) => Math.max(0, Math.min(v, m));
    const tl = lim(r.tl[0], w / 2), tr = lim(r.tr[0], w / 2);
    const brr = lim(r.br[0], w / 2), bl = lim(r.bl[0], w / 2);
    const tlv = lim(r.tl[1], h / 2), trv = lim(r.tr[1], h / 2);
    const brv = lim(r.br[1], h / 2), blv = lim(r.bl[1], h / 2);
    const X = x, Y = y, R = x + w, T = y + h;
    if (!tl && !tr && !brr && !bl) return [`${n(X)} ${n(Y)} ${n(w)} ${n(h)} re`];
    return [
      `${n(X + bl)} ${n(Y)} m`,
      `${n(R - brr)} ${n(Y)} l`,
      `${n(R - brr + brr * K)} ${n(Y)} ${n(R)} ${n(Y + brv - brv * K)} ${n(R)} ${n(Y + brv)} c`,
      `${n(R)} ${n(T - trv)} l`,
      `${n(R)} ${n(T - trv + trv * K)} ${n(R - tr + tr * K)} ${n(T)} ${n(R - tr)} ${n(T)} c`,
      `${n(X + tl)} ${n(T)} l`,
      `${n(X + tl - tl * K)} ${n(T)} ${n(X)} ${n(T - tlv + tlv * K)} ${n(X)} ${n(T - tlv)} c`,
      `${n(X)} ${n(Y + blv)} l`,
      `${n(X)} ${n(Y + blv - blv * K)} ${n(X + bl - bl * K)} ${n(Y)} ${n(X + bl)} ${n(Y)} c`,
      'h',
    ];
  }

  function circleOps(cx, cy, r) {
    const K = 0.5523 * r;
    return [
      `${n(cx - r)} ${n(cy)} m`,
      `${n(cx - r)} ${n(cy + K)} ${n(cx - K)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c`,
      `${n(cx + K)} ${n(cy + r)} ${n(cx + r)} ${n(cy + K)} ${n(cx + r)} ${n(cy)} c`,
      `${n(cx + r)} ${n(cy - K)} ${n(cx + K)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c`,
      `${n(cx - K)} ${n(cy - r)} ${n(cx - r)} ${n(cy - K)} ${n(cx - r)} ${n(cy)} c`,
      'h',
    ];
  }

  /** A viewport-space box, as page-space path operators. */
  const boxOps = (xf, b, radii) => roundRectOps(
    xf.x(b.x), xf.y(b.y + b.h), b.w * xf.PT, b.h * xf.PT,
    {
      tl: (radii?.tl || [0, 0]).map((v) => v * xf.PT),
      tr: (radii?.tr || [0, 0]).map((v) => v * xf.PT),
      br: (radii?.br || [0, 0]).map((v) => v * xf.PT),
      bl: (radii?.bl || [0, 0]).map((v) => v * xf.PT),
    },
  );

  /**
   * CSS `mix-blend-mode` -> PDF `/BM`. The PDF blend-mode names are the same
   * set, capitalised; the CSS-only modes have no PDF equivalent.
   */
  const BLEND = {
    multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', darken: 'Darken',
    lighten: 'Lighten', 'color-dodge': 'ColorDodge', 'color-burn': 'ColorBurn',
    'hard-light': 'HardLight', 'soft-light': 'SoftLight', difference: 'Difference',
    exclusion: 'Exclusion', hue: 'Hue', saturation: 'Saturation',
    color: 'Color', luminosity: 'Luminosity',
  };

  /** `rgba(0,0,0,.45) 5px 7px 14px 0px` -> its parts. */
  function parseShadow(css) {
    const c = String(css).match(/rgba?\([^)]*\)/);
    const v = (String(css).replace(/rgba?\([^)]*\)/, '').trim().match(/-?[\d.]+px/g) || [])
      .map(parseFloat);
    return {
      color: c ? c[0] : 'rgba(0,0,0,0.5)',
      dx: v[0] || 0, dy: v[1] || 0, blur: v[2] || 0, spread: v[3] || 0,
      inset: /inset/.test(String(css)),
    };
  }

  /**
   * Rasterise a box-shadow. There is no PDF shadow primitive, and Chromium's
   * own export rasterises it too, so this matches rather than approximates.
   *
   * The shape is drawn WITH its shadow and then erased, which keeps everything
   * on-canvas — the usual off-screen-offset trick fails because geometry placed
   * outside the surface is culled before the shadow is generated. CSS also
   * clips an outer shadow out from under its own box, so erasing is correct
   * rather than merely convenient.
   */
  async function shadowImage(doc, it, SCALE = 3) {
    const sh = parseShadow(it.shadow);
    if (sh.inset) return null;                       // inset shadows unhandled
    const bw = it.box.w, bh = it.box.h;
    const grow = sh.blur + Math.max(0, sh.spread);
    const left = Math.min(0, sh.dx - grow);
    const top = Math.min(0, sh.dy - grow);
    const right = Math.max(bw, bw + sh.dx + grow);
    const bottom = Math.max(bh, bh + sh.dy + grow);
    const cw = Math.ceil(right - left), chh = Math.ceil(bottom - top);
    if (cw <= 0 || chh <= 0) return null;

    const cv = document.createElement('canvas');
    cv.width = cw * SCALE; cv.height = chh * SCALE;
    const cx = cv.getContext('2d');
    cx.scale(SCALE, SCALE);

    const x0 = -left - sh.spread, y0 = -top - sh.spread;
    const w0 = bw + 2 * sh.spread, h0 = bh + 2 * sh.spread;
    const rr = Math.max(0, Math.min((it.radii?.tl?.[0] || 0) + sh.spread, w0 / 2, h0 / 2));
    const shape = () => {
      cx.beginPath();
      if (cx.roundRect) cx.roundRect(x0, y0, w0, h0, rr); else cx.rect(x0, y0, w0, h0);
    };

    // shadowBlur and shadowOffset are DEVICE units and ignore the canvas
    // transform, so they must be scaled by hand. Missing this silently shrinks
    // the blur by the supersampling factor.
    cx.shadowColor = sh.color;
    cx.shadowBlur = sh.blur * SCALE;
    cx.shadowOffsetX = sh.dx * SCALE;
    cx.shadowOffsetY = sh.dy * SCALE;
    cx.fillStyle = '#000';
    shape(); cx.fill();

    cx.shadowColor = 'transparent';
    cx.shadowBlur = 0; cx.shadowOffsetX = 0; cx.shadowOffsetY = 0;
    cx.globalCompositeOperation = 'destination-out';
    shape(); cx.fill();
    cx.globalCompositeOperation = 'source-over';

    const bin = atob(cv.toDataURL('image/png').split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { img: await doc.embedPng(bytes), left, top, w: cw, h: chh };
  }

  // ---------------------------------------------------------------- paint ---

  /**
   * Backgrounds, gradients, background-images, clipping and borders.
   * Order within an element is CSS paint order: clips, background colour,
   * gradient, background image, then borders on top.
   */
  async function emitPaint(page, items, ctx, xf, opts = {}) {
    const raw = (s) => ctx.raw(page, s);
    const stats = { backgrounds: 0, gradients: 0, bgImages: 0, clips: 0, borders: 0,
      dashedSides: 0, shadows: 0, blends: 0 };

    for (const it of items) {
      const b = it.box;
      page.pushOperators(ctx.pushGraphicsState());

      if (it.blend && BLEND[it.blend]) {
        raw(`/${ctx.alphaState(page, 1, 1, BLEND[it.blend])} gs`);
        stats.blends = (stats.blends || 0) + 1;
      }

      // Shadows paint BENEATH the element, before any clip is applied — an
      // outer shadow is not clipped by its own box.
      if (it.shadow) {
        const sh = await shadowImage(ctx.doc, it, opts.shadowScale || 3);
        if (sh) {
          page.drawImage(sh.img, {
            x: xf.x(b.x + sh.left), y: xf.y(b.y + sh.top + sh.h),
            width: sh.w * xf.PT, height: sh.h * xf.PT,
          });
          stats.shadows = (stats.shadows || 0) + 1;
        } else if (opts.onUnsupported) {
          opts.onUnsupported('inset', it);
        }
      }

      for (const ac of it.ancestorClips || []) {
        for (const op of boxOps(xf, ac, ac.radii)) raw(op);
        raw('W n');
        stats.clips++;
      }

      if (it.clip) {
        if (it.clip.kind === 'circle') {
          for (const op of circleOps(xf.x(b.x + it.clip.cx), xf.y(b.y + it.clip.cy), it.clip.r * xf.PT)) raw(op);
        } else if (it.clip.kind === 'polygon') {
          it.clip.points.forEach((p, i) => {
            raw(`${n(xf.x(b.x + p.x))} ${n(xf.y(b.y + p.y))} ${i === 0 ? 'm' : 'l'}`);
          });
          raw('h');
        } else if (it.clip.kind === 'rect') {
          for (const op of boxOps(xf, { x: b.x + it.clip.x, y: b.y + it.clip.y, w: it.clip.w, h: it.clip.h }, it.radii)) raw(op);
        }
        raw('W n');
        stats.clips++;
      }

      if (it.background) {
        raw(`${col(it.background)} rg`);
        for (const op of boxOps(xf, b, it.radii)) raw(op);
        raw('f');
        stats.backgrounds++;
      }

      if (it.gradient && !it.gradient.alpha) {
        const g = it.gradient;
        const fn = ctx.stopsToFunction(g.stops);
        page.pushOperators(ctx.pushGraphicsState());
        for (const op of boxOps(xf, b, it.radii)) raw(op);
        raw('W n');

        if (g.kind === 'linear') {
          const name = ctx.addShading(page, ctx.doc.context.obj({
            ShadingType: 2, ColorSpace: 'DeviceRGB',
            Coords: [xf.x(b.x + g.line.x0), xf.y(b.y + g.line.y0),
              xf.x(b.x + g.line.x1), xf.y(b.y + g.line.y1)],
            Function: fn, Extend: [true, true],
          }));
          raw(`/${name} sh`);
        } else {
          // PDF radial shadings are circular; an ellipse needs a scale about
          // its own centre so the same construct can express it.
          const cx = xf.x(b.x + g.cx), cy = xf.y(b.y + g.cy);
          const rx = g.rx * xf.PT, ry = g.ry * xf.PT;
          if (Math.abs(rx - ry) > 0.01) {
            page.pushOperators(
              ctx.concatTransformationMatrix(1, 0, 0, 1, cx, cy),
              ctx.concatTransformationMatrix(1, 0, 0, ry / rx, 0, 0),
              ctx.concatTransformationMatrix(1, 0, 0, 1, -cx, -cy),
            );
          }
          const name = ctx.addShading(page, ctx.doc.context.obj({
            ShadingType: 3, ColorSpace: 'DeviceRGB',
            Coords: [cx, cy, 0, cx, cy, rx], Function: fn, Extend: [true, true],
          }));
          raw(`/${name} sh`);
        }
        page.pushOperators(ctx.popGraphicsState());
        stats.gradients++;
      }

      if (it.bgImage && opts.loadImage) {
        const loaded = await opts.loadImage(it.bgImage.src);
        if (loaded) {
          const { img } = loaded;
          const nw = img.width, nh = img.height, cw = b.w, ch = b.h;
          let dw, dh;
          const size = it.bgImage.size;
          if (size === 'cover') { const s = Math.max(cw / nw, ch / nh); dw = nw * s; dh = nh * s; }
          else if (size === 'contain') { const s = Math.min(cw / nw, ch / nh); dw = nw * s; dh = nh * s; }
          else { dw = nw; dh = nh; }
          const [px, py] = String(it.bgImage.position).split(/\s+/);
          const rel = (t, free) => (String(t).endsWith('%') ? (parseFloat(t) / 100) * free : parseFloat(t) || 0);
          const dx = rel(px ?? '0%', cw - dw), dy = rel(py ?? '0%', ch - dh);

          page.pushOperators(ctx.pushGraphicsState());
          for (const op of boxOps(xf, b, it.radii)) raw(op);
          raw('W n');
          page.drawImage(img, {
            x: xf.x(b.x + dx), y: xf.y(b.y + dy + dh), width: dw * xf.PT, height: dh * xf.PT,
          });
          page.pushOperators(ctx.popGraphicsState());
          stats.bgImages++;
        }
      }

      if (it.borders) {
        const { widths: w, colors: c, styles: st } = it.borders;
        const X0 = xf.x(b.x), X1 = xf.x(b.x) + b.w * xf.PT;
        const Y1 = xf.y(b.y), Y0 = xf.y(b.y + b.h);
        const iX0 = X0 + w.l * xf.PT, iX1 = X1 - w.r * xf.PT;
        const iY1 = Y1 - w.t * xf.PT, iY0 = Y0 + w.b * xf.PT;

        const quad = (c2, pts) => {
          if (!c2 || c2.a === 0) return;
          raw(`${col(c2)} rg`);
          pts.forEach((p, i) => raw(`${n(p[0])} ${n(p[1])} ${i === 0 ? 'm' : 'l'}`));
          raw('h f');
        };

        // Dash geometry derived from Chromium's own output (findings 10):
        // dash is constant, the GAP stretches so the run fits the side exactly.
        // Thin borders (bw <= 2) are special-cased by Chromium.
        function dashRun(c2, bwPx, sidePx, style) {
          if (!c2 || c2.a === 0 || bwPx <= 0 || sidePx <= 0) return null;
          let dash, period, count;
          if (style === 'dotted') {
            dash = bwPx; period = 2 * bwPx;
            count = Math.floor(sidePx / period) + 1;      // dots are fenceposts
          } else {
            const thin = bwPx <= 2;
            dash = (thin ? 3 : 2) * bwPx;
            period = (thin ? 5 : 3) * bwPx;
            count = Math.ceil(sidePx / period);
          }
          count = Math.max(2, count);
          const gap = (sidePx - count * dash) / (count - 1);
          return gap < 0 ? null : { dash, gap, count };
        }

        const emitSide = (side, c2, bwPx, style) => {
          if (style !== 'dashed' && style !== 'dotted') return false;
          const horizontal = side === 't' || side === 'b';
          const run = dashRun(c2, bwPx, horizontal ? b.w : b.h, style);
          if (!run) return false;
          raw(`${col(c2)} rg`);
          for (let i = 0; i < run.count; i++) {
            const off = i * (run.dash + run.gap);
            let x, y, dw, dh;
            if (side === 't') { x = b.x + off; y = b.y; dw = run.dash; dh = bwPx; }
            else if (side === 'b') { x = b.x + off; y = b.y + b.h - bwPx; dw = run.dash; dh = bwPx; }
            else if (side === 'l') { x = b.x; y = b.y + off; dw = bwPx; dh = run.dash; }
            else { x = b.x + b.w - bwPx; y = b.y + off; dw = bwPx; dh = run.dash; }
            raw(`${n(xf.x(x))} ${n(xf.y(y + dh))} ${n(dw * xf.PT)} ${n(dh * xf.PT)} re f`);
          }
          stats.dashedSides++;
          return true;
        };

        if (w.t && !emitSide('t', c.t, w.t, st.t) && st.t === 'solid') quad(c.t, [[X0, Y1], [X1, Y1], [iX1, iY1], [iX0, iY1]]);
        if (w.b && !emitSide('b', c.b, w.b, st.b) && st.b === 'solid') quad(c.b, [[X0, Y0], [iX0, iY0], [iX1, iY0], [X1, Y0]]);
        if (w.l && !emitSide('l', c.l, w.l, st.l) && st.l === 'solid') quad(c.l, [[X0, Y1], [iX0, iY1], [iX0, iY0], [X0, Y0]]);
        if (w.r && !emitSide('r', c.r, w.r, st.r) && st.r === 'solid') quad(c.r, [[X1, Y1], [X1, Y0], [iX1, iY0], [iX1, iY1]]);
        stats.borders++;
      }

      page.pushOperators(ctx.popGraphicsState());
    }
    return stats;
  }

  // --------------------------------------------------------------- images ---

  async function emitImages(page, images, ctx, xf, opts = {}) {
    const raw = (s) => ctx.raw(page, s);
    const stats = { images: 0 };
    for (const im of images) {
      const loaded = opts.loadImage ? await opts.loadImage(im.src) : null;
      if (!loaded) continue;
      const { img } = loaded;

      page.pushOperators(ctx.pushGraphicsState());

      if (im.transform) {
        const m = im.transform;
        const ox = xf.x(im.box.x + (im.origin?.x || 0));
        const oy = xf.y(im.box.y + (im.origin?.y || 0));
        page.pushOperators(
          ctx.concatTransformationMatrix(1, 0, 0, 1, ox, oy),
          ctx.concatTransformationMatrix(m.a, -m.b, -m.c, m.d, 0, 0),
          ctx.concatTransformationMatrix(1, 0, 0, 1, -ox, -oy),
        );
      }

      const hasRadius = Object.values(im.radii || {}).some((v) => v[0] > 0 || v[1] > 0);
      if (im.needsClip || hasRadius) {
        for (const op of boxOps(xf, im.content, hasRadius ? im.radii : null)) raw(op);
        raw('W n');
      }
      if (im.opacity < 1) raw(`/${ctx.alphaState(page, im.opacity)} gs`);

      page.drawImage(img, {
        x: xf.x(im.content.x + im.dest.dx),
        y: xf.y(im.content.y + im.dest.dy + im.dest.dh),
        width: im.dest.dw * xf.PT, height: im.dest.dh * xf.PT,
      });

      page.pushOperators(ctx.popGraphicsState());
      stats.images++;
    }
    return stats;
  }

  // --------------------------------------------------------------- canvas ---

  /** A canvas is already pixels; embed them. */
  async function emitCanvas(page, canvases, ctx, xf, opts = {}) {
    const raw = (s) => ctx.raw(page, s);
    const stats = { canvases: 0 };
    for (const cv of canvases) {
      if (cv.tainted || !cv.dataUrl) {
        if (opts.onTainted) opts.onTainted(cv);
        continue;
      }
      const bin = atob(cv.dataUrl.split(',')[1]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const img = await ctx.doc.embedPng(bytes);

      page.pushOperators(ctx.pushGraphicsState());
      const hasRadius = Object.values(cv.radii || {}).some((v) => v[0] > 0 || v[1] > 0);
      if (hasRadius) {
        for (const op of boxOps(xf, cv.box, cv.radii)) raw(op);
        raw('W n');
      }
      if (cv.opacity < 1) raw(`/${ctx.alphaState(page, cv.opacity)} gs`);
      page.drawImage(img, {
        x: xf.x(cv.box.x), y: xf.y(cv.box.y + cv.box.h),
        width: cv.box.w * xf.PT, height: cv.box.h * xf.PT,
      });
      page.pushOperators(ctx.popGraphicsState());
      stats.canvases++;
    }
    return stats;
  }

  // ---------------------------------------------------------------- forms ---

  /**
   * Form controls as real AcroForm fields, so the PDF stays fillable.
   * Radio groups are collected first: PDF models a group as ONE field with
   * several widgets, where the DOM models it as several elements.
   */
  function emitForms(page, fields, ctx, xf, opts = {}) {
    const stats = { fields: 0, unsupported: 0, flattened: 0 };
    if (!fields.length) return stats;

    // Chromium's own print FLATTENS controls to drawn text. Real fields keep the
    // PDF fillable, which is usually what is wanted, but it means our text layer
    // differs from Chromium's — so the caller chooses.
    if (opts.mode === 'flatten') {
      // pdf-lib's drawText owns font resource naming; hand-writing Tf with a
      // guessed /Name is how you get a PDF that opens blank.
      for (const f of fields) {
        const text = (f.kind === 'checkbox' || f.kind === 'radio')
          ? (f.checked ? 'X' : '') : String(f.value || '');
        if (!text || !opts.font) continue;
        const size = f.fontSize * xf.PT;
        page.drawText(text, {
          x: xf.x(f.box.x) + 2,
          y: xf.y(f.box.y + f.box.h / 2) - size * 0.35,   // centred in the control
          size, font: opts.font,
        });
        stats.flattened++;
      }
      return stats;
    }

    const form = ctx.doc.getForm();
    const radios = new Map();

    for (const f of fields) {
      if (f.kind === 'unsupported') {
        stats.unsupported++;
        if (opts.onUnsupported) opts.onUnsupported(f);
        continue;
      }
      const at = {
        x: xf.x(f.box.x), y: xf.y(f.box.y + f.box.h),
        width: f.box.w * xf.PT, height: f.box.h * xf.PT,
      };
      try {
        if (f.kind === 'text') {
          const t = form.createTextField(f.name);
          if (f.value) t.setText(f.value);
          if (f.multiline) t.enableMultiline();
          if (f.readOnly) t.enableReadOnly();
          if (f.required) t.enableRequired();
          t.addToPage(page, at);
        } else if (f.kind === 'checkbox') {
          const c = form.createCheckBox(f.name);
          c.addToPage(page, at);
          if (f.checked) c.check();
          if (f.readOnly) c.enableReadOnly();
        } else if (f.kind === 'dropdown') {
          const d = form.createDropdown(f.name);
          d.setOptions(f.options);
          if (f.value) d.select(f.value);
          if (f.readOnly) d.enableReadOnly();
          d.addToPage(page, at);
        } else if (f.kind === 'radio') {
          if (!radios.has(f.group)) radios.set(f.group, form.createRadioGroup(f.group));
          const g = radios.get(f.group);
          g.addOptionToPage(f.value, page, at);
          if (f.checked) g.select(f.value);
        }
        stats.fields++;
      } catch (e) {
        stats.unsupported++;
        if (opts.onUnsupported) opts.onUnsupported({ ...f, reason: e.message });
      }
    }
    return stats;
  }

  // ------------------------------------------------------------------ svg ---

  const compose = (P, M) => ({
    a: P.a * M.a + P.c * M.b, b: P.b * M.a + P.d * M.b,
    c: P.a * M.c + P.c * M.d, d: P.b * M.c + P.d * M.d,
    e: P.a * M.e + P.c * M.f + P.e, f: P.b * M.e + P.d * M.f + P.f,
  });

  function emitSvg(page, shapes, ctx, xf) {
    const raw = (s) => ctx.raw(page, s);
    const toOps = globalThis.__pdf_svgPathToOps;
    const stats = { shapes: 0, skipped: 0, gradients: 0 };
    if (!toOps) return stats;

    for (const s of shapes) {
      if (s.skip) { stats.skipped++; continue; }

      // Viewport px -> page pt, as a matrix, so the shape's own CTM composes.
      const P = { a: xf.PT, b: 0, c: 0, d: -xf.PT, e: xf.x(0), f: xf.y(0) };
      const T = compose(P, s.ctm);

      page.pushOperators(ctx.pushGraphicsState());

      if (s.viewportClip) {
        const v = s.viewportClip;
        raw(`${n(xf.x(v.x))} ${n(xf.y(v.y + v.h))} ${n(v.w * xf.PT)} ${n(v.h * xf.PT)} re W n`);
      }

      if (s.clip) {
        for (const cp of s.clip.paths) {
          if (!cp.ctm) continue;
          const C = compose(P, cp.ctm);
          const det = C.a * C.d - C.b * C.c;
          if (!det) continue;
          page.pushOperators(ctx.concatTransformationMatrix(C.a, C.b, C.c, C.d, C.e, C.f));
          for (const op of toOps(cp.d)) raw(op);
          raw('W n');
          // q/Q would discard the clip along with the transform, so invert.
          page.pushOperators(ctx.concatTransformationMatrix(
            C.d / det, -C.b / det, -C.c / det, C.a / det,
            (C.c * C.f - C.d * C.e) / det, (C.b * C.e - C.a * C.f) / det,
          ));
        }
      }

      page.pushOperators(ctx.concatTransformationMatrix(T.a, T.b, T.c, T.d, T.e, T.f));

      const fA = (s.fill ? s.fillOpacity * (s.fill.a ?? 1) : 1) * s.opacity;
      const sA = (s.stroke ? s.strokeOpacity * (s.stroke.a ?? 1) : 1) * s.opacity;
      if (fA < 1 || sA < 1) raw(`/${ctx.alphaState(page, fA, sA)} gs`);

      if (s.fill) raw(`${col(s.fill)} rg`);
      const doStroke = s.stroke && s.strokeWidth > 0;
      if (doStroke) {
        raw(`${col(s.stroke)} RG`);
        raw(`${n(s.strokeWidth)} w`);
        raw(`${{ butt: 0, round: 1, square: 2 }[s.strokeLinecap] ?? 0} J`);
        raw(`${{ miter: 0, round: 1, bevel: 2 }[s.strokeLinejoin] ?? 0} j`);
        if (s.strokeMiterlimit) raw(`${n(s.strokeMiterlimit)} M`);
        if (s.strokeDasharray && s.strokeDasharray.length) {
          raw(`[${s.strokeDasharray.map(n).join(' ')}] ${n(s.strokeDashoffset)} d`);
        } else raw('[] 0 d');
      }

      for (const op of toOps(s.d)) raw(op);
      const eo = s.fillRule === 'evenodd';

      if (s.gradient) {
        raw(eo ? 'W* n' : 'W n');
        const g = s.gradient;
        const fn = ctx.stopsToFunction(g.stops);
        const name = ctx.addShading(page, g.kind === 'linear'
          ? ctx.doc.context.obj({ ShadingType: 2, ColorSpace: 'DeviceRGB',
            Coords: [g.x1, g.y1, g.x2, g.y2], Function: fn, Extend: [true, true] })
          : ctx.doc.context.obj({ ShadingType: 3, ColorSpace: 'DeviceRGB',
            Coords: [g.cx, g.cy, 0, g.cx, g.cy, g.r], Function: fn, Extend: [true, true] }));
        raw(`/${name} sh`);
        stats.gradients++;
        if (doStroke) { for (const op of toOps(s.d)) raw(op); raw('S'); }
      } else if (s.fill && doStroke) raw(eo ? 'B*' : 'B');
      else if (s.fill) raw(eo ? 'f*' : 'f');
      else if (doStroke) raw('S');
      else raw('n');

      page.pushOperators(ctx.popGraphicsState());
      stats.shapes++;
    }
    return stats;
  }

  // ---------------------------------------------------------------- links ---

  /**
   * Link annotations. These are page objects, not content-stream drawing, so
   * they are appended to the page's /Annots rather than painted.
   */
  function emitLinks(page, links, ctx, xf) {
    const { PDFName, PDFString, doc } = ctx;
    const annots = [];
    for (const ln of links) {
      for (const r of ln.rects) {
        annots.push(doc.context.register(doc.context.obj({
          Type: 'Annot', Subtype: 'Link',
          Rect: [xf.x(r.x), xf.y(r.y + r.h), xf.x(r.x) + r.w * xf.PT, xf.y(r.y)],
          Border: [0, 0, 0], F: 4,
          A: { Type: 'Action', S: 'URI', URI: PDFString.of(ln.href) },
        })));
      }
    }
    if (!annots.length) return { links: 0 };
    const existing = page.node.lookup(PDFName.of('Annots'));
    if (existing && existing.asArray) {
      for (const a of annots) existing.push(a);
    } else {
      page.node.set(PDFName.of('Annots'), doc.context.obj(annots));
    }
    return { links: annots.length };
  }

  globalThis.__pdf_emit = {
    createContext, emitPaint, emitImages, emitSvg, emitLinks, emitCanvas, emitForms,
    roundRectOps, circleOps, boxOps, parseShadow, shadowImage, BLEND,
  };
})();

// ===== src/text/fontRegistry.js =====
/**
 * Font registry with coverage enforcement.
 *
 * Findings 01 turned up the most dangerous behaviour in the whole programme:
 * a glyph the embedded font could not render became U+0000, silently, and the
 * PDF still looked plausible. Plan §16 calls for `missingFont: "error"` as the
 * default; this is that.
 *
 * Two resolutions happen here, and they are deliberately different — a
 * distinction established by findings 01:
 *
 *   metrics  -> the PRIMARY family of the declared list. Chromium positions the
 *               inline box from the primary font's metrics even when the glyphs
 *               come from a fallback, which is why baselines stay exact.
 *   glyphs   -> the first family in the declared list that actually COVERS the
 *               character. This mirrors Chromium's per-character fallback,
 *               restricted to explicitly declared families so the result stays
 *               deterministic.
 *
 * Requires fontkit (browser UMD build) on globalThis.
 * Installs globalThis.__pdf_FontRegistry.
 */
(function () {
  const norm = (f) => String(f).trim().replace(/^["']|["']$/g, '').toLowerCase();

  function familyList(cssFontFamily) {
    return String(cssFontFamily).split(',').map(norm).filter(Boolean);
  }

  class FontRegistry {
    constructor() {
      this.faces = [];          // { family, weight, style, src, bytes, fk }
      this.diagnostics = [];
    }

    register(spec) {
      this.faces.push({
        family: norm(spec.family),
        weight: spec.weight ?? 400,
        style: spec.style ?? 'normal',
        src: spec.src,
        bytes: null,
        fk: null,
      });
      return this;
    }

    async load() {
      for (const f of this.faces) {
        const res = await fetch(f.src);
        if (!res.ok) {
          this.diagnostics.push({
            code: 'PDF_RESOURCE_INACCESSIBLE',
            family: f.family,
            src: f.src,
            message: `The browser may display this font, but the PDF renderer could not read its bytes (HTTP ${res.status}).`,
          });
          continue;
        }
        f.bytes = await res.arrayBuffer();
        f.fk = fontkit.create(new Uint8Array(f.bytes));
      }
      return this;
    }

    /** Best registered face for a family name at a given weight/style. */
    face(family, weight, style) {
      const cands = this.faces.filter((f) => f.family === family && f.fk);
      if (!cands.length) return null;
      const exact = cands.find((f) => f.weight == weight && f.style === style);
      if (exact) return exact;
      const sameStyle = cands.filter((f) => f.style === style);
      const pool = sameStyle.length ? sameStyle : cands;
      // nearest weight
      return pool.reduce((a, b) =>
        Math.abs(b.weight - weight) < Math.abs(a.weight - weight) ? b : a);
    }

    covers(face, codePoint) {
      try {
        return face.fk.hasGlyphForCodePoint(codePoint);
      } catch {
        return false;
      }
    }

    /**
     * The face whose metrics govern the inline box: the first declared family
     * that is registered at all, regardless of coverage.
     */
    metricsFace(cs) {
      for (const fam of familyList(cs.fontFamily)) {
        const f = this.face(fam, cs.fontWeight, cs.fontStyle);
        if (f) return f;
      }
      return null;
    }

    /**
     * Split a string into runs, each backed by one face that covers every
     * character in it. Walks the declared family list per character.
     */
    shapeRuns(text, cs) {
      const families = familyList(cs.fontFamily);
      const runs = [];
      let cur = null;

      for (const ch of text) {                       // iterates by code point
        const cp = ch.codePointAt(0);
        let chosen = null;
        for (const fam of families) {
          const f = this.face(fam, cs.fontWeight, cs.fontStyle);
          if (f && this.covers(f, cp)) { chosen = f; break; }
        }

        if (!chosen) {
          const anyRegistered = families.some((fam) => this.face(fam, cs.fontWeight, cs.fontStyle));
          this.diagnostics.push({
            code: anyRegistered ? 'PDF_GLYPH_UNAVAILABLE' : 'PDF_FONT_UNAVAILABLE',
            char: ch,
            codePoint: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'),
            families,
            weight: cs.fontWeight,
            style: cs.fontStyle,
            message: anyRegistered
              ? `No registered font in [${families.join(', ')}] has a glyph for ${JSON.stringify(ch)}.`
              : `None of [${families.join(', ')}] is registered with the PDF renderer.`,
          });
          // Do not emit a glyph we do not have. Silence here is what produced
          // U+0000 in findings 01.
          cur = null;
          continue;
        }

        if (cur && cur.face === chosen) cur.text += ch;
        else { cur = { face: chosen, text: ch }; runs.push(cur); }
      }
      return runs;
    }

    /** Faces actually needed, for embedding. */
    usedFaces() {
      return this.faces.filter((f) => f.fk);
    }

    report() {
      const byCode = new Map();
      for (const d of this.diagnostics) {
        const k = `${d.code}:${d.codePoint ?? d.family ?? ''}`;
        if (!byCode.has(k)) byCode.set(k, { ...d, count: 0 });
        byCode.get(k).count++;
      }
      return [...byCode.values()];
    }
  }

  globalThis.__pdf_FontRegistry = FontRegistry;
})();

// ===== src/pagination/furniture.js =====
/**
 * Page furniture layer.
 *
 * Pagination splits into two questions, and conflating them is what made the
 * findings-03 divergences look like unrelated bugs:
 *
 *   the multicolumn oracle  ->  WHERE does fragmented flow content go?
 *   this layer              ->  WHAT must independently appear on each
 *                               physical page?
 *
 *        Page
 *         |- flow content        (oracle)
 *         `- furniture           (here)
 *              |- fixed elements
 *              |- repeated table header
 *              |- repeated table footer
 *              `- future running headers / footers
 *
 * All four page-vs-column divergences share one shape: content that paged media
 * repeats or re-geometries per page, which column fragmentation has no concept
 * of. One mechanism covers them, and it extends to running headers and page
 * numbers without a new special case each time.
 *
 * Three responsibilities, in order:
 *   DETACH   take furniture out of the flow before the oracle measures, so it
 *            cannot pollute column indexing
 *   RESERVE  give the oracle back the height the furniture will occupy, so page
 *            ASSIGNMENT is right and not just appearance
 *   EMIT     re-issue the furniture on every page it belongs to
 *
 * Installs globalThis.__pdf_furniture.
 */
(function () {
  const SPACER_ATTR = 'data-pdf-furniture-spacer';

  // ------------------------------------------------------- @page margin boxes
  //
  // Verified against Chromium rather than assumed: it fully supports
  // @top-center / @bottom-right / ... and counter(page) / counter(pages), and
  // exposes each as a CSSMarginRule through the CSSOM -- `.name` gives the slot
  // and `.style.content` the raw value. As with ::before in findings 09, static
  // strings arrive resolved and counters do not.
  //
  // Margin boxes live in the @page MARGIN, outside the content box, so unlike
  // repeated table sections they need EMIT but no RESERVE: they consume no
  // content height, and the constant-height assumption does not apply to them.

  // A margin box does NOT inherit from <body> -- it lives in the page context,
  // so its font falls back to the INITIAL value, not the document's. Measured
  // against Chromium: 16px serif reproduces its margin-box text widths to
  // 0.01px total across three strings, where the body's 11px sans-serif was
  // out by up to 42px (which then threw centred and right-aligned boxes off by
  // half and all of that error respectively).
  const MARGIN_BOX_DEFAULT_FONT = { size: 16, family: 'serif', weight: '400', style: 'normal' };

  const MARGIN_SLOTS = new Set([
    'top-left', 'top-center', 'top-right',
    'bottom-left', 'bottom-center', 'bottom-right',
  ]);

  /**
   * Every @page rule, keyed by name ('' = the default page).
   *
   * Named pages were recorded as a scope boundary. They are not: the CSSOM
   * exposes each rule's `size`, `margin` and its own margin boxes, and
   * `getComputedStyle(el).page` names the run an element belongs to. That is
   * everything needed to split a document into runs of uniform page geometry
   * and fragment each independently.
   */
  function pageRules() {
    const byName = new Map();
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      if (!rules) continue;
      for (const rule of rules) {
        if (!rule.cssRules || !/^@page/.test(rule.cssText || '')) continue;
        // selectorText is '' for the default page, 'wide' for a named page,
        // ':first' / ':left' / ':right' for the pseudo-class rules. All three
        // kinds cascade together, so they are kept separately and merged per
        // page rather than collapsed here.
        const name = (rule.selectorText || '').trim();
        byName.set(name, {
          name,
          size: rule.style.size || '',
          margin: rule.style.margin || '',
          boxes: [...(rule.cssRules || [])]
            .filter((c) => c.name && MARGIN_SLOTS.has(c.name))
            .map((c) => ({
              kind: 'margin-box', slot: c.name, content: c.style && c.style.content,
              font: {
                family: (c.style.fontFamily || '').trim(),
                size: parseFloat(c.style.fontSize) || null,
                weight: c.style.fontWeight || '',
                style: c.style.fontStyle || '',
              },
              color: c.style.color || '',
              unsupportedSlot: false,
            }))
            .filter((b) => b.content && b.content !== 'none' && b.content !== 'normal'),
        });
      }
    }
    return byName;
  }

  /**
   * The @page rules that apply to one page, merged.
   *
   * Verified against Chromium: page 1 of a document with a default rule, a
   * `:first` rule and a `:right` rule shows content from ALL THREE at once, so
   * these cascade per margin slot rather than one rule winning outright.
   * Order is least to most specific: default, spread side, :first, named.
   * `:right` is odd-numbered pages, `:left` even.
   */
  function rulesForPage(rules, pageName, pageIndex) {
    const order = ['', (pageIndex % 2 === 0) ? ':right' : ':left'];
    if (pageIndex === 0) order.push(':first');
    if (pageName) order.push(pageName);

    const bySlot = new Map();
    let size = '', margin = '';
    for (const key of order) {
      const r = rules.get(key);
      if (!r) continue;
      if (r.size) size = r.size;
      if (r.margin) margin = r.margin;
      for (const b of r.boxes) bySlot.set(b.slot, b);
    }
    return { size, margin, boxes: [...bySlot.values()] };
  }

  /**
   * Split a root into consecutive runs of uniform page geometry.
   *
   * Named runs NEST: a `page: tall` block inside a `page: wide` block produces
   * wide, then tall, then wide again — Chromium resumes the outer run after the
   * inner one. So this walks the tree in document order rather than only the
   * top-level children, grouping consecutive content by its effective page
   * name.
   *
   * A change of page context always forces a page break (verified: a
   * single-line paragraph before a named run still occupied a whole page), so
   * run boundaries and page boundaries coincide.
   */
  function segmentByPage(root) {
    // `page` is NOT inherited in Chrome -- a descendant of a `page: wide`
    // block reports "auto", not "wide". The effective run therefore comes from
    // the nearest self-or-ancestor carrying a non-auto value.
    const pageOf = (el) => {
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const v = getComputedStyle(n).page;
        if (v && v !== 'auto') return v.trim();
      }
      return '';
    };
    const items = [];
    (function visit(el) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const hasOwnText = [...el.childNodes]
        .some((n) => n.nodeType === 3 && n.data.trim());
      if (hasOwnText || !el.children.length) items.push({ el, page: pageOf(el) });
      for (const child of el.children) visit(child);
    })(root);

    const runs = [];
    for (const it of items) {
      const last = runs[runs.length - 1];
      if (last && last.page === it.page) last.elements.push(it.el);
      else runs.push({ page: it.page, elements: [it.el] });
    }
    return runs;
  }

  function marginBoxes() {
    const out = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }   // cross-origin
      if (!rules) continue;
      for (const rule of rules) {
        if (!rule.cssRules || !/^@page/.test(rule.cssText || '')) continue;
        for (const child of rule.cssRules) {
          const name = child.name;
          if (!name || !MARGIN_SLOTS.has(name)) continue;
          const content = child.style && child.style.content;
          if (!content || content === 'none' || content === 'normal') continue;
          out.push({
            kind: 'margin-box', slot: name, content,
            font: {
              family: (child.style.fontFamily || '').trim(),
              size: parseFloat(child.style.fontSize) || null,
              weight: child.style.fontWeight || '',
              style: child.style.fontStyle || '',
            },
            color: child.style.color || '',
            unsupportedSlot: false,
          });
        }
        // slots we do not place, reported rather than dropped
        for (const child of rule.cssRules) {
          if (child.name && !MARGIN_SLOTS.has(child.name)) {
            out.push({ kind: 'margin-box', slot: child.name, content: null, unsupportedSlot: true });
          }
        }
      }
    }
    return out;
  }

  /** Resolve a margin box's content for one page. */
  function resolveMarginContent(content, pageNumber, pageCount) {
    let text = '';
    let unresolved = null;
    const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|counter\(\s*([a-zA-Z-]+)\s*(?:,\s*([a-zA-Z-]+))?\s*\)|(\S+)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      if (m[1] !== undefined) text += m[1].replace(/\\(.)/g, '$1');
      else if (m[2] !== undefined) text += m[2].replace(/\\(.)/g, '$1');
      else if (m[3] !== undefined) {
        if (m[3] === 'page') text += String(pageNumber);
        else if (m[3] === 'pages') text += String(pageCount);
        else unresolved = m[3];
      } else if (m[5] && m[5] !== 'normal') unresolved = m[5];
    }
    return { text, unresolved };
  }

  /**
   * Where a margin box sits, in page CSS px.
   * Horizontal follows the CONTENT box (left / centred / right); vertical
   * centres the font box within the margin band.
   */
  function marginBoxPlacement(slot, page, metrics) {
    const top = slot.startsWith('top');
    const bandTop = top ? 0 : page.h - page.marginBottom;
    const bandH = top ? page.marginTop : page.marginBottom;
    const baseline = bandTop + (bandH - (metrics.ascent + metrics.descent)) / 2 + metrics.ascent;
    const contentL = page.marginLeft;
    const contentR = page.w - page.marginRight;
    return { baseline, contentL, contentR, align: slot.split('-')[1] };
  }


  function identify(root) {
    const fixed = [];
    const tables = [];

    for (const el of root.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;

      // position: fixed repeats on every printed page, and in a multicolumn
      // container it also positions against the viewport rather than the
      // container -- which invents columns that do not exist.
      if (cs.position === 'fixed') {
        const r = el.getBoundingClientRect();
        fixed.push({ kind: 'fixed', el, rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
      }
    }

    for (const table of root.querySelectorAll('table')) {
      const thead = table.querySelector(':scope > thead');
      const tfoot = table.querySelector(':scope > tfoot');
      const headRepeats = thead && getComputedStyle(thead).display === 'table-header-group';
      const footRepeats = tfoot && getComputedStyle(tfoot).display === 'table-footer-group';
      if (!headRepeats && !footRepeats) continue;
      tables.push({
        kind: 'table', table,
        head: headRepeats ? thead : null,
        foot: footRepeats ? tfoot : null,
        headH: headRepeats ? thead.getBoundingClientRect().height : 0,
        footH: footRepeats ? tfoot.getBoundingClientRect().height : 0,
      });
    }
    return { fixed, tables };
  }

  /**
   * Remove furniture from the flow the oracle is about to measure.
   * Fixed elements are the ones that actively corrupt it; repeated table
   * sections stay in place because their FIRST occurrence is real flow content.
   */
  function detach(furniture) {
    const restore = [];
    for (const f of furniture.fixed) {
      restore.push([f.el, f.el.style.display]);
      f.el.style.display = 'none';
    }
    return () => { for (const [el, d] of restore) el.style.display = d; };
  }

  /**
   * Give back the height the repeated sections will consume.
   *
   * A continuation page carries a header the oracle never accounted for, so
   * every row below it shifts and — near a boundary — lands on the wrong page.
   * Where the break falls depends on the reservation, and the reservation
   * depends on where the break falls, so this iterates until the set of
   * column-leading rows stops moving. Two or three passes in practice.
   */
  function reserve(furniture, measureColumns, maxPasses = 6) {
    clearSpacers();
    let passes = 0;
    let previous = '';

    for (; passes < maxPasses; passes++) {
      const cols = measureColumns();
      const signature = [];
      const wanted = [];

      for (const t of furniture.tables) {
        const rows = [...t.table.querySelectorAll('tbody > tr')]
          .filter((tr) => !tr.hasAttribute(SPACER_ATTR));
        if (!rows.length) continue;

        // the first body row landing in each column after the table's first
        const seen = new Map();
        for (const tr of rows) {
          const c = cols(tr);
          if (c === null) continue;
          if (!seen.has(c)) seen.set(c, tr);
        }
        // last body row landing in each column, for footer reservation
        const lastIn = new Map();
        for (const tr of rows) {
          const c = cols(tr);
          if (c !== null) lastIn.set(c, tr);
        }

        const columns = [...seen.keys()].sort((a, b) => a - b);
        // The signature must capture WHICH ROWS sit in each column, not merely
        // which columns the table spans. Tracking the span alone declares
        // convergence while rows are still moving.
        signature.push(columns.map((c) => `${c}:${rows.indexOf(seen.get(c))}`).join(','));

        // A repeated HEADER occupies the top of every continuation column, so
        // reserve before that column's first row.
        if (t.head) {
          for (const c of columns.slice(1)) {
            wanted.push({ before: seen.get(c), height: t.headH });
          }
        }
        // A repeated FOOTER occupies the bottom of every column except the
        // last, so reserving at the top of the next column would be wrong --
        // it has to push the trailing row out of the column it sits in.
        if (t.foot) {
          for (const c of columns.slice(0, -1)) {
            const tr = lastIn.get(c);
            if (tr) wanted.push({ before: tr, height: t.footH });
          }
        }
      }

      const sig = signature.join('|');
      if (sig === previous) break;                    // stable
      previous = sig;

      clearSpacers();
      for (const w of wanted) {
        if (!w.before || !w.before.parentNode) continue;
        const cells = w.before.children.length || 1;
        const tr = document.createElement('tr');
        tr.setAttribute(SPACER_ATTR, '1');
        const td = document.createElement('td');
        td.setAttribute('colspan', String(cells));
        td.style.cssText = `padding:0;border:0;height:${w.height}px;`;
        tr.appendChild(td);
        // break-before: avoid keeps the spacer with the row it reserves for
        tr.style.cssText = 'break-after:avoid;';
        w.before.parentNode.insertBefore(tr, w.before);
      }
    }
    return { passes, spacers: document.querySelectorAll(`[${SPACER_ATTR}]`).length };
  }

  /**
   * Forced page breaks -> column breaks, for the oracle.
   *
   * `page` is not the only value that breaks a page: Chromium also breaks on
   * `left`, `right`, `recto`, `verso` and legacy `always`. Translating only
   * `page` silently under-fragments — a `break-before: right` produced one
   * column where Chromium produced two pages.
   *
   * Note Chromium does NOT generate a blank verso for `left`/`right`; it treats
   * them as an ordinary forced break, so mapping them all to `column` matches.
   */
  const PAGE_BREAK_VALUES = /^(page|left|right|recto|verso|always)$/;

  function translatePageBreaks(root) {
    let n = 0;
    for (const el of root.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (PAGE_BREAK_VALUES.test(cs.breakBefore)) { el.style.breakBefore = 'column'; n++; }
      if (PAGE_BREAK_VALUES.test(cs.breakAfter)) { el.style.breakAfter = 'column'; n++; }
    }
    return n;
  }

  function clearSpacers() {
    for (const el of document.querySelectorAll(`[${SPACER_ATTR}]`)) el.remove();
  }

  /**
   * What must be drawn on each page, beyond the flow content.
   * `columnOf(el)` maps an element to its page index; `pageCount` bounds the
   * fixed elements, which appear on every page.
   */
  /** Individual text pieces, not textContent -- adjacent cells concatenate. */
  function textsOf(el) {
    const out = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = w.nextNode())) { const t = n.data.trim(); if (t) out.push(t); }
    return out;
  }

  function emit(furniture, columnOf, pageCount) {
    const perPage = Array.from({ length: pageCount }, () => []);

    for (const f of furniture.fixed) {
      for (let p = 0; p < pageCount; p++) {
        perPage[p].push({ kind: 'fixed', el: f.el, rect: f.rect, texts: textsOf(f.el) });
      }
    }

    for (const t of furniture.tables) {
      const rows = [...t.table.querySelectorAll('tbody > tr')]
        .filter((tr) => !tr.hasAttribute(SPACER_ATTR));
      const byCol = new Map();
      for (const tr of rows) {
        const c = columnOf(tr);
        if (c === null) continue;
        if (!byCol.has(c)) byCol.set(c, []);
        byCol.get(c).push(tr);
      }
      const cols = [...byCol.keys()].sort((a, b) => a - b);
      cols.forEach((c, i) => {
        if (i === 0) return;                          // first page: real flow content
        const first = byCol.get(c)[0];
        const last = byCol.get(c)[byCol.get(c).length - 1];
        // Only the HEADER is re-issued on continuations. The footer's own flow
        // position already lands on the final page, so re-issuing it here would
        // paint it twice there.
        if (t.head) perPage[c]?.push({ kind: 'table-header', el: t.head, anchor: first, height: t.headH, texts: textsOf(t.head) });
      });
      // a repeated footer also belongs at the foot of every earlier page
      if (t.foot) {
        cols.slice(0, -1).forEach((c) => {
          const last = byCol.get(c)[byCol.get(c).length - 1];
          perPage[c]?.push({ kind: 'table-footer', el: t.foot, anchor: last, height: t.footH, texts: textsOf(t.foot) });
        });
      }
    }
    return perPage;
  }

  globalThis.__pdf_furniture = {
    identify, detach, reserve, emit, clearSpacers, SPACER_ATTR,
    marginBoxes, resolveMarginContent, marginBoxPlacement,
    pageRules, segmentByPage, rulesForPage, translatePageBreaks,
    MARGIN_BOX_DEFAULT_FONT,
  };
})();

// ===== src/index.js =====
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

    /** First four bytes identify the container. */
    function fontFormat(bytes) {
      const tag = new DataView(bytes).getUint32(0);
      if (tag === 0x774F4632) return 'WOFF2';
      if (tag === 0x774F4646) return 'WOFF';
      if (tag === 0x00010000 || tag === 0x74727565) return 'TTF';
      if (tag === 0x4F54544F) return 'OTF';
      return 'unknown';
    }

    const embedded = new Map();
    async function embedFor(face) {
      const key = `${face.family}|${face.weight}|${face.style}`;
      if (!embedded.has(key)) {
        const format = fontFormat(face.bytes);
        // Subsetting a WOFF2 never returns: fontkit parses the container, but
        // pdf-lib's subsetter hangs on its compressed tables — permanently, not
        // slowly. Since WOFF2 is what most sites actually serve and subsetting
        // is the default, this would hang on the majority of real documents.
        // Embed the whole face instead and say what it cost.
        const compressed = format === 'WOFF2' || format === 'WOFF';
        const subset = opts.subset !== false && !compressed;
        if (compressed && opts.subset !== false) {
          diag('PDF_FONT_NOT_SUBSET',
            `"${face.family}" is ${format}, whose compressed tables hang the subsetter, so the `
            + 'whole face is embedded. The PDF is larger than it needs to be — supply a TTF or '
            + 'OTF for that family to get subsetting back.',
            { family: face.family, format });
        }
        embedded.set(key, await doc.embedFont(face.bytes, { subset }));
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
      if (face) return { font: await embedFor(face), substituted: false };
      const std = standardFontFor(f.family, f.weight, f.style);
      if (!embedded.has(std)) embedded.set(std, await doc.embedFont(std));
      diag('PDF_FONT_SUBSTITUTED',
        `no embeddable bytes for "${f.family}" ${f.weight} ${f.style} — substituted the standard `
        + `font ${std}. Word positions still come from the browser's own measurements; only glyph `
        + 'shapes differ. Declare an @font-face to embed the real font.',
        { requested: f.family, substituted: std });
      return { font: embedded.get(std), substituted: true };
    }

    /** WinAnsi covers Latin-1 and no more. */
    const winAnsiSafe = (t) => !/[^\u0000-\u00FF]/.test(t);
    function reportUnencodable(text, family) {
      const bad = [...text].find((c) => c.charCodeAt(0) > 0xFF) || '';
      diag('PDF_TEXT_NOT_ENCODABLE',
        `"${family}" had no embeddable bytes, and the substituted standard font cannot encode `
        + `${JSON.stringify(bad)}. That text is omitted. Declare an @font-face with a font that `
        + 'covers this script.', { family, sample: text.slice(0, 24) });
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

        const mbf = await fontFor({
          family, weight: mb.font.weight || DEF.weight, style: mb.font.style || DEF.style,
        });
        const font = mbf.font;
        if (mbf.substituted && !winAnsiSafe(text)) { reportUnencodable(text, family); continue; }

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
          if (ff.substituted && !winAnsiSafe(p.run.text)) { reportUnencodable(p.run.text, p.run.font.family); continue; }
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
        const { font, substituted } = await fontFor(run.font);
        if (substituted && !winAnsiSafe(run.text)) { reportUnencodable(run.text, run.font.family); continue; }

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
    FontRegistry: globalThis.__pdf_FontRegistry,
    furniture: globalThis.__pdf_furniture,
    emit: globalThis.__pdf_emit,
    version: '0.1.0-alpha.1',
  };

  // `Garri` is the package name; `PeeDeeEff` is kept as an alias so existing
  // script tags and the demo keep working.
  globalThis.Garri = API;
  globalThis.PeeDeeEff = API;
})();

})();

module.exports = globalThis.Garri;
