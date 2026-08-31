/**
 * Rebuild a plain TrueType font from one fontkit can read but the PDF pipeline
 * cannot use.
 *
 * Two formats arrive that way, for different reasons:
 *
 *   transformed WOFF2   `glyf` and `loca` are stored transformed. fontkit
 *                       reconstructs the glyphs but writes no table back, so
 *                       pdf-lib's subsetter copies the transform; embedding the
 *                       file whole hands the PDF a `wOF2` container where a font
 *                       program must be. Either way the text extracts perfectly
 *                       and draws NOTHING (findings 21 §8).
 *   CFF                 Embeds correctly, but only WHOLE, because fontkit's CFF
 *                       subsetter produces a font that draws empty boxes. A
 *                       7.5 MB face then lands in every PDF that uses one
 *                       character of it: 11.9 MB for a two-page résumé, against
 *                       188 KB rebuilt, rendering within 0.05 % of it.
 *
 * What IS reliable in both is `glyph.path`. A `glyf` font's paths are already
 * quadratic, which is exactly what TrueType stores; CFF's are cubic and are
 * subdivided to a bounded error. Every glyph is re-encoded from its own path as
 * a simple contour and the remaining tables are copied across.
 *
 * Composite glyphs come out flattened, which is why component renumbering — the
 * part that makes a byte-copy subset impossible — never arises. The
 * variable-font tables are dropped, because `gvar` deltas index outlines that no
 * longer exist after re-encoding; the default instance is what a PDF carries
 * anyway. Hinting instructions are dropped with them.
 *
 * Installs globalThis.__pdf_rebuildSfnt.
 */
