/**
 * Rebuild a plain TrueType font from a WOFF2 that fontkit can read but nothing
 * downstream can embed.
 *
 * WOFF2 stores `glyf` and `loca` in a transformed form. fontkit reconstructs
 * those into glyph objects but never writes real tables back, and pdf-lib's
 * subsetter builds its `glyf` by copying byte ranges out of the source table —
 * so it copies the transform. Embedding the file whole is no better: a `wOF2`
 * container is not a TrueType program. Both produce a PDF whose text extracts
 * perfectly and draws NOTHING (findings 21 §8).
 *
 * What IS reliable is `glyph.path`: fontkit decodes the transformed outlines
 * correctly, and for a `glyf`-based font those paths are already quadratic,
 * which is exactly what TrueType stores. So every glyph is re-encoded from its
 * own path as a simple contour, and the untransformed tables are copied across
 * unchanged. Composite glyphs come out flattened, which is why component
 * renumbering — the part that made a byte-copy subset impossible — never
 * arises.
 *
 * The variable-font tables are deliberately dropped: `gvar` deltas index the
 * original outlines, and after re-encoding they would describe a font that no
 * longer exists. The result is the default instance, which is what a PDF can
 * carry anyway.
 *
 * Installs globalThis.__pdf_woff2ToSfnt.
 */
(function () {
  // Tables that describe variation, which a re-encoded static outline set
  // cannot honour, plus the two we rebuild ourselves.
  const DROP = new Set(['fvar', 'gvar', 'avar', 'cvar', 'STAT', 'MVAR', 'HVAR', 'VVAR', 'glyf', 'loca']);

  function u8(font, entry) {
    const buf = font.stream.buffer;
    const start = entry.offset;
    const len = entry.transformLength != null ? entry.transformLength : entry.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = buf[start + i];
    return out;
  }

  /** Path -> contours of {x, y, on}. Quadratics are native; cubics are split. */
  function contoursOf(path) {
    const contours = [];
    let cur = null;
    let cx = 0, cy = 0;
    const push = (x, y, on) => cur && cur.push({ x: Math.round(x), y: Math.round(y), on });
    for (const c of path.commands) {
      const a = c.args;
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
          // A glyf font should never produce one; approximate rather than fail.
          const [x1, y1, x2, y2, x3, y3] = a;
          const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
          push((cx + 3 * x1) / 4, (cy + 3 * y1) / 4, false); push(mx, my, true);
          push((x3 + 3 * x2) / 4, (y3 + 3 * y2) / 4, false); push(x3, y3, true);
          cx = x3; cy = y3;
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
   * @param {object} font a fontkit WOFF2Font
   * @returns {Uint8Array|null} a TrueType font, or null if it cannot be built
   */
  function woff2ToSfnt(font) {
    const dir = font.directory && font.directory.tables;
    if (!dir || !dir.glyf) return null;
    font.head;                                            // force decompression

    const numGlyphs = font.numGlyphs;
    const glyf = [];
    const loca = new Uint8Array(4 * (numGlyphs + 1));
    const locaView = new DataView(loca.buffer);
    let at = 0;
    for (let i = 0; i < numGlyphs; i++) {
      locaView.setUint32(i * 4, at);
      let enc;
      try { enc = encodeGlyph(font.getGlyph(i).path); } catch { enc = new Uint8Array(0); }
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
    tables.push(['glyf', glyfBytes], ['loca', loca]);

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
    return out;
  }

  globalThis.__pdf_woff2ToSfnt = woff2ToSfnt;
})();
