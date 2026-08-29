# Findings 01 — Text geometry and the first proof-of-concept

**Status:** Gate 1 PASS · Gate 5 PASS (for text) · Gate 2 partially answered
**Date:** 2026-08-29
**Chromium:** Google Chrome for Testing 152.0.7977.54 (arm64, headless)
**Scope:** plan §36 (first POC), §37 Gates 1/2/5, deliverable 4 (text fidelity report)

Everything below is measured, reproducible output from the scripts in
`experiments/`. Nothing here is inferred from reading Chromium source.

> **One conclusion in this document has been retracted.** §4.3 originally
> claimed Chromium's PDF loses Arabic text; it does not. See the correction
> there and in findings 05. The geometry results in §2–§3 are unaffected —
> they were re-checked and stand.

---

## 1. Method

The experiment is deliberately adversarial about its own ground truth.

```
fixture.html
     │
     ├──► Chromium renders it on screen
     │         │
     │         └──► our extractor  (Web APIs only)  ──► our PDF (pdf-lib)
     │
     └──► the SAME Chromium instance ──► Page.printToPDF ──► reference PDF
                                                                  │
                              compare placement, text, pixels ◄────┘
```

The extractor never sees the reference PDF. Chromium's own PDF is the
yardstick, not an input. Baselines are read out of the reference PDF's text
operators (`Tm`/`Td` origins via pdf.js), which is the only way to obtain
Chromium's true baseline — no Web API exposes it.

Run it:

```
node experiments/gate1-baselines.js gate1-text     # geometry vs Chromium
node experiments/poc-render.js     gate1-text      # build our PDF and score it
python3 experiments/pngdiff.py out/ours-1.png out/chrome-1.png out/diff.png
```

---

## 2. Headline result

Rendering a PDF from **nothing but Web-API observations** of the browser's
layout reproduces Chromium's own PDF output on the `gate1-text` fixture:

| Metric vs Chromium `printToPDF` | Result |
| --- | --- |
| Baseline position | **0.0000 px** mean and max error (n=18) |
| Left edge position | 0.0009 px mean, **0.0078 px** max |
| Run width | 0.053 pt mean, 0.305 pt max |
| Text round-trip | **381 / 381 chars exact** — selectable and searchable |
| Ink pixels (150 dpi raster) | **26926 vs 26926 — identical** |
| Pixels differing > 32/255 | 0.213 % (antialiasing fringes only) |
| Mean pixel difference | 0.199 / 255 |
| Our PDF size | 7.7 KB vs Chromium's 9.3 KB |
| Build time | ~35 ms |

The fixture exercises four font sizes (14/16/18/32 px), three line-heights
(`1`, `24px`, `2.5`), wrapping, a narrow column, and combined
`letter-spacing` + `word-spacing`.

The visual diff (`out/diff.png`) shows every glyph overlapping, with only
sub-pixel colour fringing. No structural offset, no differing line breaks.

---

## 3. The central mechanism: recovering the baseline

