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
