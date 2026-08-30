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
| CFF subsetting | A Korean résumé rendered as **empty boxes**, 89 % less ink | fontkit's CFF subsetter emits a font poppler refuses; on another face it throws. CFF is now embedded whole. §8 |
| Rotated SVG text | An axis label drawn as a **column of letters** | Line grouping buckets characters by `top`, and under a rotation every character has its own. §8 |
| The harness itself | The forced-font column compared **different documents** | It declared a Latin-only face, so Chromium fell back to a system CJK font and Garri dropped the text. §8 |
| WOFF2 embedding | Every glyph in the face **invisible** | We embedded the `wOF2` container itself as `FontFile2`, which must be a TrueType program. Text extracted perfectly and drew nothing. §8 |
| Column offset | Each line's first word **thrown to the far right of the page**, and full-page backgrounds off the page entirely | The draw path used `x % pitch`; the fragmenter assigned columns with `floor(x / pitch + 1e-3)`. A word a fraction of a pixel left of its column origin fell on opposite sides of the two rules. §8 |
| SVG matrix | Every SVG **missing from page 2 onward** | The shape matrix was built from `xf.x(0)`, but `xf.x` folds the column offset in and is not affine, so the translation was only right in the first column. §8 |
| WinAnsi test | **A whole line lost to one en dash** | The test for "can the substituted standard font encode this" was `codePoint <= 0xFF`, which rejects the entire 0x80–0x9F block that WinAnsi does encode — and it dropped the run, not the character. §8 |
| `counter-increment` order | Lists numbered **0, 1, 2** instead of 1, 2, 3 | The `::before` snapshot was taken before the element's own increment. §8 |
| Out-of-flow pseudos | `position: absolute` markers **took a line of their own** | Only inline properties were copied onto the materialised span, so an abspos pseudo — already blockified — was re-inserted into the flow. §8 |
| SVG `<text>` size | Chart labels **too small, and overlapping** | `getComputedStyle` reports the font-size in SVG user units; the Range rects that position it are already in device pixels. §8 |

All fixed. `demo-mole` (§4) turned out not to be a defect at all.

## 3. Where it landed

**10 of 10 documents now paginate to exactly Chromium's page count.**

| | Worst page | Median | Mean |
| --- | ---: | ---: | ---: |
| As authored | 8.01 % | 3.38 % | 3.57 % |
| With an embeddable font forced on both sides | **5.15 %** | **1.07 %** | **1.49 %** |

That second row is the useful one. Forcing one font both sides separates *did
Garri reproduce the browser's layout* from *could Garri read the font at all* —
and **58 % of the difference is font substitution, not rendering.**

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

Measured at that point, before the six fixes in §7 moved them again:

| | Worst | Median | Mean |
| --- | ---: | ---: | ---: |
| Forced font, before | 6.30 % | 2.44 % | 2.52 % |
| Forced font, after | 5.38 % | 2.41 % | 2.17 % |

As-authored numbers barely moved (3.85 % → 3.84 % mean): those documents declare
a font that covers their own script, so the primary face was already the right
one. **The defect was invisible in exactly the case the suite measured most.**

## 7. Six more, found by looking at the pages instead of the numbers

Everything above came from a number moving. The next six came from reading the
rendered pages — and the metric had been quiet about all of them.

**A WOFF2 was embedded as-is.** `demo-agent-slides` sets its headers, footers
and code blocks in JetBrains Mono, served as WOFF2. None of it appeared. The
text was in the PDF, at coordinates matching Chromium to a tenth of a point,
and simply drew nothing: the PDF held the `wOF2` container in a `FontFile2`,
which must be a TrueType program. Poppler said so plainly — *"Embedded font
file may be invalid"* — and nothing in our pipeline was listening.

That came from a workaround for a finding in §2 that was **wrong**. WOFF2
subsetting was recorded as hanging permanently. Measured again, in this
browser: a WOFF2 subsets in **18 ms**, and an 18 MB CJK TTF in **40 ms**.
Embedding whole is the slow path — 1.1 s and 12 MB for that TTF — and it is
what broke the font. The workaround caused the defect it was meant to avoid.

