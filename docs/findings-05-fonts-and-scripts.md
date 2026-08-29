# Findings 05 — Font registry, complex scripts, and a retraction

**Status:** Gate 2 core claim PASS · one findings-01 conclusion retracted
**Date:** 2026-08-29
**Chromium:** Google Chrome for Testing 152.0.7977.54 (arm64, headless)
**Scope:** build-order items 1 and 2 — font registry, then complex-script validation

Gate 2 was the only gate whose core claim was still partly unproven, so it was
taken next rather than left to drift. The advance-width half was already
settled; what was untested was **glyph selection inside a word**: cursive
joining, contextual forms, conjuncts, ligatures.

That now passes. Along the way a conclusion from findings 01 turned out to be
wrong, and the reason it was wrong matters more than the conclusion did.

Run: `node experiments/gate2-complex-scripts.js`

---

## 1. Retraction: Chromium does not lose Arabic

Findings 01 §4.3 concluded that Chromium's `printToPDF` maps Arabic to
Presentation Forms-B, that text copied from Chrome's own PDF therefore does not
equal the source Unicode, and that a client-side renderer could be **"strictly
better"** than Chrome here.

**That was wrong.** It rested entirely on pdf.js, the only extractor the harness
used. Poppler's `pdftotext` recovers correct source Unicode, in logical order,
from exactly the same Chromium PDF:

```
$ pdftotext out/gate1-stress-chromium.pdf -
‫ قبل‬ASCII ‫بعد‬
```

The presentation-form codepoints were what **pdf.js reports**, not what the PDF
holds for a competent reader. Chromium's Arabic export is fine.

### The real finding

**A single extractor is not ground truth.** pdf.js and poppler disagree about
the same bytes, in both directions, in ways that reverse conclusions. Every
round-trip claim in this programme now runs against both, and the harness prints
the disagreement rather than hiding it.

This is the fifth measurement bug in five findings documents to produce a
confident, wrong number — and the second to look like a finding about Chromium
rather than about the harness.

---

## 2. Font registry with coverage enforcement

`src/text/fontRegistry.js`. Closes the worst defect in the codebase: findings 01
had a missing glyph become `U+0000` silently, in a PDF that still looked
plausible.

Two resolutions happen, and they are deliberately different — a distinction
established by findings 01:

| purpose | resolved from |
| --- | --- |
| **metrics** (baseline) | the **primary** family of the declared list |
| **glyphs** | the first declared family that actually **covers** the character |

That split is not a convenience. Findings 01 showed Chromium positions the
inline box from the primary font's metrics *even when the glyphs come from a
fallback*, which is exactly why baselines stayed exact under font fallback.
Reproducing the split preserves that.

Coverage is checked per code point via `fontkit.hasGlyphForCodePoint`. On a
miss the registry emits a diagnostic and **draws nothing** — silence was the
bug:

```
PDF_GLYPH_UNAVAILABLE  U+6F22 "漢" x1
  No registered font in [sans] has a glyph for "漢".
PDF_GLYPH_UNAVAILABLE  U+5B57 "字" x1
  No registered font in [sans] has a glyph for "字".
```

Chromium renders that CJK via system fallback; we refuse and say so. That is the
plan's §16 `missingFont: "error"` policy working as intended, and the deliberate
scope boundary of §17.

---

## 3. Glyph selection: the actual Gate 2 question

Fixture: Latin with `ffi`/`ffl` ligatures, Arabic (cursive joining), Hebrew
(RTL without joining), Devanagari (conjuncts and vowel reordering), a bidi line,
and a deliberate coverage hole.

**All scripts shape correctly.** Rasterised at 150 dpi against Chromium:

| metric | result |
| --- | --- |
| pixels differing > 32/255 | **0.302 %** |
| mean absolute difference | 0.400 / 255 |
| max horizontal correction applied | 2.52 % |

Per-line ink extents against Chromium, at 150 dpi:

| line | Δleft | Δright | Δwidth |
| --- | --- | --- | --- |
| latin | 0 | 0 | 0 |
| arabic | 0 | +1 | +1 |
| hebrew | 0 | 0 | 0 |
| devanagari | 0 | 0 | 0 |
| bidi | 0 | 0 | 0 |

Residual differences are confined to individual ligature and cursive clusters.

---

## 4. Two bugs that only RTL exposes

### 4.1 Word extents were built inside-out

