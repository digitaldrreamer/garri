# Findings 21 — First contact with documents we did not write

**Status:** 10/10 paginate exactly · seven defects found, six fixed
**Date:** 2026-08-30

Run: `node experiments/kami-compare.js && node experiments/kami-report.js`
Full document with images: [`kami/COMPARISON.md`](../kami/COMPARISON.md)

---

## 1. Why this was different

Twenty findings documents, every one measured against a fixture written here to
probe one mechanism. That is a good way to establish that a mechanism works and
a poor way to find out whether anything survives a real document.

[tw93/Kami](https://github.com/tw93/Kami)'s ten demo documents were written by
someone else, for their own tool, with no knowledge of this renderer. They found
**seven defects in an afternoon** — more than the previous twenty findings
combined, and none of them subtle.

## 2. What broke

| | Effect | Cause |
| --- | --- | --- |
| `max-width` on the root | `demo-resume-ko` rendered **43 pages** against 2 | The fragmentation container is widened to hold every column; a `@media screen` `max-width` clamped it, so the derived pitch came out **33px instead of 606px** |
| WOFF2 fonts | Render **hung permanently** | pdf-lib's subsetter never returns on a WOFF2 face. Subsetting is the default; WOFF2 is what most sites serve |
| One CJK character | Whole document failed | A substituted standard font is WinAnsi-only, and pdf-lib throws rather than dropping the glyph |
| `@page { size: A4 }` | Every document silently mis-sized | The parser only understood `210mm 297mm`. **Not one of the ten uses that form.** `A4 landscape` rendered portrait; `margin: 0` became 20mm |
| `@page:first` | `demo-kaku` off by one page | One multicolumn container has one column height, so a run whose first page differs cannot be fragmented in a single pass |
| `text-transform` | Text drawn lowercase at uppercase positions | A Range walk reports DOM text; the rects it measures belong to the transformed glyphs. **Eight of ten documents use it** |
| Shadow-only elements | Shadows silently absent | `extractPaint` kept an item only if it had a background, border, gradient or clip — `shadow` was missing from that list |
| Root background | Documents rendered on white | `root.querySelectorAll('*')` never includes the root, and the root's background is what propagates to the canvas |
| Uncovered glyphs | **5 814 characters written as `U+0000`, silently** | The drawing path took the *metrics* face and handed it whole words. The coverage check the font registry exists to perform was never called. §6 |

All fixed. `demo-mole` (§4) turned out not to be a defect at all.

## 3. Where it landed

**10 of 10 documents now paginate to exactly Chromium's page count.**

| | Worst page | Median | Mean |
| --- | ---: | ---: | ---: |
| As authored | 8.01 % | 3.88 % | 3.84 % |
| With an embeddable font forced on both sides | **5.38 %** | **2.41 %** | **2.17 %** |

That second row is the useful one. Forcing one font both sides separates *did
Garri reproduce the browser's layout* from *could Garri read the font at all* —
and **43 % of the difference is font substitution, not rendering.**

> These figures were first published here as 16.74 / 4.38 / 5.08 and
> 6.30 / 2.28 / 2.52. Those came from a run taken *before* the fixes in §2 had
> all landed, and were never re-measured after. The numbers above are from the
> current tree, and `kami-report.js` now computes the substitution share from
> the data rather than restating a figure that can go stale.

## 4. `demo-mole` was not a bug, and proving that mattered

At the time, 16.74 % was the worst page here, and three plausible explanations
were wrong before the right one:

1. *The image is misplaced.* A shift search found 38–41 % difference at **every**
   offset from −14 to +14 px, in both axes. Not placement.
2. *It is photo resampling noise.* It survived 8× downsampling at 23.4 %. Real
   noise averages away; this did not.
3. *Something is missing.* Mean colour per band was near-identical in all
   fourteen bands, including the dark photograph. Nothing missing.

Matching every uniquely identifiable string between the two PDFs gave the
answer: **median Δx −0.10 pt, Δy −0.20 pt** — placement is exact — but **median
Δwidth −1.90 pt**. Glyph *advances* differ. The document asks for
`Charter, Georgia, Palatino, "Times New Roman", serif` with no `@font-face`: all
system fonts, whose bytes a page cannot read.

Re-rendering the same document with an embeddable font: **16.74 % → 1.32 %**,
with no diagnostics at all.

This is the documented limit doing exactly what it says, and it is the single
largest contributor to pixel difference across every document here.

## 5. What this says about the method

Every one of these defects was invisible to twenty findings' worth of fixtures,
for the same reason: **the CSS under test was the CSS we wrote.** We wrote
`size: 210mm 297mm` because that is what the spec's grammar shows; the world
writes `size: A4`. We used a TTF because that is what was to hand; the world
serves WOFF2. We never wrote `text-transform` in a fixture, so it was never
extracted.

A fixture proves a mechanism works. Only a document written by someone else
proves the mechanism is reachable.

## 6. `demo-tesla` got worse under the forced font, and that was the real find

The one line in §6 that the substitution story did not explain — `demo-tesla`
rising from 3.37 % to 6.15 % when a font was *forced* — turned out to be the
most serious defect in the programme.

Extracting the text of the forced-font PDF: Chromium's page 2 has 738 CJK
characters. Garri's has **7**. The other 731 are `U+0000`. Page 1 the same:
342 against 7. No diagnostic was raised.

`src/text/fontRegistry.js` opens by naming this exact failure — *"a glyph the
embedded font could not render became U+0000, silently, and the PDF still
looked plausible"* — and implements `shapeRuns` to stop it, resolving metrics
from the primary family and glyphs from the first family that **covers** the
character. `src/index.js` never called it. It took `metricsFace` alone, handed
the whole word to that one face, and pdf-lib mapped every uncovered code point
to glyph 0 without throwing. The guard existed; the pipeline walked past it.

FEATURES.md had claimed *"`PDF_GLYPH_UNAVAILABLE` rather than a silent
`U+0000`"* since the beginning. It was true only for the *substituted* standard
fonts, where pdf-lib throws — the one path with a `try`/`catch` around it. For
every embedded font, the documented behaviour was simply absent.

Measured across all twenty Kami PDFs:

| | Characters written as `U+0000` |
| --- | ---: |
| Before | **5 814** of 49 768 |
| After | **0** of 43 246 |

61 of those were in `demo-kaku` rendered **as its author wrote it** — not under
any harness contrivance.

The fix wires coverage into the drawing path. `lineFragments` already measures
every character's rect to build word extents; it now keeps them, so a word can
be split at coverage boundaries and each segment drawn at the x the browser
measured for it, rather than at an advance we computed. A character no declared
family covers is dropped and reported.

| | Worst | Median | Mean |
| --- | ---: | ---: | ---: |
| Forced font, before | 6.30 % | 2.44 % | 2.52 % |
| Forced font, after | **5.38 %** | **2.41 %** | **2.17 %** |

As-authored numbers barely move (3.85 % → 3.84 % mean): those documents declare
a font that covers their own script, so the primary face was already the right
one. **The defect was invisible in exactly the case the suite measured most.**

## 7. Still open

- `demo-resume-ko` is the worst residue at 4.75 % with fonts equalised.
- Under a forced Latin face, CJK is now *dropped and reported* rather than
  silently nulled — correct, but it means the forced-font column understates
  how those documents would render with a real fallback declared. A CJK
  fallback in the harness would measure the layout question more honestly.
- Text extraction order still diverges from Chromium's on several documents:
  Garri emits paint, then flow, then furniture; Chromium interleaves in document
  order. Every character is present; the sequence a copy-paste yields is not the
  same.
