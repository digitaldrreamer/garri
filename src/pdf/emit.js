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

        const sameColor = (a, d) => a && d
          && ['r', 'g', 'b', 'a'].every((k) => Math.abs(a[k] - d[k]) < 1e-6);
        const hasRadius = Object.values(it.radii || {}).some((v) => v[0] > 0 || v[1] > 0);
        const uniformRounded = hasRadius
          && [st.t, st.r, st.b, st.l].every((v) => v === 'solid')
          && [w.r, w.b, w.l].every((v) => Math.abs(v - w.t) < 1e-6)
          && [c.r, c.b, c.l].every((v) => sameColor(v, c.t));

        if (uniformRounded && w.t > 0 && c.t && c.t.a > 0) {
          // A uniform rounded border is one ring: the outer rounded box minus
          // its inset rounded box. Side trapezoids leave square corner wedges,
          // which turned circular borders into squares and scarred card corners.
          raw(`${col(c.t)} rg`);
          if (c.t.a < 1 || it.blend) {
            raw(`/${ctx.alphaState(page, c.t.a, c.t.a,
              it.blend && BLEND[it.blend] ? BLEND[it.blend] : null)} gs`);
          }
          for (const op of boxOps(xf, b, it.radii)) raw(op);
          const inner = {
            x: b.x + w.l, y: b.y + w.t,
            w: b.w - w.l - w.r, h: b.h - w.t - w.b,
          };
          if (inner.w > 0 && inner.h > 0) {
            const ir = {
              tl: [Math.max(0, it.radii.tl[0] - w.l), Math.max(0, it.radii.tl[1] - w.t)],
              tr: [Math.max(0, it.radii.tr[0] - w.r), Math.max(0, it.radii.tr[1] - w.t)],
              br: [Math.max(0, it.radii.br[0] - w.r), Math.max(0, it.radii.br[1] - w.b)],
              bl: [Math.max(0, it.radii.bl[0] - w.l), Math.max(0, it.radii.bl[1] - w.b)],
            };
            for (const op of boxOps(xf, inner, ir)) raw(op);
            raw('f*');
          } else raw('f');
        } else {
          if (w.t && !emitSide('t', c.t, w.t, st.t) && st.t === 'solid') quad(c.t, [[X0, Y1], [X1, Y1], [iX1, iY1], [iX0, iY1]]);
          if (w.b && !emitSide('b', c.b, w.b, st.b) && st.b === 'solid') quad(c.b, [[X0, Y0], [iX0, iY0], [iX1, iY0], [X1, Y0]]);
          if (w.l && !emitSide('l', c.l, w.l, st.l) && st.l === 'solid') quad(c.l, [[X0, Y1], [iX0, iY1], [iX0, iY0], [X0, Y0]]);
          if (w.r && !emitSide('r', c.r, w.r, st.r) && st.r === 'solid') quad(c.r, [[X1, Y1], [X1, Y0], [iX1, iY0], [iX1, iY1]]);
        }
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
      // The translation has to be taken for THIS shape's column: xf.x folds
      // the column offset into its result and so is not affine, which made
      // `xf.x(0)` right only on the first page.
      const P = {
        a: xf.PT, b: 0, c: 0, d: -xf.PT,
        e: xf.originX ? xf.originX(s.ctm.e) : xf.x(0),
        f: xf.y(0),
      };
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
