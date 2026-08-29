/**
 * Box-decoration extraction.
 *
 * Turns each painted element into the geometry and paint state a PDF backend
 * needs: border box, per-corner radii, background, uniform border, opacity and
 * transform matrix. All of it is read from computed style and layout geometry —
 * nothing is recomputed.
 *
 * Requires paintOrder.js. Installs globalThis.__pdf_extractBoxes(root).
 */
(function () {
  const parseColor = (s) => {
    const m = String(s).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    const a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (a === 0) return null;              // fully transparent paints nothing
    return { r: +m[1], g: +m[2], b: +m[3], a };
  };

  // "14px" or "40px 8px" -> [horizontal, vertical]
  const radius = (v) => {
    const parts = String(v).split(/\s+/).map((x) => parseFloat(x) || 0);
    return parts.length === 1 ? [parts[0], parts[0]] : [parts[0], parts[1]];
  };

  /** Decompose a computed `transform` into a 2D matrix, or null. */
  function matrixOf(cs) {
    const t = cs.transform;
    if (!t || t === 'none') return null;
    const m = t.match(/^matrix\(([^)]+)\)$/);
    if (!m) return null;                    // matrix3d and friends: unhandled
    const n = m[1].split(',').map(Number);
    return { a: n[0], b: n[1], c: n[2], d: n[3], e: n[4], f: n[5] };
  }

  function extractBoxes(root) {
    const order = globalThis.__pdf_paintOrder(root);
    const out = [];

    for (const el of order) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;

      const bg = parseColor(cs.backgroundColor);
      const bw = {
        top: parseFloat(cs.borderTopWidth) || 0,
        right: parseFloat(cs.borderRightWidth) || 0,
        bottom: parseFloat(cs.borderBottomWidth) || 0,
        left: parseFloat(cs.borderLeftWidth) || 0,
      };
      const borderColor = parseColor(cs.borderTopColor);
      const uniformBorder =
        bw.top > 0 && bw.top === bw.right && bw.top === bw.bottom && bw.top === bw.left &&
        cs.borderTopStyle === 'solid';

      if (!bg && !uniformBorder) continue;   // nothing to paint

      const m = matrixOf(cs);

      // getBoundingClientRect returns the *transformed* box. For a transformed
      // element we need the untransformed border box plus the matrix, so the
      // backend can apply the same transform the browser did.
      let box = { x: r.left, y: r.top, w: r.width, h: r.height };
      if (m) {
        const ow = el.offsetWidth;
        const oh = el.offsetHeight;
        // Recover the untransformed origin: the transform is applied about
        // transform-origin, so undo it around that point.
        const [ox, oy] = String(cs.transformOrigin).split(/\s+/).map(parseFloat);
        // Untransformed top-left in viewport space: take the transformed centre
        // of the bounding rect and walk back through the matrix.
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        // centre of the untransformed box relative to the origin point
        const ux = ow / 2 - ox;
        const uy = oh / 2 - oy;
        const tx = m.a * ux + m.c * uy;
        const ty = m.b * ux + m.d * uy;
        box = { x: cx - tx - ox, y: cy - ty - oy, w: ow, h: oh, originX: ox, originY: oy };
      }

      out.push({
        id: el.id || el.tagName.toLowerCase(),
        box,
        radii: {
          tl: radius(cs.borderTopLeftRadius),
          tr: radius(cs.borderTopRightRadius),
          br: radius(cs.borderBottomRightRadius),
          bl: radius(cs.borderBottomLeftRadius),
        },
        background: bg,
        border: uniformBorder ? { width: bw.top, color: borderColor } : null,
        borderWidths: bw,
        opacity: parseFloat(cs.opacity),
        transform: m,
      });
    }
    return out;
  }

  globalThis.__pdf_extractBoxes = extractBoxes;
})();