(function () {
  // Tables that describe variation, which a re-encoded static outline set
  // cannot honour, plus the two we rebuild ourselves.
  const DROP = new Set(['fvar', 'gvar', 'avar', 'cvar', 'STAT', 'MVAR', 'HVAR', 'VVAR',
    'glyf', 'loca', 'maxp', 'CFF ', 'CFF2', 'VORG']);

  function u8(font, entry) {
    const buf = font.stream.buffer;
    const start = entry.offset;
    const len = entry.transformLength != null ? entry.transformLength : entry.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = buf[start + i];
    return out;
  }

  /**
   * A cubic as one or more quadratics, within a fixed error in font units.
   *
   * The single-quadratic approximation of a cubic puts its control point at
   * (3·C1 − P0 + 3·C2 − P3)/4, and its worst deviation is bounded by
   * |P3 − 3·C2 + 3·C1 − P0| · √3/36. Where that bound is too large the cubic is
   * split at its midpoint and each half handled the same way, so the error is
   * driven below the tolerance rather than hoped to be small.
   *
   * At 1000 units/em, a quarter of a unit is a four-thousandth of the em —
   * far below anything a PDF renderer can show.
   */
  const CUBIC_TOLERANCE = 0.25;

  function cubicToQuadratics(x0, y0, x1, y1, x2, y2, x3, y3, push, depth = 0) {
    const dx = x3 - 3 * x2 + 3 * x1 - x0;
    const dy = y3 - 3 * y2 + 3 * y1 - y0;
    const err = Math.sqrt(dx * dx + dy * dy) * (Math.sqrt(3) / 36);
    if (err <= CUBIC_TOLERANCE || depth >= 8) {
      push((3 * x1 - x0 + 3 * x2 - x3) / 4, (3 * y1 - y0 + 3 * y2 - y3) / 4, false);
      push(x3, y3, true);
      return;
    }
    // de Casteljau at t = 0.5
    const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2;
    const x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2;
    const x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2;
    const xa = (x01 + x12) / 2, ya = (y01 + y12) / 2;
    const xb = (x12 + x23) / 2, yb = (y12 + y23) / 2;
    const xm = (xa + xb) / 2, ym = (ya + yb) / 2;
    cubicToQuadratics(x0, y0, x01, y01, xa, ya, xm, ym, push, depth + 1);
    cubicToQuadratics(xm, ym, xb, yb, x23, y23, x3, y3, push, depth + 1);
  }

  /** Path -> contours of {x, y, on}. Quadratics are native; cubics are split. */
  function contoursOf(path) {
    const contours = [];
    let cur = null;
    let cx = 0, cy = 0;
    // A path is not obliged to open with `moveTo`. Source Han Serif KR has
    // glyphs whose first command is a `lineTo` or a `bezierCurveTo`, and
    // dropping everything before the first `moveTo` lost four of them entirely.
    // The current point is (0, 0) until something moves it, so that is where an
    // implied contour starts.
    const open = () => {
      if (!cur) { cur = []; contours.push(cur); cur.push({ x: Math.round(cx), y: Math.round(cy), on: true }); }
    };
    const push = (x, y, on) => { open(); cur.push({ x: Math.round(x), y: Math.round(y), on }); };
    for (const c of path.commands) {
      const a = c.args;
      if (a.some((v) => !Number.isFinite(v))) return null;   // fontkit could not decode it
      switch (c.command) {
        case 'moveTo':
          cur = []; contours.push(cur); push(a[0], a[1], true); cx = a[0]; cy = a[1];
          break;
        case 'lineTo':
          push(a[0], a[1], true); cx = a[0]; cy = a[1];
          break;
        case 'quadraticCurveTo':
          push(a[0], a[1], false); push(a[2], a[3], true); cx = a[2]; cy = a[3];
          break;
        case 'bezierCurveTo': {
          // CFF outlines are cubic; TrueType stores quadratics only. Subdivide
          // until each piece is within CUBIC_TOLERANCE font units of the cubic
          // it replaces, rather than approximating at a fixed depth.
          cubicToQuadratics(cx, cy, a[0], a[1], a[2], a[3], a[4], a[5], push);
          cx = a[4]; cy = a[5];
          break;
        }
        case 'closePath':
          cur = null;
          break;
        default:
          break;
      }
    }
    // A closing point identical to the start is implied by the contour itself.
    for (const c of contours) {
      while (c.length > 1) {
        const f = c[0], l = c[c.length - 1];
        if (f.x === l.x && f.y === l.y && l.on) c.pop(); else break;
      }
    }
    return contours.filter((c) => c.length > 0);
  }

  /**
   * One simple glyph. Deltas are written as int16 with no short or repeat
   * flags: larger than a tuned encoder, and the font is subset before it ever
   * reaches a PDF, so the size never leaves this function.
   */
  function encodeGlyph(path) {
    const contours = contoursOf(path);
    // null means fontkit produced non-finite coordinates for this glyph; a
    // blank is the honest outcome, and the count is reported.
    if (contours === null) return null;
    if (!contours.length) return new Uint8Array(0);      // blank glyph, e.g. space

    const pts = [].concat(...contours);
    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    for (const p of pts) {
      if (p.x < xMin) xMin = p.x;
      if (p.y < yMin) yMin = p.y;
      if (p.x > xMax) xMax = p.x;
      if (p.y > yMax) yMax = p.y;
    }

    const size = 10 + contours.length * 2 + 2 + pts.length * 5;
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    let o = 0;
    dv.setInt16(o, contours.length); o += 2;
    dv.setInt16(o, xMin); o += 2;
    dv.setInt16(o, yMin); o += 2;
    dv.setInt16(o, xMax); o += 2;
    dv.setInt16(o, yMax); o += 2;
    let end = -1;
    for (const c of contours) { end += c.length; dv.setUint16(o, end); o += 2; }
    dv.setUint16(o, 0); o += 2;                          // no instructions
    for (const p of pts) { out[o++] = p.on ? 1 : 0; }     // ON_CURVE only
    let px = 0;
    for (const p of pts) { dv.setInt16(o, p.x - px); o += 2; px = p.x; }
    let py = 0;
    for (const p of pts) { dv.setInt16(o, p.y - py); o += 2; py = p.y; }
    return out.subarray(0, o);
  }

  const pad4 = (n) => (n + 3) & ~3;

  function checksum(bytes) {
    let sum = 0;
    for (let i = 0; i < bytes.length; i += 4) {
      const w = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
      sum = (sum + w) >>> 0;
    }
    return sum;
  }

  /**
   * `maxp` version 1.0, built rather than copied.
   *
   * A CFF font carries version 0.5, which is six bytes long and holds nothing
   * but the glyph count — legal for CFF outlines and rejected for `glyf` ones.
   * Copying it across would produce a font that parses right up to the point
   * where something asks how big a glyph can be.
   */
  function buildMaxp(numGlyphs, maxPoints, maxContours) {
    const b = new Uint8Array(32);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 0x00010000);
    dv.setUint16(4, numGlyphs);
    dv.setUint16(6, maxPoints);
    dv.setUint16(8, maxContours);
    dv.setUint16(10, maxPoints);       // no composites survive the rebuild
    dv.setUint16(12, maxContours);
    dv.setUint16(14, 2);               // maxZones
    return b;
  }

  /**
   * @param {object} font a fontkit font whose outlines nothing downstream can
   *   embed — a WOFF2 with a transformed `glyf`, or a CFF face
   * @returns {Uint8Array|null} a TrueType font, or null if it cannot be built
   */
  function rebuildSfnt(font) {
    const dir = font.directory && font.directory.tables;
    if (!dir || !(dir.glyf || dir['CFF '])) return null;
    font.head;                                            // force decompression

    const numGlyphs = font.numGlyphs;
    const glyf = [];
    const loca = new Uint8Array(4 * (numGlyphs + 1));
    const locaView = new DataView(loca.buffer);
    let at = 0;
    let maxPoints = 0, maxContours = 0, undecodable = 0;
    for (let i = 0; i < numGlyphs; i++) {
      locaView.setUint32(i * 4, at);
      let enc;
      try { enc = encodeGlyph(font.getGlyph(i).path); } catch { enc = null; }
      if (enc === null) { undecodable++; enc = new Uint8Array(0); }
      if (enc.length >= 10) {
        const dv = new DataView(enc.buffer, enc.byteOffset, enc.byteLength);
        const nc = dv.getInt16(0);
        maxContours = Math.max(maxContours, nc);
        maxPoints = Math.max(maxPoints, dv.getUint16(10 + (nc - 1) * 2) + 1);
      }
      const padded = pad4(enc.length);
      const chunk = new Uint8Array(padded);
      chunk.set(enc);
      glyf.push(chunk);
      at += padded;
    }
    locaView.setUint32(numGlyphs * 4, at);

    const glyfBytes = new Uint8Array(at);
    let g = 0;
    for (const c of glyf) { glyfBytes.set(c, g); g += c.length; }

    const tables = [];
    for (const [tag, entry] of Object.entries(dir)) {
      if (DROP.has(tag)) continue;
      tables.push([tag, u8(font, entry)]);
    }
    tables.push(['glyf', glyfBytes], ['loca', loca],
      ['maxp', buildMaxp(numGlyphs, maxPoints, maxContours)]);

    // `head` must advertise the long `loca` this writes, and its checksum
    // adjustment is computed over the finished file.
    const head = tables.find((t) => t[0] === 'head');
    if (!head) return null;
    const headView = new DataView(head[1].buffer, head[1].byteOffset, head[1].byteLength);
    headView.setUint32(8, 0);                             // checkSumAdjustment
    headView.setInt16(50, 1);                             // indexToLocFormat: long

    tables.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const n = tables.length;
    let maxPow = 1;
    while (maxPow * 2 <= n) maxPow *= 2;

    const headerSize = 12 + n * 16;
    let total = headerSize;
    for (const [, b] of tables) total += pad4(b.length);

    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x00010000);
    dv.setUint16(4, n);
    dv.setUint16(6, maxPow * 16);
    dv.setUint16(8, Math.log2(maxPow));
    dv.setUint16(10, n * 16 - maxPow * 16);

    let rec = 12;
    let off = headerSize;
    for (const [tag, bytes] of tables) {
      for (let i = 0; i < 4; i++) dv.setUint8(rec + i, tag.charCodeAt(i));
      const padded = pad4(bytes.length);
      const chunk = new Uint8Array(padded);
      chunk.set(bytes);
      dv.setUint32(rec + 4, checksum(chunk));
      dv.setUint32(rec + 8, off);
      dv.setUint32(rec + 12, bytes.length);
      out.set(chunk, off);
      off += padded;
      rec += 16;
    }

    // head.checkSumAdjustment = 0xB1B0AFBA - checksum(whole file)
    const headIdx = tables.findIndex((t) => t[0] === 'head');
    let headOff = headerSize;
    for (let i = 0; i < headIdx; i++) headOff += pad4(tables[i][1].length);
    dv.setUint32(headOff + 8, (0xB1B0AFBA - checksum(out)) >>> 0);
    out.undecodableGlyphs = undecodable;
    return out;
  }

  globalThis.__pdf_rebuildSfnt = rebuildSfnt;
})();