Subsetting a transformed-`glyf` WOFF2 does not work either, for a reason worth
recording: fontkit reconstructs those glyphs into objects but never writes a
real table back, and pdf-lib's subsetter builds its `glyf` by copying byte
ranges out of the source table — so it copies the transform. Such a face is now
refused outright, with `PDF_FONT_FORMAT_UNEMBEDDABLE`, and a standard font
substituted so the text is at least *visible*. WOFF v1 is fine: fontkit
decompresses each table on access.

**A modulo disagreed with a floor.** The first word of every line on
`demo-kaku` p6 sat at the far right of the page — at x = 552.5 pt, the same
value for every line. The fragmenter assigns a box to its column with
`floor((x - box.left) / pitch + 1e-3)`; the draw path placed it with
`(x - box.left) % pitch`. For a word measuring a *fraction of a pixel* left of
its column's origin, which the first word of a line routinely does, the two
rules land a whole column apart. The epsilon existed precisely for this and was
only ever applied on one side.

The same transform places paint, so a full-page background rect went off the
page too. That is why `demo-agent-slides` rendered on white: **a missing page
background differs from white by 18/255, under the 32/255 threshold the diff
metric counts.** The number never moved.

**Every SVG vanished from page 2 onward.** The shape matrix was built as
`{ a: PT, e: xf.x(0) }`, but `xf.x` folds the column offset into its result and
is therefore not affine — `xf.x(0)` is the right translation only in the first
column. A chart on slide 1 was perfect; the identical chart on slide 5 was
drawn at its absolute viewport x, off the page. `emitSvg` reported all 38
shapes emitted, every time.

**One en dash cost a line.** "300–400K tokens regardless of the model." was
absent from `demo-agent-slides` p5. The guard for "can the substituted standard
font encode this" was `codePoint <= 0xFF`. WinAnsi is ASCII, Latin-1 **and** the
0x80–0x9F block — the quotes, dashes and bullets prose is full of — so the test
rejected characters the font encodes perfectly well, and dropped the whole run
rather than the character. Both halves are fixed: the test is the real WinAnsi
repertoire, and runs are segmented per character using the measured
per-character positions added in §6.

**Lists counted from zero.** `counter-increment` on the item with
`content: counter(...)` on its marker gave 0, 1, 2 where Chromium gave 1, 2, 3.
An element's own increment applies *before* its `::before` is evaluated
(css-lists-3 §4.3); the snapshot was taken before it.

**Markers took a line of their own.** `li::before { position: absolute }` was
materialised with only its inline properties copied, so an out-of-flow pseudo —
blockified by the abspos — was re-inserted into the flow.

**SVG labels were too small.** `getComputedStyle` reports an SVG font-size in
user units; the Range rects that position the text are already in device
pixels. An 8.5-unit label in an SVG scaled 1.58× was drawn at 8.5 px. Positions
were always right, which is what made it read as a font problem.

| | Worst | Median | Mean |
| --- | ---: | ---: | ---: |
| As authored, before these six | 8.01 % | 3.85 % | 3.85 % |
| As authored, after | 8.01 % | **3.51 %** | **3.69 %** |
| Forced font, before | 6.30 % | 2.44 % | 2.52 % |
| Forced font, after | **5.38 %** | **1.47 %** | **1.87 %** |

`demo-agent-slides` under a forced font went from 3.28 % to **0.72 %** — the
document that had been missing its fonts, its backgrounds, its charts and a
line of prose.

The lesson is in the size of those moves against how much was actually wrong.
Four of the six were invisible to the metric: a background under the threshold,
a chart drawn off-page, text drawn in an unusable font, a line quietly dropped.
**A page-level pixel percentage is a regression test, not an inspection.** Ten
documents found eight defects when we read the numbers and six more when we
looked at the pages.

## 8. Closing the open items

**The metric's blind spot, made visible.** Every page now carries a second
figure: the share of pixels differing by more than **2**/255 rather than 32.
Checked against the page §7 caught by eye, it reads exactly as it should — that
page scored **5.13 % at 32/255 while 99.76 % of its pixels were wrong**. Across
the suite today the worst page reads 11.50 % at the low threshold, which is the
antialiasing fringe around text and nothing more. The class of defect that hid
behind the headline number now has a number of its own.

