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

  const radius = (v, w, h) => {
    const p = String(v).split(/\s+/);
    const used = (token, base) => String(token).endsWith('%')
      ? (parseFloat(token) / 100) * base
      : (parseFloat(token) || 0);
    return p.length === 1
      ? [used(p[0], w), used(p[0], h)]
      : [used(p[0], w), used(p[1], h)];
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
          tl: radius(cs.borderTopLeftRadius, r.width, r.height),
          tr: radius(cs.borderTopRightRadius, r.width, r.height),
          br: radius(cs.borderBottomRightRadius, r.width, r.height),
          bl: radius(cs.borderBottomLeftRadius, r.width, r.height),
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
            if (cs.backgroundRepeat !== 'no-repeat') {
              unsupported.push({
                id: item.id,
                feature: 'background-repeat',
                detail: `${cs.backgroundRepeat} is painted once rather than tiled`,
              });
            }
          } else {
            unsupported.push({ id: item.id, feature: 'background-image', detail: bg.slice(0, 60) });
          }
        }
      }

      // --- clipping
      // SVG clip paths are resolved by the SVG extractor. Treating url(#id)
      // as an HTML CSS clip here produced a false PDF_PAINT_UNSUPPORTED beside
      // the correctly emitted SVG clip.
      const isSvg = el.namespaceURI === 'http://www.w3.org/2000/svg';
      if (!isSvg && cs.clipPath && cs.clipPath !== 'none') {
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
        // Dashed and dotted borders are emitted; the remaining styles are not.
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

      // No PDF primitive for a shadow; it is rasterised, as it is in Chromium's
      // own export.
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
            tl: radius(pcs.borderTopLeftRadius, pr.width, pr.height),
            tr: radius(pcs.borderTopRightRadius, pr.width, pr.height),
            br: radius(pcs.borderBottomRightRadius, pr.width, pr.height),
            bl: radius(pcs.borderBottomLeftRadius, pr.width, pr.height),
          },
        });
      }

      // `shadow` belongs in this list: an element whose only paint is a
      // box-shadow was being dropped before it ever reached the emitter, which
      // is why shadows silently went missing from documents that had them.
      if (item.gradient || item.bgImage || item.clip || item.borders || item.background ||
          item.shadow || item.blend || item.ancestorClips.length) {
        out.push(item);
      }
    }
    return { items: out, unsupported };
  }

  globalThis.__pdf_extractPaint = extractPaint;
  globalThis.__pdf_parseGradient = parseGradient;
})();
