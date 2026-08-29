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
