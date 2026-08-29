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
