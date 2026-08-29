# Evidence classes — a documentary pass over findings 01–16

**Date:** 2026-08-29 · all sources fetched live on this date
**Purpose:** replace an unrunnable cross-platform matrix with a stronger claim about *why* each finding holds

---

## Why this exists instead of a platform matrix

This machine is macOS arm64. Linux needs a container runtime that isn't
installed; Windows is unreachable entirely. A three-platform matrix was
proposed and then rejected, for a reason better than the constraint:

**For an invariance claim, source evidence dominates sampling.** Running on
three platforms yields three data points and no mechanism. Reading the source
tells you whether the thing is a compile-time constant — which settles *every*
platform at once, including ones that don't exist yet.

There is also a design fact that shrinks the question. Our ground truth is
**differential, not golden**: every finding compares our output against
`Page.printToPDF` from the *same* Chromium, in the same process. No golden file
from another machine exists to disagree with. And in production the pipeline
extracts from the very browser that would otherwise print the page. So a
platform difference that moves Chromium's layout and our extraction *together*
is common-mode — invisible to the test, and harmless.

The target was never "the same PDF on every platform." It is "a PDF that
matches the browser that produced it."

---

## The classes

| Class | Meaning | Portability |
| --- | --- | --- |
| **S** | Confirmed in Chromium/Blink source | Invariance provable from the code |
| **W** | Mandated by a web standard | Any conformant engine |
| **M** | Measured here, differentially against co-located Chromium | This build; mechanism unproven |
| **U** | Unverified beyond this machine | Genuinely open |

`S` and `W` are not "better" than `M` — they answer a *different* question.
`M` proves our implementation agrees with Chromium. `S`/`W` prove the thing
we're agreeing with is stable. A claim wants both.

---

## The ledger

| # | Claim | Was | Now | Source |
| --- | --- | --- | --- | --- |
| 02 | Multicolumn fragmentation = page fragmentation | M | **W** | css-break-3 §fragmentainer |
| 01 | baseline = font-box top + ascent | M | **S + M** | `text_metrics.cc` |
| 03 | ~0.5 px screen/print drift is 31/64 LayoutUnit | M | **S** | `layout_unit.h` |
| 14 | `page` is not inherited | M | **W** | css-page-3 |
| 15 | `@page :blank` is dropped | M | **S + W** | `css_selector.cc` |
| 15 | `break-before: <page-name>` computes to `auto` | "Chromium limit" | **W — not a limit** | css-break-3 |
| 04 | Corner radii scale by one factor, not per-corner | M | **W** | css-backgrounds-3 §4.5 |
| 12 | Margin boxes default to 16 px serif | M | **W (optional branch)** | css-page-3 |
| 08 | `shadowBlur` ignores the canvas CTM | M | **W + M** | MDN / measured |
| 03 | A4 page box emitted as 594.96 × 841.92 pt | M | **U** (spot-checked, findings 17) | — |
| 10 | Dash constant, gap stretches | M | **U** (spot-checked, findings 17) | — |
| 09 | Bullet placement is not linear in em | M | **U** (spot-checked, findings 17) | — |
| 05 | Devanagari extraction order | M | **U** | — |
| 07 | WebP re-encode inflates 4.8× | M | **U** | — |
| 16 | Scale: linear, 22.7 ms/page | M | **U** (machine-specific by nature) | — |

---

## What changed, in detail

### 1. The core thesis is spec-mandated, not a lucky trick

Findings 02 justified the multicolumn oracle empirically: *set
`column-fill: auto`, make the column height the page content height, and
Chromium fragments the same way it would for pages.* That read as a clever
exploit of an implementation coincidence.

It isn't. [css-break-3](https://drafts.csswg.org/css-break-3/) defines one
fragmentation model for both:

> "fragmentation container (fragmentainer): A box—such as a page box, column
> box, or region—that contains a portion (or all) of a fragmented flow."

> "The generic term for breaking content across containers is fragmentation.
> This module explains how content breaks across fragmentation containers
> (fragmentainers) such as pages and columns..."

Page boxes and column boxes are *the same kind of object* under the same rules.
The oracle isn't borrowing an unrelated mechanism — it is asking the
fragmentation engine the question it already answers. **This is the single most
load-bearing upgrade in this pass**: the architecture's central bet moves from
"observed to work in Chromium 152" to "required of any conformant engine."

### 2. The font-backend risk dissolves

