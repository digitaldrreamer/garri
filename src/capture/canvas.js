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
