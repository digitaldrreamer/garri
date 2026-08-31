/**
 * Font registry with coverage enforcement.
 *
 * Findings 01 turned up the most dangerous behaviour in the whole programme:
 * a glyph the embedded font could not render became U+0000, silently, and the
 * PDF still looked plausible. Plan §16 calls for `missingFont: "error"` as the
 * default; this is that.
 *
 * Two resolutions happen here, and they are deliberately different — a
 * distinction established by findings 01:
 *
 *   metrics  -> the PRIMARY family of the declared list. Chromium positions the
 *               inline box from the primary font's metrics even when the glyphs
 *               come from a fallback, which is why baselines stay exact.
 *   glyphs   -> the first family in the declared list that actually COVERS the
 *               character. This mirrors Chromium's per-character fallback,
 *               restricted to explicitly declared families so the result stays
 *               deterministic.
 *
 * Requires fontkit (browser UMD build) on globalThis.
 * Installs globalThis.__pdf_FontRegistry.
 */
(function () {
  const norm = (f) => String(f).trim().replace(/^["']|["']$/g, '').toLowerCase();

  function familyList(cssFontFamily) {
    return String(cssFontFamily).split(',').map(norm).filter(Boolean);
  }

  class FontRegistry {
    constructor() {
      this.faces = [];          // { family, weight, style, src, bytes, fk }
      this.diagnostics = [];
    }

    register(spec) {
      this.faces.push({
        family: norm(spec.family),
        weight: spec.weight ?? 400,
        style: spec.style ?? 'normal',
        src: spec.src,
        bytes: null,
        fk: null,
      });
      return this;
    }

    async load() {
      for (const f of this.faces) {
        const res = await fetch(f.src);
        if (!res.ok) {
          this.diagnostics.push({
            code: 'PDF_RESOURCE_INACCESSIBLE',
            family: f.family,
            src: f.src,
            message: `The browser may display this font, but the PDF renderer could not read its bytes (HTTP ${res.status}).`,
          });
          continue;
        }
        f.bytes = await res.arrayBuffer();
        f.fk = fontkit.create(new Uint8Array(f.bytes));

        // Two formats reach the PDF pipeline in a state it cannot use, for two
        // different reasons, and both are answered by rebuilding the outlines
        // fontkit has already decoded into a plain TrueType font.
        //
        //   transformed WOFF2  `glyf` and `loca` are stored transformed.
        //                      fontkit reconstructs the glyphs but writes no
        //                      table back, so pdf-lib's subsetter copies the
        //                      transform; a whole-file embed hands the PDF a
        //                      `wOF2` container where a font program must be.
        //                      Either way the text extracts and draws NOTHING.
        //   CFF                Embeds correctly, but only WHOLE, because
        //                      fontkit's CFF subsetter is unusable. A 7.5 MB
        //                      face then lands in every PDF that uses one
        //                      character of it — measured at 11.9 MB for a
        //                      two-page résumé, against 188 KB rebuilt.
        //
        // WOFF v1 needs neither: fontkit decompresses each table on access.
        const t = (f.fk && f.fk.directory && f.fk.directory.tables) || {};
        const transformedGlyf = !!(t.glyf && t.glyf.transformed);
        const isCFF = !!t['CFF '];
        if (f.fk && (transformedGlyf || isCFF)) {
          let sfnt = null;
          try {
            sfnt = globalThis.__pdf_rebuildSfnt ? globalThis.__pdf_rebuildSfnt(f.fk) : null;
          } catch { sfnt = null; }
          if (sfnt) {
            const lost = sfnt.undecodableGlyphs || 0;
            f.bytes = sfnt;
            f.fk = fontkit.create(sfnt);
            this.diagnostics.push({
              code: 'PDF_FONT_RECONSTRUCTED',
              family: f.family,
              src: f.src,
              undecodableGlyphs: lost,
              message: `"${f.family}" was rebuilt as a TrueType font from the outlines fontkit `
                + `decodes, because ${transformedGlyf
                  ? 'a WOFF2 stores them in a transformed form no embedder downstream can read'
                  : 'a CFF face can otherwise only be embedded whole, at its full size'}. `
                + 'Composite glyphs are flattened and variation axes dropped, so the default '
                + 'instance is embedded — which is what a PDF can carry anyway.'
                + (lost ? ` ${lost} glyph(s) fontkit could not decode came out blank.` : ''),
            });
          } else if (isCFF) {
            // Whole-embedding a CFF is large but CORRECT, so a failed rebuild
            // falls back to it rather than throwing the real glyphs away.
            this.diagnostics.push({
              code: 'PDF_FONT_NOT_SUBSET',
              family: f.family,
              src: f.src,
              message: `"${f.family}" could not be rebuilt, so the whole face is embedded. The `
                + 'PDF is much larger than it needs to be. Supply a TrueType-outline version, or '
                + 'a font already cut down to the glyphs you need.',
            });
          } else {
            this.diagnostics.push({
              code: 'PDF_FONT_FORMAT_UNEMBEDDABLE',
              family: f.family,
              src: f.src,
              message: `"${f.family}" is a WOFF2 whose glyph outlines are stored in WOFF2's `
                + 'transformed form, and rebuilding it failed. A standard font is substituted so '
                + 'the text stays visible. Serve this family as TTF or OTF — or add one to the '
                + '@font-face `src` list — to embed the real glyphs.',
            });
            f.fk = null;
            f.bytes = null;
          }
        }
      }
      return this;
    }

    /** Best registered face for a family name at a given weight/style. */
    face(family, weight, style) {
      const cands = this.faces.filter((f) => f.family === family && f.fk);
      if (!cands.length) return null;
      const exact = cands.find((f) => f.weight == weight && f.style === style);
      if (exact) return exact;
      const sameStyle = cands.filter((f) => f.style === style);
      const pool = sameStyle.length ? sameStyle : cands;
      // nearest weight
      return pool.reduce((a, b) =>
        Math.abs(b.weight - weight) < Math.abs(a.weight - weight) ? b : a);
    }

    covers(face, codePoint) {
      try {
        return face.fk.hasGlyphForCodePoint(codePoint);
      } catch {
        return false;
      }
    }

    /**
     * The face whose metrics govern the inline box: the first declared family
     * that is registered at all, regardless of coverage.
     */
    metricsFace(cs) {
      for (const fam of familyList(cs.fontFamily)) {
        const f = this.face(fam, cs.fontWeight, cs.fontStyle);
        if (f) return f;
      }
      return null;
    }

    /**
     * The face that will actually DRAW this code point, or null if no declared
     * family covers it. This is the glyph resolution described above, exposed
     * one character at a time so a caller holding measured per-character
     * positions can place each segment itself.
     */
    faceForCodePoint(codePoint, cs) {
      for (const fam of familyList(cs.fontFamily)) {
        const f = this.face(fam, cs.fontWeight, cs.fontStyle);
        if (f && this.covers(f, codePoint)) return f;
      }
      return null;
    }

    /**
     * Split a string into runs, each backed by one face that covers every
     * character in it. Walks the declared family list per character.
     */
    shapeRuns(text, cs) {
      const families = familyList(cs.fontFamily);
      const runs = [];
      let cur = null;

      for (const ch of text) {                       // iterates by code point
        const cp = ch.codePointAt(0);
        let chosen = null;
        for (const fam of families) {
          const f = this.face(fam, cs.fontWeight, cs.fontStyle);
          if (f && this.covers(f, cp)) { chosen = f; break; }
        }

        if (!chosen) {
          const anyRegistered = families.some((fam) => this.face(fam, cs.fontWeight, cs.fontStyle));
          this.diagnostics.push({
            code: anyRegistered ? 'PDF_GLYPH_UNAVAILABLE' : 'PDF_FONT_UNAVAILABLE',
            char: ch,
            codePoint: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'),
            families,
            weight: cs.fontWeight,
            style: cs.fontStyle,
            message: anyRegistered
              ? `No registered font in [${families.join(', ')}] has a glyph for ${JSON.stringify(ch)}.`
              : `None of [${families.join(', ')}] is registered with the PDF renderer.`,
          });
          // Do not emit a glyph we do not have. Silence here is what produced
          // U+0000 in findings 01.
          cur = null;
          continue;
        }

        if (cur && cur.face === chosen) cur.text += ch;
        else { cur = { face: chosen, text: ch }; runs.push(cur); }
      }
      return runs;
    }

    /** Faces actually needed, for embedding. */
    usedFaces() {
      return this.faces.filter((f) => f.fk);
    }

    report() {
      const byCode = new Map();
      for (const d of this.diagnostics) {
        const k = `${d.code}:${d.codePoint ?? d.family ?? ''}`;
        if (!byCode.has(k)) byCode.set(k, { ...d, count: 0 });
        byCode.get(k).count++;
      }
      return [...byCode.values()];
    }
  }

  globalThis.__pdf_FontRegistry = FontRegistry;
})();