> **Platform-invariant by construction (confirmed 2026-08-29).** `fontMetrics()`
> reads `measureText().fontBoundingBoxAscent`, and
> [`text_metrics.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/html/canvas/text_metrics.cc)
> derives that from `font_data->GetFontMetrics()` — the *same* `FontMetrics`
> object Blink uses for line layout. Platforms disagree on which ascent to read
> (macOS/CoreText uses `hhea`, Windows uses `usWinAscent`), but the line box and
> our reported ascent move **together**, so `top + ascent` lands on the baseline
> everywhere. Absolute pixel values legitimately differ; the formula does not.


**No Web API exposes a text baseline.** This was the project's biggest open
question and it turns out to be exactly recoverable.

```
baseline_y  =  Range.getBoundingClientRect().top
             + CanvasTextMetrics.fontBoundingBoxAscent
```

This is exact — not approximate — because of a property of Chrome that the
experiment confirmed directly:

> **A Range's client rect for text is the *font* box, not the *line* box.**

Measured on the fixture:

| element | font-size | line-height | Range rect height | ascent + descent |
| --- | --- | --- | --- | --- |
| `h1` | 32 px | 40 px | 43.00 | 43.00 |
| `#p1` | 16 px | 24 px | 21.00 | 21.00 |
| `#p2` | 14 px | **14 px** | **19.00** | 19.00 |
| `#p3` | 18 px | 45 px | 24.00 | 24.00 |

`rect.height == ascent + descent` in every case, and is **independent of
line-height** — note `#p2`, where the rect (19px) is *taller* than its own
line box (14px) and overflows it. So `rect.top` is the top of the font box,
which puts the baseline exactly one ascent below it, by construction.

Two consequences worth stating explicitly:

- Half-leading never has to be computed. Line-height, vertical centering
  within the line box, and strut behaviour are all already baked into
  `rect.top`. We are not re-deriving them — we are reading Chromium's answer.
- The ascent must come from `fontBoundingBoxAscent` (the font's own metric),
  **not** `actualBoundingBoxAscent` (the sample's inked extent). Scored on
  the same data, the actual-ink variant is wrong by 5.4 px mean / 13.8 px max.

### It survives per-glyph font fallback

The predicted failure mode was: canvas resolves a font-*family list* to metrics,
so if Chromium shapes text with a fallback font while canvas resolves the
primary, the ascent desyncs.

Tested directly with `font-family: "Arab","Serif"` on Latin text, where the
first family has no Latin coverage at all:

```
ascent("Sans")         = 21
ascent("Serif")        = 18
ascent("Arab")         = 27
ascent("Arab","Serif") = 27   ← canvas returns the PRIMARY family's ascent
```

Canvas does return the primary family's metric (27, not 18). But the baseline
error on that paragraph was still only 0.484 px — the same drift seen on
paragraphs with no fallback at all. **Chromium positions the inline box from
the primary resolved font's metrics too, even when the glyphs come from a
fallback font.** The two stay consistent, so the mechanism holds. This was the
weakest link in the design and it survived.

---

## 4. Anomalies, each traced to a cause

Three deviations appeared. All three are explained; none is a blocker.

### 4.1 `Δleft = −3.961 px` — leading whitespace *(fixed)*

Runs following an inline span were shifted left by exactly one space advance
(measured space = 3.9609 px; observed offset = 3.9531 px). Our run included a
leading collapsed space that Chromium's glyph run excludes.

Fixed in `src/capture/textRuns.js` by trimming fragment edges before taking the
rect. Left-edge error dropped from 3.96 px to 0.0078 px.

### 4.2 `Δbaseline = −0.484 px` — screen/print layout drift *(inherent, benign)*

Two paragraphs sat 0.484 px off. `0.484375 = 31/64` — exactly 31 LayoutUnits
(Chromium's 1/64 px fixed-point grid). Screen layout had `#c` at
`83.515625 px` (= 83 + 33/64); print layout placed it at `84.0`.

**Chromium's print layout is not bit-identical to its screen layout.** There is
sub-pixel drift up to ~0.5 px between the two.

This does not affect the architecture: we generate our PDF *from the screen
layout*, so our output is self-consistent. It only sets a floor on how exactly
we can ever match `printToPDF`, and 0.5 px is far below visible.

### 4.3 Arabic did not match the harness — *a verifier artifact, not a Chromium defect*

> ### ⚠ CORRECTED — see findings 05
>
> **This section originally concluded that Chromium's own PDF loses Arabic
> text, and that a client-side renderer could therefore be "strictly better"
> than Chrome. That conclusion was wrong.** It rested entirely on pdf.js, the
> only extractor this harness used. Poppler's `pdftotext` recovers the correct
> source Unicode from exactly the same Chromium PDF:
>
> ```
> $ pdftotext gate1-stress-chromium.pdf -
> ‫ قبل‬ASCII ‫بعد‬          ← correct, logical order
> ```
>
> The presentation-form output below is what **pdf.js** reports, not what the
> PDF contains for a competent extractor. Chromium's Arabic export is fine.
>
> The methodological error — trusting a single extractor as ground truth — is
> the real finding here, and is written up in findings 05.

The Arabic runs matched no reference text item *in this harness*. Inspecting the
reference PDF **through pdf.js**:

```
source:              U+0645 U+0631 U+062D U+0628 U+0627 ...   (مرحبا)
pdf.js reports:      U+FEF2 U+FE91 U+FEAE U+FECB ...          (presentation forms)
poppler reports:     the original codepoints, in logical order
```

So the matching failure was a property of the verifier. What remains true and
useful: **text-extraction claims must be checked against more than one
extractor**, because pdf.js and poppler disagree about real PDFs in ways that
change conclusions. Findings 05 re-runs the round-trip test against both.

---

## 5. Advance widths: the one real gap, and its fix

The first POC drew each line as a single string and let the PDF font's own
advances position the glyphs. Width error was 7.38 pt mean / **33.75 pt max**,
concentrated entirely on the `letter-spacing`+`word-spacing` paragraph.

Two distinct problems:

- **letter-spacing** maps cleanly onto PDF's `Tc` operator.
- **word-spacing** does **not**. PDF's `Tw` applies only to single-byte
  code 32, which an embedded CID/Type0 font never emits. `Tw` is unusable for
  any subset-embedded font.

The fix generalises past both, and is the more important architectural point:

> **Position each word at its browser-measured x, rather than trusting the PDF
> font's advances to reproduce it.**

Width error fell to 0.053 pt mean / 0.305 pt max, with the letter-spaced runs
at exactly 0.00 pt. This makes an entire class of divergence — kerning
differences, shaping differences, justification, `word-spacing`, `text-indent`
— structurally impossible rather than merely handled. The extractor already
collects per-character rects, so word origins are free.

The same trick extends to per-glyph positioning if a case ever needs it, at the
cost of PDF size.

---

## 6. What the stress fixture says

`fixtures/gate1-stress.html` adds mixed fonts, baseline shifts, nested inlines
crossing a wrap, RTL, bidi, and a fallback trap.

| Case | Baseline error | Verdict |
| --- | --- | --- |
| Mixed fonts/sizes in one line box (serif span, 28px span) | **0.000 px** | Works |
| `<sub>` / `<sup>` baseline shifts | **0.000 px** | Works — `vertical-align` comes free via the rect |
| Nested `<strong><em>` crossing a line boundary | 0.484 px | Works (drift only, §4.2) |
| Font-list fallback on Latin | 0.484 px | Works (§3) |
| RTL / bidi | — | Not yet answerable (§7) |

Mixed fonts and sub/sup both landing at exactly 0.000 px matters: it confirms
the per-text-node approach handles inline style changes without any special
casing, because each text node carries its own parent's computed font.

### POC limitations (not architectural findings)

The POC embeds exactly **one** font (Roboto). On the stress fixture:

- 151 of 219 chars round-trip exactly; the Arabic becomes `U+0000` (.notdef),
  because Roboto has no Arabic coverage.
- The serif and fallback runs are drawn in Roboto, so their widths are wrong
  (4.4 pt on one run).

This is the plan's `PDF_FONT_UNAVAILABLE` case (§16) — but it failed
**silently**. A font registry that errors loudly on missing coverage is
therefore a correctness requirement, not a nicety. It is the first thing to
build next.

---

## 7. Cost

Extraction is per-character `Range` probing — the O(n) correctness baseline.

| fixture | chars probed | extract time |
| --- | --- | --- |
| `gate1-text` | 451 | 4.5 ms |
| `gate1-stress` | 262 | 2.6 ms |

~100k chars/second. A 50-page document is order 100k characters, so this is
roughly 1 s of probing — acceptable for now, and the obvious optimisation
(binary-search line boundaries, probe per-character only within a line) is
available without changing the model.

---

## 8. Gate status

| Gate | Question | Status |
| --- | --- | --- |
| **1 — Text geometry** | Can we recover browser line/inline positioning? | **PASS.** Exact, with a proven mechanism and a known 0.5 px screen/print floor. |
| **2 — Text shaping** | Can we reproduce glyph output? | **Partly, and largely sidestepped.** Browser-measured word positions remove the need to match Chromium's advances. Complex-script *glyph selection* (Arabic) is untested — but §4.3 lowers the bar it must clear. |
| **5 — PDF backend** | Native text, embedded fonts, searchable? | **PASS for text.** pdf-lib + fontkit produced a 7.7 KB PDF with a subset embedded font, exact text round-trip, and 0.000 px placement. Vectors, images and links still untested. |

Nothing found so far belongs in the plan's category E (genuinely blocking).
The two hard problems the plan flagged for text — baselines and advances — both
turned out to have exact solutions rather than approximations.

---

## 9. Next

1. **Font registry with loud diagnostics** — the silent `.notdef` in §6 is the
   most dangerous behaviour observed. Multi-font embedding, coverage checks,
   `missingFont: "error"` as the default.
2. **RTL / complex script**, once multi-font embedding exists. *(Done —
   findings 05. Note the "beat Chromium's presentation-form output" motivation
   originally written here was based on the mistaken §4.3 conclusion.)*
3. **Gate 3 — boxes and paint order**: backgrounds, borders, radii, stacking.
   The geometry half is already proven; this tests reconstruction, not
   observation.
4. **Gate 4 — pagination**, the largest remaining unknown and the one most
   likely to force real algorithm work.

---

## Appendix — reproducing

```
npm install
node experiments/gate1-baselines.js gate1-text
node experiments/gate1-baselines.js gate1-stress
node experiments/poc-render.js gate1-text
node experiments/probe-anomalies.js

cd out
pdftoppm -r 150 -png gate1-text-ours.pdf ours
pdftoppm -r 150 -png gate1-text-chromium.pdf chrome
python3 ../experiments/pngdiff.py ours-1.png chrome-1.png diff.png
```

Fonts (`fixtures/*.ttf`) are fetched libre faces: Roboto Regular, Tinos
Regular, Noto Sans Arabic Regular.
