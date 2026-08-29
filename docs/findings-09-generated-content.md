# Findings 09 — Generated content

**Status:** `::before` / `::after` / counters PASS · numeric markers exact · bullets approximate
**Date:** 2026-08-29
**Chromium:** Google Chrome for Testing 152.0.7977.54 (arm64, headless)
**Scope:** plan §22, the last extraction gap from findings 03

Run: `node experiments/generated-content.js`

---

## 1. The problem

Pseudo-elements have no DOM node. There is no rect to read and no `Range` to
walk, so the text pipeline — which walks text nodes — cannot see them at all.
Findings 03 caught this as missing `::marker` text; it affects `::before`,
`::after` and `counter()` identically.

The browser turns out to expose *different amounts* for the two cases, so they
needed different strategies.

| | what `getComputedStyle` gives | strategy |
| --- | --- | --- |
| `::before` / `::after` | the resolved `content` string | **materialise** |
| `::marker` | `content: normal` — no text at all | **compute** |

---

## 2. What the browser resolves for free, and what it doesn't

Probed before writing any parser:

```
#attr::after        content: " (from an attribute)"        <- attr() ALREADY resolved
#ctr p::before      content: "Step " counter(step) ": "    <- counter() NOT resolved
ol li::marker       content: "normal"                      <- no text at all
```

`attr()` costs nothing. `counter()` and `counters()` had to be implemented:
walk the tree maintaining a scope stack per counter name, with `counter-reset`
pushing a scope for the element's subtree and `counter-increment` applying at
the pseudo-element's position. Plus the `list-style-type` formatters —
decimal, leading-zero, alpha, roman.

---

## 3. Materialisation

For `::before` / `::after`, rather than invent a geometry path, the pseudo is
replaced with a **real inline element** carrying its computed style and resolved
text, and the original is suppressed with
`.__pdf_mat::before { content: none !important }`.

The existing text pipeline then measures it like any other inline content — no
new geometry code, and the baseline machinery from findings 01 applies
unchanged. Verified directly: after materialising `#both::before`, the injected
span occupies `left 0, width 4.25` and the paragraph's own text starts at
`4.25` — exactly where it started before the mutation.

**9 of 9 pseudo-elements materialised**, including `attr()` and all three
counter instances.

### The bug this exposed

Reading the two pseudo-elements one at a time loses the second. Adding the
suppression class for `::before` also suppresses `::after`, so the subsequent
`getComputedStyle(el, '::after')` returns `none`. `#both` produced its `[` but
not its `]`.

Both pseudo-elements must be read *before* the element is touched. Obvious in
hindsight; silent in practice.

---

## 4. Markers: a rule derived, not assumed

`::marker` gives no text and an outside marker sits in the padding area, where a
materialised span would not land. So its placement was derived from Chromium's
own output:

```
"1."  at cssX=10.84 width=13.20  -> right edge 24.04
"2."  at cssX=10.84 width=13.20  -> right edge 24.04
"I."  at cssX=15.47 width= 8.56  -> right edge 24.03
"II." at cssX=11.12 width=12.91  -> right edge 24.03
li content-box left edge = 28.00
```

Every marker's **right edge sits 3.97 px before the content edge**, across
markers of very different widths. That gap is the space advance in Roboto at
16 px — 3.96 px, the same number findings 01 measured for the leading-space
issue.

Result: numeric and roman markers land at **0 px / 0 px** on per-line ink
extents.

---

## 5. Bullets: two data points, and a rule that isn't linear

Bullets are *not* text. Chromium's export contains no text item for them —
only `constructPath` — so they are painted as vector shapes.

The first attempt drew Roboto's `U+2022` glyph instead. That was wrong twice
over: the ink measured 3.2 px against Chromium's 6.4 px, so Chromium is not
using the font's bullet glyph at all.

A synthesised circle got the size exactly right (6.40 px at 16 px, matching to
the pixel) but sat 8.00 px too far right. Before generalising the gap from that
one measurement, a second font size was added to the fixture:

| font-size | Chromium diameter | gap to content edge |
| --- | --- | --- |
| 16 px | 6.40 px (0.400 em) | 11.60 px (0.725 em) |
| 26 px | 9.60 px (**0.369 em**) | 15.60 px (**0.600 em**) |

**The rule is not linear in em.** A single data point would have produced a
constant that looked right at 16 px and drifted everywhere else — the same
failure mode as the margin-rounding rule in findings 03, and as the retracted
Arabic claim in findings 05.

So the constants are shipped as calibrated at 16 px, with anything else
declared:

```
PDF_MARKER_APPROXIMATE
  bullet at 26px; placement calibrated at 16px and does not scale linearly
```

Deriving the real rule needs more sizes and probably Chromium's marker layout
source. It is a small, bounded piece of work, and knowingly approximate beats
confidently wrong.

---

## 6. Coverage against Chromium

| probe | ours | chromium |
| --- | --- | --- |
| `[` `]` `(from an attribute)` | yes | yes |
| `Step 1:` `Step 2:` `Step 3:` | yes | yes |
| `NOTE` (styled badge) | yes | yes |
| `1.` `2.` `I.` `II.` | yes | yes |
| `→` `✓` | **no** | yes |

**11 of 13**, with extracted character counts matching exactly at **358 vs 358**.

The two misses are **font coverage, not extraction**: `→` (U+2192) and `✓`
(U+2713) are genuinely absent from Roboto — verified with fontkit —
and Chromium falls back to a system font. This experiment does not wire the font
registry from findings 05, so they became `.notdef` silently. That is precisely
the behaviour the registry exists to prevent, and the lesson is that it must be
wired into **every** rendering path, not just the one it was built for.

Note also that the character counts matched exactly *while two strings were
missing* — an aggregate that looked healthy over a real defect. The per-string
probe is the check that matters.

---

## 7. Known residuals

- **Bullets away from 16 px** (§5), declared.
- **Materialised backgrounds and padding.** A styled pseudo like the `NOTE`
  badge carries `background-color` and padding. Its text places correctly, but
  this text-only experiment does not paint the box — the paint pipeline from
  findings 08 has to run over materialised elements too. Measured as a 67 px
  left-extent difference on that line.
- `::first-line`, `::first-letter`, `open-quote`/`close-quote`, `content: url()`
  — untested; `url()` is detected and reported.
- Materialisation mutates the DOM. That is safe in the intended
  render-in-an-isolated-frame model (plan §9) but would not be acceptable
  against a live document.