The axis that looked to need Windows: macOS/CoreText reads the `hhea` ascender,
Windows reads `usWinAscent` unless `USE_TYPO_METRICS` is set
([SIL FDBP](https://silnrsi.github.io/FDBP/en-US/Line_Metrics.html),
[Glyphs](https://glyphsapp.com/learn/vertical-metrics),
[csswg-drafts#4792](https://github.com/w3c/csswg-drafts/issues/4792)).
Different ascent → different baseline → findings 01 breaks on Windows.

It doesn't, and our own code is why. `fontMetrics()` at
`src/capture/textRuns.js:15` reads `measureText().fontBoundingBoxAscent`; nothing
in `src/` reads an ascent from the font file.
[`text_metrics.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/html/canvas/text_metrics.cc)
computes that from

```cpp
const FontMetrics& font_metrics = font_data->GetFontMetrics();
const float ascent = font_metrics.FloatAscent(
    kAlphabeticBaseline, FontMetrics::ApplyBaselineTable(true));
```

— the *same* `FontMetrics` Blink uses for line layout. Whichever ascent a
platform selects, the line box and our reported ascent move together.
`top + ascent` lands on the baseline everywhere.

Absolute pixel values *will* differ on Windows for a font where
`hhea ≠ usWin`. That is Chromium's own layout differing, and the user's browser
would print it that way too. Correct behaviour, not drift.

### 3. The 1/64 px drift needs no matrix at all

[`layout_unit.h`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/platform/geometry/layout_unit.h):

```cpp
using LayoutUnit = FixedPoint<6, int32_t>;
static constexpr int kFixedPointDenominator = 1 << kFractionalBits;
```

`kFractionalBits` = 6 → denominator 64. No `#ifdef` on OS or architecture
anywhere in the instantiation. Findings 03's "31/64" drift is invariant across
platform *and* CPU by construction — which also retires the mac-x64-under-Rosetta
arm of the proposed matrix. Only a *version* change could move it.

### 4. A "Chromium limit" that was my own invalid CSS

Findings 15 recorded `break-before: <page-name>` computing to `auto` as one of
"two genuine platform limits." It is not a limit.
[css-break-3](https://drafts.csswg.org/css-break-3/) gives the complete value
list:

> `auto | avoid | avoid-page | page | left | right | recto | verso | avoid-column | column | avoid-region | region`

Keywords only — no custom identifiers. Chromium computing it to `auto` is
**conformant**; the stylesheet was wrong. Reclassified from "Chromium limit" to
"not valid CSS." (The verdict table already said so; findings 15's framing was
the loose one.)

### 5. `@page :blank` is a real gap — and now has a mechanism

The opposite outcome. [css-page-3](https://drafts.csswg.org/css-page-3/) does
define it:

> "The :blank pseudo-class matches content-empty pages that appear as a result
> of forced page breaks."

And [`css_selector.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/css/css_selector.cc)
shows exactly why it vanishes:

```cpp
PseudoType type = CSSSelectorParser::ParsePseudoType(value, false, document);
if (type != kPseudoFirstPage && type != kPseudoLeftPage &&
    type != kPseudoRightPage) {
  type = kPseudoUnknown;
}
```

Three names accepted; anything else becomes `kPseudoUnknown`, the page selector
fails to parse, and the *entire rule* is discarded — which is why it never
reaches the CSSOM rather than appearing with no effect. Findings 15's
observation stands and is now explained.

Bonus: this is also proof that `:first`/`:left`/`:right` is the **complete**
set Chromium implements, so findings 14's pseudo-class cascade covers 100 % of
what exists. That was previously an assumption.

### 6. Corner radii — derived, then confirmed

Findings 04 derived from measurement that CSS scales all radii by one factor
rather than clamping each corner. [css-backgrounds-3
§4.5](https://www.w3.org/TR/css-backgrounds-3/#corner-overlap):

> "Let f = min(Li/Si), where i ∈ {top, right, bottom, left}"
> "If f < 1, then all corner radii are reduced by multiplying them by f."

Exactly the derived rule, including the single-`f`-for-the-whole-box part that
the empirical derivation had to guess at.

### 7. A finding that reading made *less* portable

Findings 12 measured margin boxes defaulting to 16 px serif rather than
inheriting from `<body>`, at 0.01 px total error.
[css-page-3](https://drafts.csswg.org/css-page-3/) says:

> "page-margin boxes inherit from the page context. The page context inherits
> from the root element."

— but adds a conformance exception allowing implementations to set page-context
inherited properties to **initial values** instead. Chromium takes the exception
branch. So the measurement is right about Chromium and right about the spec's
*optional* path, which means a different conformant engine could inherit from
the root and our hard-coded 16 px serif would be wrong there.

This is the one place the pass made a claim *weaker*, and it could not have been
found by measuring — only by reading. `MARGIN_BOX_DEFAULT_FONT` in
`src/pagination/furniture.js` should be treated as a Chromium-specific default,
not a universal one.

### 8. Shadows — half spec, half measured

MDN states `shadowBlur` "is not affected by the current transformation matrix."
The spec is **silent** on whether `shadowOffsetX`/`shadowOffsetY` are. Our
measurement covers both: `fixtures/paint-gaps.html:30` uses
`box-shadow: 5px 7px 14px`, so non-zero offsets were genuinely exercised, and
`experiments/paint-gaps.js:199–201` scales all three by the supersampling factor
to land under 1 % pixel difference. Blur is `W + M`; the offset half is `M` only,
and Chromium-specific until a spec says otherwise.

---

## What still needs machines this project doesn't have

Class `U`, and honestly so:

- **A4 as 594.96 × 841.92 pt.** A mm→pt conversion with a rounding rule not yet
  located in source. Version-sensitive at minimum.
- **The dash/gap stretch rule.** Blink painter behaviour, not a constant.
- **Bullet placement away from 16 px.** Two calibration points and a non-linear
  fit — under-determined regardless of platform.
- **Devanagari extraction order**, **WebP inflation**, **scale timings.**

The right next step is therefore *not* a platform matrix but a **version**
sweep, targeting only the class-`U` behavioural rules. A full sweep was scoped
and then dropped as not worth several hundred megabytes of browser downloads;
what ran instead was a **two-build spot check** on the Chromiums already
installed — m148 vs m152, four majors apart. Nothing moved, and both controls
held ([`findings-17-version-check.md`](findings-17-version-check.md)).

That falsifies nothing and establishes nothing. The class-`U` rows stay open;
they are now merely *unrefuted* across a narrow span rather than untested.

Windows remains unverified, and the verdict says so plainly rather than
implying a matrix that never ran.
