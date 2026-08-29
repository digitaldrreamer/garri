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