**The forced-font column was measuring the wrong thing.** It declared one
Latin-only face, so on a Chinese or Korean document Chromium fell back to a
system CJK font while Garri — whose fallback is restricted to declared
families — had nothing and dropped the text. `demo-resume-ko` was extracting
**636 characters against Chromium's 2 351**: the two sides were not rendering
the same document, and the number meant nothing. The stack now carries a CJK
and a Korean face alongside the Latin one, all embeddable. Every document
extracts its full text on both sides, and the column finally answers the
question it was built to ask.

**`demo-resume-ko`, the worst residue, was rendering as empty boxes.** With
fonts equalised it still measured 4.75 %, and the placement was *exact* — Δx
−0.01 pt, Δy −0.03 pt, Δwidth 0.00 pt across every matched item. What the pixel
number could not say is that Chromium had 39 685 dark pixels on that page and
Garri had 4 286: **89 % less ink**. Every Hangul glyph was an empty box.

The cause is the WOFF2 story again in a different container. Source Han Serif
KR has OpenType/CFF outlines, and fontkit's CFF subsetter produced a font
poppler refuses outright — *"Couldn't create a font"* — while the whole face
renders correctly. A second CFF face threw `RangeError` from
`CFFSubset.encode`, which would have taken the render down. CFF faces are now
embedded whole:

| `demo-resume-ko`, as its author wrote it | before | after |
| --- | ---: | ---: |
| ink against Chromium's 41 131 | 3 964 | **37 664** |
| worst page | 7.38 % | **5.25 %** |
| PDF size | 248 KB | 12.1 MB |

That size is the honest cost of a correct document, and `PDF_FONT_NOT_SUBSET`
now reports it per face so a caller can decide to supply a TrueType version.

**Rotated SVG text is drawn rotated.** The line grouping buckets characters by
their `top`, so under a 90-degree rotation every character became its own line
and an axis label came out as a column of letters. The SVG DOM answers this
directly: `getStartPositionOfChar` gives the baseline origin and the CTM gives
the angle. Advances within such a run come from the font rather than the
browser — the only place in the pipeline where that is true, and worth stating.

**Reading order: a hypothesis, measured and rejected.** Chromium emits
`demo-agent-slides` p2's closing paragraph *before* the list above it. That is
what CSS 2.1 Appendix E predicts — `ul.pts li` is `position: relative`, and
positioned elements paint in step 8 against in-flow content in step 7 — and
`paintOrder.js` already computes exactly that ranking for the paint pipeline.
Sorting the text runs by it made reading order **worse**: character-exact pages
fell from 9 of 27 to 3, and the main suite from 19/19 to 18/19. So Chromium's
text order is not CSS paint order, and the change is reverted. The rank is
still recorded on every run, because it is the only ordering signal we have and
whatever does explain Chromium's order will be checked against it.

## 9. Still open

- Reading order. 9 of 27 pages extract character-exact as authored, 18 of 27
  with fonts equalised; the rest have every character but not Chromium's
  sequence. The paint-order explanation is now ruled out (§8).
- 99 of the 21 358 characters in the suite are dropped, all of them characters
  no font the document declares actually contains — `TsangerJinKai02` has no
  `ー` (U+30FC), for instance. Chromium reaches a system font for these; our
  fallback is deliberately restricted to declared families, so the gap is
  reported rather than filled.
- SVG `<text>` ignores `textLength`, per-glyph `rotate`, and anchoring beyond
  what the measured origin already encodes.
- Under a forced Latin face, CJK is now *dropped and reported* rather than
  silently nulled — correct, but it means the forced-font column understates
  how those documents would render with a real fallback declared. A CJK
  fallback in the harness would measure the layout question more honestly.
- Text extraction order still diverges from Chromium's on several documents:
  Garri emits paint, then flow, then furniture; Chromium interleaves in document
  order. Every character is present; the sequence a copy-paste yields is not the
  same.
