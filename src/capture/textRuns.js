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

  /**
   * How much the element's own coordinate system is scaled on screen.
   *
   * SVG content is laid out in user units and then scaled by the viewBox
   * transform. `getComputedStyle` reports the font-size in those user units,
   * while the Range rects that position the text are already in device pixels.
   * Taking the size unscaled drew an 8.5-unit chart label at 8.5 px inside an
   * SVG scaled 1.58x, so every label came out too small — and, where labels sit
   * close together, overlapping. Only the size is wrong; the positions were
   * always right.
   *
   * Returns 1 for HTML, where the two systems are the same.
   */
  function userUnitScale(el) {
    if (!el.ownerSVGElement || typeof el.getScreenCTM !== 'function') return 1;
    const m = el.getScreenCTM();
    if (!m) return 1;
    const s = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
    return Number.isFinite(s) && s > 0 ? s : 1;
  }

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
  /**
   * `text-transform` changes what is PAINTED without changing the DOM text, so
   * a Range walk reports the untransformed string while the rects it measures
   * belong to the transformed glyphs. Drawing the DOM text then puts lowercase
   * letters at uppercase positions. Applied per character so indices still
   * line up with the probes; a transform that changes length (ß -> SS) is left
   * alone, since realigning it would cost more than it is worth here.
   */
  function applyTextTransform(data, mode) {
    if (!mode || mode === 'none') return data;
    let out = '';
    let atWordStart = true;
    for (const ch of data) {
      let c = ch;
      if (mode === 'uppercase') c = ch.toUpperCase();
      else if (mode === 'lowercase') c = ch.toLowerCase();
      else if (mode === 'capitalize') c = atWordStart ? ch.toUpperCase() : ch;
      out += c.length === 1 ? c : ch;
      atWordStart = /[\s\u00A0\-—–(\[{"'/]/.test(ch);
    }
    return out;
  }

  function lineFragments(textNode, textTransform) {
    const data = applyTextTransform(textNode.data, textTransform);
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
          // `chars` keeps each character's own measured x. A word whose
          // characters need different faces — Latin in the declared family,
          // CJK from a fallback — can then be drawn as several segments, each
          // at the position the browser actually put it.
          w = { text: data[i], left: cr.left, right: cr.right,
                chars: [{ ch: data[i], left: cr.left, right: cr.right }] };
          ln.words.push(w);
        } else {
          w.text += data[i];
          w.chars.push({ ch: data[i], left: cr.left, right: cr.right });
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
      const scale = userUnitScale(el);
      const fm0 = fontMetrics(style);
      const fm = scale === 1 ? fm0 : {
        font: fm0.font,
        ascent: fm0.ascent * scale,
        descent: fm0.descent * scale,
        actualAscent: fm0.actualAscent * scale,
        actualDescent: fm0.actualDescent * scale,
      };
      charProbes += node.data.length;

      for (const ln of lineFragments(node, style.textTransform)) {
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
            size: parseFloat(style.fontSize) * scale,
            weight: style.fontWeight,
            style: style.fontStyle,
            lineHeight: style.lineHeight,
            letterSpacing: scale === 1 ? style.letterSpacing
              : `${(parseFloat(style.letterSpacing) || 0) * scale}px`,
            wordSpacing: scale === 1 ? style.wordSpacing
              : `${(parseFloat(style.wordSpacing) || 0) * scale}px`,
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
