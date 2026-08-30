# Garri vs Chromium — Kami demo documents

Every fixture in this repository was written by us, to probe one mechanism at
a time. These ten are not: they are the demo documents from
[tw93/Kami](https://github.com/tw93/Kami/tree/main/assets/demos), written by
someone else for their own tool. They are the first test of whether any of
this survives a document we did not design.

For each demo, the same page in the same browser produces two PDFs —
Chromium's own `printToPDF` and Garri's — which are then rasterised at 110 dpi
and compared pixel by pixel. The diff images mark **red where only Chromium
put ink** and **blue where only Garri did**.

Reproduce with `node experiments/kami-compare.js && node experiments/kami-report.js`.

## Summary

| Demo | Chromium | Garri | Pages | Worst page diff | Garri time | Size |
| --- | ---: | ---: | :---: | ---: | ---: | ---: |
| [demo-agent-slides](https://github.com/tw93/Kami/blob/main/assets/demos/demo-agent-slides.html) | 8 | 8 | ✅ | 5.13 % | 158 ms | 85 KB |
| [demo-changelog](https://github.com/tw93/Kami/blob/main/assets/demos/demo-changelog.html) | 1 | 1 | ✅ | 6.05 % | 91 ms | 71 KB |
| [demo-kaku](https://github.com/tw93/Kami/blob/main/assets/demos/demo-kaku.html) | 8 | 8 | ✅ | 7.71 % | 389 ms | 175 KB |
| [demo-kami-print](https://github.com/tw93/Kami/blob/main/assets/demos/demo-kami-print.html) | 1 | 1 | ✅ | 5.61 % | 229 ms | 96 KB |
| [demo-letter](https://github.com/tw93/Kami/blob/main/assets/demos/demo-letter.html) | 1 | 1 | ✅ | 4.33 % | 257 ms | 78 KB |
| [demo-mole](https://github.com/tw93/Kami/blob/main/assets/demos/demo-mole.html) | 1 | 1 | ✅ | 16.74 % | 47 ms | 159 KB |
| [demo-musk-resume](https://github.com/tw93/Kami/blob/main/assets/demos/demo-musk-resume.html) | 2 | 2 | ✅ | 8.57 % | 79 ms | 37 KB |
| [demo-resume-ko](https://github.com/tw93/Kami/blob/main/assets/demos/demo-resume-ko.html) | 2 | 2 | ✅ | 8.33 % | 358 ms | 242 KB |
| [demo-tesla](https://github.com/tw93/Kami/blob/main/assets/demos/demo-tesla.html) | 2 | 2 | ✅ | 3.75 % | 339 ms | 161 KB |
| [demo-waza](https://github.com/tw93/Kami/blob/main/assets/demos/demo-waza.html) | 1 | 1 | ✅ | 6.69 % | 90 ms | 73 KB |

**10 of 10** demos paginate to exactly the same page count as
Chromium. Worst single page difference across all of them: **16.74 %**; median **4.38 %**.

## What this exercise found

Running against documents we did not write surfaced four defects that every
synthetic fixture had missed. Three are fixed; the fourth is inherent.

**Fragmentation was defeated by `max-width`.** Real documents routinely carry
`@media screen { body { max-width: 210mm; padding: 25mm } }`. Garri reads the
*screen* layout, so that clamped the container it widens to fragment: it stayed
794px instead of the 14,536px asked for, making the derived column pitch **33px
instead of 606px**. Every line landed in a different column — `demo-resume-ko`
came out as 43 pages against Chromium's 2, `demo-mole` 20 against 1. The
container is being repurposed, so its author box constraints are now
neutralised, and `PDF_CONTAINER_CLAMPED` fires if anything still clamps it.

**WOFF2 hung the renderer forever.** pdf-lib's subsetter never returns on a
WOFF2 face — not slowly, permanently. Subsetting is Garri's default and WOFF2 is
what most sites serve, so this would have hung on the majority of real
documents. It was invisible to every fixture here because they all use a TTF.
Compressed faces are now embedded whole, with `PDF_FONT_NOT_SUBSET` naming the
size cost.

**One CJK character killed the whole document.** When a font has no embeddable
bytes Garri substitutes a standard PDF font, and those are WinAnsi-only, so
pdf-lib *throws* rather than dropping the glyph. `demo-tesla` failed entirely on
a single `特`. Unencodable text is now skipped with `PDF_TEXT_NOT_ENCODABLE`.

**`@page { size: A4 }` was not understood.** The size parser only handled the
explicit `210mm 297mm` form. Not one of these ten documents uses it — every one
says `size: A4` — so every one silently fell back to a guessed default.
`demo-agent-slides` is `A4 landscape` and was rendered portrait; `margin: 0`
parsed as nothing and became a 20mm margin. The parser now handles the named
sizes from css-page-3, `landscape`/`portrait`, every absolute unit, and the
1-to-4 value margin shorthand including a unitless zero.

**One column height cannot express two page geometries.** `demo-kaku` has a
`.cover` exactly 297mm tall that fits page one only because
`@page:first { margin: 0 }` removes the margins. A multicolumn container has a
single column height, so fragmenting the run at the typical page height split
the cover in two and made the document a page longer; fragmenting it all at the
first page's height made every column 8.7% taller and lost a page instead.
Neither is a rounding error — they are the same structural limit from opposite
sides. The first page is now fragmented in its own pass when its geometry
differs and its content ends on a clean element boundary; when it does not,
`PDF_FIRST_PAGE_GEOMETRY_UNUSED` says so rather than quietly being off by one.

**Same characters, different order.** Several demos extract the same character
count as Chromium but not the same sequence — Garri emits paint, then flow, then
furniture, while Chromium interleaves in document order. The content is all
there; the reading order a copy-paste produces can differ.

---

## demo-agent-slides

[Source HTML](https://github.com/tw93/Kami/blob/main/assets/demos/demo-agent-slides.html) · [local copy](demos/demo-agent-slides.html) · [Chromium PDF](out/demo-agent-slides-chromium.pdf) · [Garri PDF](out/demo-agent-slides-garri.pdf)

**Uses:** `@font-face` · `@page` · SVG · grid · flex · positioned · break-* · counters

| | Chromium | Garri | Diff |
| --- | --- | --- | --- |
| **p1**<br>2.08 % | <img src="out/demo-agent-slides-p1-chromium-1.png" width="240"> | <img src="out/demo-agent-slides-p1-garri-1.png" width="240"> | <img src="out/demo-agent-slides-p1-diff.png" width="240"> |
| **p2**<br>4.38 % | <img src="out/demo-agent-slides-p2-chromium-2.png" width="240"> | <img src="out/demo-agent-slides-p2-garri-2.png" width="240"> | <img src="out/demo-agent-slides-p2-diff.png" width="240"> |
| **p3**<br>1.64 % | <img src="out/demo-agent-slides-p3-chromium-3.png" width="240"> | <img src="out/demo-agent-slides-p3-garri-3.png" width="240"> | <img src="out/demo-agent-slides-p3-diff.png" width="240"> |
| **p4**<br>4.09 % | <img src="out/demo-agent-slides-p4-chromium-4.png" width="240"> | <img src="out/demo-agent-slides-p4-garri-4.png" width="240"> | <img src="out/demo-agent-slides-p4-diff.png" width="240"> |
| **p5**<br>3.56 % | <img src="out/demo-agent-slides-p5-chromium-5.png" width="240"> | <img src="out/demo-agent-slides-p5-garri-5.png" width="240"> | <img src="out/demo-agent-slides-p5-diff.png" width="240"> |
| **p6**<br>5.13 % | <img src="out/demo-agent-slides-p6-chromium-6.png" width="240"> | <img src="out/demo-agent-slides-p6-garri-6.png" width="240"> | <img src="out/demo-agent-slides-p6-diff.png" width="240"> |
| **p7**<br>3.31 % | <img src="out/demo-agent-slides-p7-chromium-7.png" width="240"> | <img src="out/demo-agent-slides-p7-garri-7.png" width="240"> | <img src="out/demo-agent-slides-p7-diff.png" width="240"> |
| **p8**<br>2.35 % | <img src="out/demo-agent-slides-p8-chromium-8.png" width="240"> | <img src="out/demo-agent-slides-p8-garri-8.png" width="240"> | <img src="out/demo-agent-slides-p8-diff.png" width="240"> |

**Emitted:** backgrounds 10 · borders 2 · svg 38 · clips 69 · dashedSides 1

**Text extraction:** 0/8 pages character-exact (Chromium 3000 chars, Garri 2965)

<details><summary>Diagnostics</summary>

- `PDF_FONT_NOT_SUBSET` — "jetbrains mono" is WOFF2, whose compressed tables hang the subsetter, so the whole face is embedded. The PDF is larger than it needs to be — supply a TTF or OTF for that family to get subsetting back.
- `PDF_FONT_SUBSTITUTED` ×43 — no embeddable bytes for "Charter, Georgia, Palatino, serif" 500 normal — substituted the standard font Times-Roman. Word positions still come from the browser's own measurements; only glyph shapes differ. Declare an @font-face to embed the real font.
- `PDF_FONT_SUBSTITUTED` ×69 — no embeddable bytes for "Charter, Georgia, Palatino, serif" 400 normal — substituted the standard font Times-Roman. Word positions still come from the browser's own measurements; only glyph shapes differ. Declare an @font-face to embed the real font.
- `PDF_FONT_SUBSTITUTED` ×11 — no embeddable bytes for "Charter, Georgia, TsangerJinKai02, "Source Han Serif SC", "Noto Serif CJK SC", serif" 500 normal — substituted the standard font Times-Roman. Word positions still come from the browser's own measurements; only glyph shapes differ. Declare an @font-face to embed the real font.
- `PDF_FONT_SUBSTITUTED` ×22 — no embeddable bytes for "Charter, Georgia, TsangerJinKai02, "Source Han Serif SC", "Noto Serif CJK SC", serif" 400 normal — substituted the standard font Times-Roman. Word positions still come from the browser's own measurements; only glyph shapes differ. Declare an @font-face to embed the real font.
- `PDF_TEXT_NOT_ENCODABLE` — "Charter, Georgia, Palatino, serif" had no embeddable bytes, and the substituted standard font cannot encode "–". That text is omitted. Declare an @font-face with a font that covers this script.

</details>

---

## demo-changelog

[Source HTML](https://github.com/tw93/Kami/blob/main/assets/demos/demo-changelog.html) · [local copy](demos/demo-changelog.html) · [Chromium PDF](out/demo-changelog-chromium.pdf) · [Garri PDF](out/demo-changelog-garri.pdf)

**Uses:** `@font-face` · `@page` · flex · break-* · CJK

| | Chromium | Garri | Diff |
| --- | --- | --- | --- |
| **p1**<br>6.05 % | <img src="out/demo-changelog-p1-chromium-1.png" width="240"> | <img src="out/demo-changelog-p1-garri-01.png" width="240"> | <img src="out/demo-changelog-p1-diff.png" width="240"> |

**Emitted:** borders 2 · dashedSides 1

**Text extraction:** 0/1 pages character-exact (Chromium 1643 chars, Garri 1590)

<details><summary>Diagnostics</summary>

- `PDF_FONT_SUBSTITUTED` ×19 — no embeddable bytes for "Charter, Georgia, Palatino, "Times New Roman", serif" 500 normal — substituted the standard font Times-Roman. Word positions still come from the browser's own measurements; only glyph shapes differ. Declare an @font-face to embed the real font.
- `PDF_FONT_SUBSTITUTED` ×31 — no embeddable bytes for "Charter, Georgia, Palatino, "Times New Roman", serif" 400 normal — substituted the standard font Times-Roman. Word positions still come from the browser's own measurements; only glyph shapes differ. Declare an @font-face to embed the real font.
- `PDF_FONT_NOT_SUBSET` — "jetbrains mono" is WOFF2, whose compressed tables hang the subsetter, so the whole face is embedded. The PDF is larger than it needs to be — supply a TTF or OTF for that family to get subsetting back.
- `PDF_TEXT_NOT_ENCODABLE` — "Charter, Georgia, Palatino, "Times New Roman", serif" had no embeddable bytes, and the substituted standard font cannot encode "鼴". That text is omitted. Declare an @font-face with a font that covers this script.

</details>

---

## demo-kaku

[Source HTML](https://github.com/tw93/Kami/blob/main/assets/demos/demo-kaku.html) · [local copy](demos/demo-kaku.html) · [Chromium PDF](out/demo-kaku-chromium.pdf) · [Garri PDF](out/demo-kaku-garri.pdf)

**Uses:** `@font-face` · `@page` · images · grid · flex · tables · break-* · CJK

| | Chromium | Garri | Diff |
| --- | --- | --- | --- |
| **p1**<br>2.73 % | <img src="out/demo-kaku-p1-chromium-1.png" width="240"> | <img src="out/demo-kaku-p1-garri-01.png" width="240"> | <img src="out/demo-kaku-p1-diff.png" width="240"> |
| **p2**<br>3.94 % | <img src="out/demo-kaku-p2-chromium-2.png" width="240"> | <img src="out/demo-kaku-p2-garri-02.png" width="240"> | <img src="out/demo-kaku-p2-diff.png" width="240"> |
| **p3**<br>7.71 % | <img src="out/demo-kaku-p3-chromium-3.png" width="240"> | <img src="out/demo-kaku-p3-garri-03.png" width="240"> | <img src="out/demo-kaku-p3-diff.png" width="240"> |
| **p4**<br>7.03 % | <img src="out/demo-kaku-p4-chromium-4.png" width="240"> | <img src="out/demo-kaku-p4-garri-04.png" width="240"> | <img src="out/demo-kaku-p4-diff.png" width="240"> |
| **p5**<br>4.45 % | <img src="out/demo-kaku-p5-chromium-5.png" width="240"> | <img src="out/demo-kaku-p5-garri-05.png" width="240"> | <img src="out/demo-kaku-p5-diff.png" width="240"> |
| **p6**<br>7.53 % | <img src="out/demo-kaku-p6-chromium-6.png" width="240"> | <img src="out/demo-kaku-p6-garri-06.png" width="240"> | <img src="out/demo-kaku-p6-diff.png" width="240"> |
| **p7**<br>0.48 % | <img src="out/demo-kaku-p7-chromium-7.png" width="240"> | <img src="out/demo-kaku-p7-garri-07.png" width="240"> | <img src="out/demo-kaku-p7-diff.png" width="240"> |
| **p8**<br>3.76 % | <img src="out/demo-kaku-p8-chromium-8.png" width="240"> | <img src="out/demo-kaku-p8-garri-08.png" width="240"> | <img src="out/demo-kaku-p8-diff.png" width="240"> |

**Emitted:** backgrounds 28 · borders 69 · links 4 · clips 2

**Text extraction:** 0/8 pages character-exact (Chromium 3942 chars, Garri 3878)

<details><summary>Diagnostics</summary>

- `PDF_RESOURCE_INACCESSIBLE` — could not read image bytes for kaku-hero.jpg: The source image cannot be decoded.. The browser may still display it; a PDF needs the bytes.
- `PDF_RESOURCE_INACCESSIBLE` — could not read image bytes for kaku-action.jpg: The source image cannot be decoded.. The browser may still display it; a PDF needs the bytes.

</details>

---

## demo-kami-print

[Source HTML](https://github.com/tw93/Kami/blob/main/assets/demos/demo-kami-print.html) · [local copy](demos/demo-kami-print.html) · [Chromium PDF](out/demo-kami-print-chromium.pdf) · [Garri PDF](out/demo-kami-print-garri.pdf)

**Uses:** `@font-face` · `@page` · grid · flex · break-* · CJK

| | Chromium | Garri | Diff |
| --- | --- | --- | --- |
| **p1**<br>5.61 % | <img src="out/demo-kami-print-p1-chromium-1.png" width="240"> | <img src="out/demo-kami-print-p1-garri-01.png" width="240"> | <img src="out/demo-kami-print-p1-diff.png" width="240"> |

**Emitted:** backgrounds 1 · borders 3 · dashedSides 2

**Text extraction:** 1/1 pages character-exact (Chromium 790 chars, Garri 790)

---

## demo-letter

[Source HTML](https://github.com/tw93/Kami/blob/main/assets/demos/demo-letter.html) · [local copy](demos/demo-letter.html) · [Chromium PDF](out/demo-letter-chromium.pdf) · [Garri PDF](out/demo-letter-garri.pdf)

**Uses:** `@font-face` · `@page` · CJK

| | Chromium | Garri | Diff |
| --- | --- | --- | --- |
| **p1**<br>4.33 % | <img src="out/demo-letter-p1-chromium-1.png" width="240"> | <img src="out/demo-letter-p1-garri-01.png" width="240"> | <img src="out/demo-letter-p1-diff.png" width="240"> |

**Emitted:** borders 1 · links 1 · dashedSides 1

**Text extraction:** 1/1 pages character-exact (Chromium 437 chars, Garri 437)

---

## demo-mole

[Source HTML](https://github.com/tw93/Kami/blob/main/assets/demos/demo-mole.html) · [local copy](demos/demo-mole.html) · [Chromium PDF](out/demo-mole-chromium.pdf) · [Garri PDF](out/demo-mole-garri.pdf)

**Uses:** `@font-face` · `@page` · images · `box-shadow` · grid · flex · break-*

| | Chromium | Garri | Diff |
| --- | --- | --- | --- |
| **p1**<br>16.74 % | <img src="out/demo-mole-p1-chromium-1.png" width="240"> | <img src="out/demo-mole-p1-garri-01.png" width="240"> | <img src="out/demo-mole-p1-diff.png" width="240"> |

**Emitted:** borders 3 · images 1 · clips 1 · dashedSides 2

**Text extraction:** 0/1 pages character-exact (Chromium 931 chars, Garri 931)

<details><summary>Diagnostics</summary>

- `PDF_FONT_SUBSTITUTED` ×17 — no embeddable bytes for "Charter, Georgia, Palatino, "Times New Roman", serif" 500 normal — substituted the standard font Times-Roman. Word positions still come from the browser's own measurements; only glyph shapes differ. Declare an @font-face to embed the real font.
- `PDF_FONT_SUBSTITUTED` ×29 — no embeddable bytes for "Charter, Georgia, Palatino, "Times New Roman", serif" 400 normal — substituted the standard font Times-Roman. Word positions still come from the browser's own measurements; only glyph shapes differ. Declare an @font-face to embed the real font.

</details>

---

## demo-musk-resume

[Source HTML](https://github.com/tw93/Kami/blob/main/assets/demos/demo-musk-resume.html) · [local copy](demos/demo-musk-resume.html) · [Chromium PDF](out/demo-musk-resume-chromium.pdf) · [Garri PDF](out/demo-musk-resume-garri.pdf)

**Uses:** `@font-face` · `@page` · grid · flex · break-*

| | Chromium | Garri | Diff |
| --- | --- | --- | --- |
| **p1**<br>8.57 % | <img src="out/demo-musk-resume-p1-chromium-1.png" width="240"> | <img src="out/demo-musk-resume-p1-garri-1.png" width="240"> | <img src="out/demo-musk-resume-p1-diff.png" width="240"> |
| **p2**<br>6.52 % | <img src="out/demo-musk-resume-p2-chromium-2.png" width="240"> | <img src="out/demo-musk-resume-p2-garri-2.png" width="240"> | <img src="out/demo-musk-resume-p2-diff.png" width="240"> |

**Emitted:** backgrounds 5 · borders 18 · links 7 · dashedSides 10

**Text extraction:** 0/2 pages character-exact (Chromium 4766 chars, Garri 4766)

<details><summary>Diagnostics</summary>

- `PDF_FONT_SUBSTITUTED` ×76 — no embeddable bytes for "Charter, Georgia, Palatino, "Times New Roman", serif" 500 normal — substituted the standard font Times-Roman. Word positions still come from the browser's own measurements; only glyph shapes differ. Declare an @font-face to embed the real font.
- `PDF_FONT_SUBSTITUTED` ×116 — no embeddable bytes for "Charter, Georgia, Palatino, "Times New Roman", serif" 400 normal — substituted the standard font Times-Roman. Word positions still come from the browser's own measurements; only glyph shapes differ. Declare an @font-face to embed the real font.

</details>

---

## demo-resume-ko

[Source HTML](https://github.com/tw93/Kami/blob/main/assets/demos/demo-resume-ko.html) · [local copy](demos/demo-resume-ko.html) · [Chromium PDF](out/demo-resume-ko-chromium.pdf) · [Garri PDF](out/demo-resume-ko-garri.pdf)

**Uses:** `@font-face` · `@page` · grid · flex · break-* · CJK

| | Chromium | Garri | Diff |
| --- | --- | --- | --- |
| **p1**<br>8.33 % | <img src="out/demo-resume-ko-p1-chromium-1.png" width="240"> | <img src="out/demo-resume-ko-p1-garri-01.png" width="240"> | <img src="out/demo-resume-ko-p1-diff.png" width="240"> |
| **p2**<br>5.89 % | <img src="out/demo-resume-ko-p2-chromium-2.png" width="240"> | <img src="out/demo-resume-ko-p2-garri-02.png" width="240"> | <img src="out/demo-resume-ko-p2-diff.png" width="240"> |

**Emitted:** backgrounds 6 · borders 20 · links 11 · dashedSides 12

**Text extraction:** 2/2 pages character-exact (Chromium 2351 chars, Garri 2351)

---

## demo-tesla

[Source HTML](https://github.com/tw93/Kami/blob/main/assets/demos/demo-tesla.html) · [local copy](demos/demo-tesla.html) · [Chromium PDF](out/demo-tesla-chromium.pdf) · [Garri PDF](out/demo-tesla-garri.pdf)

**Uses:** `@font-face` · `@page` · SVG · grid · flex · tables · break-* · counters · CJK

| | Chromium | Garri | Diff |
| --- | --- | --- | --- |
| **p1**<br>2.52 % | <img src="out/demo-tesla-p1-chromium-1.png" width="240"> | <img src="out/demo-tesla-p1-garri-1.png" width="240"> | <img src="out/demo-tesla-p1-diff.png" width="240"> |
| **p2**<br>3.75 % | <img src="out/demo-tesla-p2-chromium-2.png" width="240"> | <img src="out/demo-tesla-p2-garri-2.png" width="240"> | <img src="out/demo-tesla-p2-diff.png" width="240"> |

**Emitted:** backgrounds 6 · borders 65 · svg 53 · clips 40 · dashedSides 3

**Text extraction:** 1/2 pages character-exact (Chromium 1993 chars, Garri 2022)

<details><summary>Diagnostics</summary>

- `PDF_FONT_SUBSTITUTED` ×16 — no embeddable bytes for "Charter, Georgia, serif" 400 normal — substituted the standard font Times-Roman. Word positions still come from the browser's own measurements; only glyph shapes differ. Declare an @font-face to embed the real font.
- `PDF_FONT_SUBSTITUTED` — no embeddable bytes for "Charter, Georgia, serif" 500 normal — substituted the standard font Times-Roman. Word positions still come from the browser's own measurements; only glyph shapes differ. Declare an @font-face to embed the real font.

</details>

---

## demo-waza

[Source HTML](https://github.com/tw93/Kami/blob/main/assets/demos/demo-waza.html) · [local copy](demos/demo-waza.html) · [Chromium PDF](out/demo-waza-chromium.pdf) · [Garri PDF](out/demo-waza-garri.pdf)

**Uses:** `@font-face` · `@page` · SVG · images · `box-shadow` · grid · flex · break-* · CJK

| | Chromium | Garri | Diff |
| --- | --- | --- | --- |
| **p1**<br>6.69 % | <img src="out/demo-waza-p1-chromium-1.png" width="240"> | <img src="out/demo-waza-p1-garri-01.png" width="240"> | <img src="out/demo-waza-p1-diff.png" width="240"> |

**Emitted:** borders 3 · svg 5 · clips 12 · dashedSides 2

**Text extraction:** 0/1 pages character-exact (Chromium 1505 chars, Garri 1486)

<details><summary>Diagnostics</summary>

- `PDF_FONT_SUBSTITUTED` ×14 — no embeddable bytes for "Charter, Georgia, Palatino, "Times New Roman", serif" 500 normal — substituted the standard font Times-Roman. Word positions still come from the browser's own measurements; only glyph shapes differ. Declare an @font-face to embed the real font.
- `PDF_TEXT_NOT_ENCODABLE` — "Charter, Georgia, Palatino, "Times New Roman", serif" had no embeddable bytes, and the substituted standard font cannot encode "技". That text is omitted. Declare an @font-face with a font that covers this script.
- `PDF_FONT_SUBSTITUTED` ×32 — no embeddable bytes for "Charter, Georgia, Palatino, "Times New Roman", serif" 400 normal — substituted the standard font Times-Roman. Word positions still come from the browser's own measurements; only glyph shapes differ. Declare an @font-face to embed the real font.
- `PDF_FONT_SUBSTITUTED` ×8 — no embeddable bytes for "Charter, Georgia, Palatino, "Times New Roman", serif" 700 normal — substituted the standard font Times-Bold. Word positions still come from the browser's own measurements; only glyph shapes differ. Declare an @font-face to embed the real font.
- `PDF_FONT_NOT_SUBSET` — "jetbrains mono" is WOFF2, whose compressed tables hang the subsetter, so the whole face is embedded. The PDF is larger than it needs to be — supply a TTF or OTF for that family to get subsetting back.
- `PDF_FONT_SUBSTITUTED` ×3 — no embeddable bytes for "TsangerJinKai02, "Source Han Serif SC", "Songti SC", Charter, Georgia, serif" 500 normal — substituted the standard font Times-Roman. Word positions still come from the browser's own measurements; only glyph shapes differ. Declare an @font-face to embed the real font.
- `PDF_FONT_SUBSTITUTED` ×3 — no embeddable bytes for "TsangerJinKai02, "Source Han Serif SC", "Songti SC", Charter, Georgia, serif" 400 normal — substituted the standard font Times-Roman. Word positions still come from the browser's own measurements; only glyph shapes differ. Declare an @font-face to embed the real font.

</details>

---