The extractor built each word's box from its **first and last logical**
character. In RTL the first logical character is the **rightmost** one, so
`left` came from the right end and `right` from the left end. Every RTL word was
drawn overlapping its neighbour.

Fixed by taking min/max across all characters, which is direction-agnostic:

```js
w.left  = Math.min(w.left,  cr.left);
w.right = Math.max(w.right, cr.right);
```

Latin never exposes this, because there first/last and min/max coincide.

### 4.2 Shaper drift lands on the wrong edge in RTL

fontkit and Chromium's HarfBuzz agree on glyph *selection* but not always on
advances *within* a word — up to **2.52 %** of a word's width here, on ligature
clusters and cursive joins.

Drawing left-to-right from the word's measured `left` pushes all of that error
onto the **right** edge, which in RTL is where the word visually *begins* — the
most salient position on the line.

The fix follows the same principle as everywhere else in this architecture:
**make the browser's measurement authoritative.** PDF's `Tz` scales the run
horizontally so each word occupies exactly its measured width:

```js
const pct = (measuredWidth / shapedWidth) * 100;   // max observed: 102.52
```

Distortion is imperceptible and word boxes become exact regardless of which
shaper produced them. It also removes any future dependence on matching
HarfBuzz.

---

## 5. `/ActualText` — correct by spec, harmful in practice

Devanagari's pre-base vowel sign `ि` (U+093F) is stored **after** its consonant
but drawn **before** it. PDF extraction returns glyphs in drawing order, so the
text copies out reordered even though every glyph maps back to the right
codepoint. Our per-glyph `ToUnicode` is correct; the order is not.

The spec's remedy is `/Span <</ActualText (...)>> BDC … EMC` marked content. It
was implemented and verified present — 24 `beginMarkedContentProps`/
`endMarkedContent` pairs in the operator list.

Result:

- **pdf.js** ignores `ActualText` entirely, even with `includeMarkedContent: true`
- **poppler** honours it, and extracted the whole document as garbage

Net effect: harmful. It is now **opt-in** (`--actualtext`) and off by default.
Per-word spans are probably the wrong granularity; this needs proper work before
it ships.

---

## 6. Where each PDF actually stands

Round-trip of source Unicode, two extractors, both PDFs:

| paragraph | ours / pdf.js | ours / poppler | chrome / pdf.js | chrome / poppler |
| --- | --- | --- | --- | --- |
| latin | yes | yes | yes | yes |
| arabic | **yes** | **yes** | no | yes |
| hebrew | yes | yes | yes | yes |
| devanagari | no | no | no | **yes** |
| bidi | yes | no | no | no |
| CJK gap | no | no | yes | yes |

Read carefully:

- **Arabic** — ours survives *both* extractors; Chromium's survives only
  poppler. This is a real but much weaker version of the retracted claim: we are
  more robust across extractors, not uniquely correct.
- **Devanagari** — **Chromium is better than us.** It round-trips under poppler;
  ours does not, because of the reordering in §5.
- **bidi** — poppler emits *byte-identical* output for both PDFs
  (`‫ بعد‬PDF ‫قبل‬`), in visual rather than logical order.
  That row is poppler's own behaviour and does not differentiate the two.
- **CJK gap** — Chromium renders it via system fallback; we refuse loudly. Not a
  defect, a scope boundary.

---

## 7. A deployment trap

`@pdf-lib/fontkit`'s complex-script shaping is transpiled with generators and
requires a **`regeneratorRuntime` polyfill** in the browser. Latin never reaches
that code path, so the whole pipeline works perfectly until the first Arabic or
Indic string, then throws `ReferenceError: regeneratorRuntime is not defined`.

Anyone shipping this must load the polyfill up front, or discover it in
production on non-Latin content. It adds ~6 KB gzipped.

---

## 8. Gate 2 status

**Core claim: PASS.** Glyph selection is correct across Latin ligatures, Arabic
cursive joining, Hebrew, Devanagari conjuncts and bidi. Positioning matches
Chromium to ~0.6 CSS px, and the `Tz` correction makes word extents exact
independent of shaper agreement.

Outstanding in this area:

1. **Devanagari extraction order** — needs `ActualText` done properly, at the
   right granularity.
2. **Multi-face words** — the fixture produced none; sub-run positioning within a
   mixed-script word is untested.
3. **`ActualText` granularity** — per-word spans break poppler.
4. **Vertical scripts, Thai, Khmer** — untested.
