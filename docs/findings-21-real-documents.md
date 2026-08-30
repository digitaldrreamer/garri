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

All fixed except the last row of §4.

## 3. Where it landed

**10 of 10 documents now paginate to exactly Chromium's page count.**

| | Worst page | Median | Mean |
| --- | ---: | ---: | ---: |
| As authored | 16.74 % | 4.38 % | 5.08 % |
| With an embeddable font forced on both sides | **6.30 %** | **2.28 %** | **2.52 %** |

That second row is the useful one. Forcing one font both sides separates *did
Garri reproduce the browser's layout* from *could Garri read the font at all* —
and **roughly half the difference is font substitution, not rendering.**

## 4. `demo-mole` was not a bug, and proving that mattered

At 16.74 % it was the worst page here, and three plausible explanations were
wrong before the right one:

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

## 6. Still open

- `demo-tesla` got *worse* under the forced font (3.37 % → 6.15 %), which the
  substitution story does not explain. Unexamined.
- `demo-resume-ko` is the worst residue at 6.30 % with fonts equalised.
- Text extraction order still diverges from Chromium's on several documents:
  Garri emits paint, then flow, then furniture; Chromium interleaves in document
  order. Every character is present; the sequence a copy-paste yields is not the
  same.
