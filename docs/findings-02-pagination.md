# Findings 02 — Pagination

**Status:** Gate 4 PASS, with one enumerated divergence
**Date:** 2026-08-29
**Chromium:** Google Chrome for Testing 152.0.7977.54 (arm64, headless)
**Scope:** plan §24 (pagination strategy), §37 Gate 4, §38 critical failure D, deliverable 5

Pagination was the largest remaining unknown and the only plausible
project-killer left: §38's critical failure D is "common page fragmentation
cannot be reproduced without implementing an unreasonably large portion of
Blink."

It can be reproduced, and almost none of Blink is required — because Chromium
will perform the fragmentation for us if asked the right way.

Run it: `node experiments/gate4-pagination.js`

---

## 1. The question

Plan §24 frames it correctly: the issue is not whether pagination *can* be
implemented, but how much of Chromium's existing fragmentation result we can
coax out of ordinary layout APIs so we implement as little as possible.

Two candidate oracles were built and raced against each other.

**A — naive height partition.** Take the continuous screen layout and cut every
`pageHeight` pixels. Knows nothing about forced breaks, `break-inside`,
orphans or widows.

**B — multicolumn oracle.** Re-lay the *same* content in a multicolumn
container whose column height equals the page content height, with
`column-fill: auto`. Chromium then performs **real fragmentation**, and we read
back which column each line landed in. Column index = page index.

Ground truth is `Page.printToPDF`: which page each run actually lands on, and
where on that page.

The fixture (`fixtures/gate4-pagination.html`) is built to punish arithmetic:
a `break-inside: avoid` card, an `h2` with `break-after: avoid`, a 15-row table
with a repeating header, a paragraph with `orphans: 3; widows: 3`, and an
explicit `break-before: page`. Chromium fragments it into 3 pages.

---

## 2. Result

| Method | Page assignment | Baseline error within page |
| --- | --- | --- |
| A — naive height partition | 103/111 &nbsp;(**92.8 %**) | 19.2 px mean, 36.0 px max |
| B — multicolumn oracle | 109/109 &nbsp;(**100 %**) | 0.00 px on pages 1 and 3 |

Method B places **every** run on the correct page, and on pages 1 and 3 the
baseline error is exactly zero — including page 3, which begins after a forced
break. Page 2 carries a constant −30.50 px offset with a single known cause
(§5).

---

## 3. Why the naive method fails

Every one of method A's 8 errors is the same construct:

```
p2->p3  "Notes"
p2->p3  "The heading above forces a page break before it..."
p2->p3  "regardless of how much room remained on the previous..."
...
p2->p3  "Final paragraph. The document ends here..."
```

The entire section following `break-before: page` lands one page early. A
continuous layout contains no evidence that a forced break exists, so
arithmetic over it cannot see one.

**Do not read A's 92.8 % as "naive handles everything except forced breaks."**
On this fixture the `break-inside: avoid` card and the widows/orphans paragraph
happened not to straddle a boundary in a way that broke A. That is fixture
luck, not a property of the method. A's true failure surface is every
fragmentation rule, and 92.8 % is an upper bound on its accuracy, not a typical
one.

---

## 4. Why the multicolumn oracle works

> **Spec-mandated, not a coincidence (confirmed 2026-08-29).**
> [css-break-3](https://drafts.csswg.org/css-break-3/) defines a *single*
> fragmentation model covering both: "fragmentation container (fragmentainer):
> A box—such as a **page box, column box**, or region—that contains a portion
> (or all) of a fragmented flow." Page boxes and column boxes are the same kind
> of object under the same rules, so the oracle is not borrowing an unrelated
> mechanism — it asks the fragmentation engine the question it already answers.
> This moves the architecture's central bet from "observed in Chromium 152" to
> "required of any conformant engine."

Three properties make it more than a trick.

**It runs Chromium's real fragmentation code.** `break-inside: avoid`,
`break-after: avoid`, orphans and widows are all honoured, because Blink is
doing the fragmenting, not us. This is plan §40's ordering applied exactly: ask
the browser rather than reimplement.

**A column's top is the page content-box top.** This is the part that matters
most and was not obvious. Because each column origin is known exactly, the
offset of a run within its page is read directly:

```
y_on_page = pageMargin + (baseline − columnOrigin.top)
```

No anchoring heuristic, no accumulating offset. Crucially this also captures
whatever Chromium did to *margins* at the fragmentation boundary — page 3
begins with an `h2` carrying `margin-top: 24px`, and measuring from the column
origin reproduces Chromium's treatment of it to 0.00 px. An earlier version
that anchored to "the first run on the page" got this wrong by 25 px.

**Forced page breaks need one mechanical rewrite.** A multicolumn container
fragments into columns and ignores `break-*: page` entirely. Translating them
before measuring is a DOM walk:

```js
for (const el of doc.querySelectorAll('*')) {
  const cs = getComputedStyle(el);
  if (cs.breakBefore === 'page') el.style.breakBefore = 'column';
  if (cs.breakAfter  === 'page') el.style.breakAfter  = 'column';
}
```

Without this the oracle produced 2 columns against Chromium's 3 pages. With it,
3 and 3.

---

## 5. The one divergence: repeated table headers

`display: table-header-group` repeats a `<thead>` on every **page** a table
spans. It does **not** repeat across **columns**.

Measured directly:

| | page 1 | page 2 | page 3 |
| --- | --- | --- | --- |
| Chromium `printToPDF` | header @ y 944 | **header @ y 96** | — |
| Multicolumn oracle | header @ y 944 | *absent* | — |

This single gap explains both remaining discrepancies:

- the constant **−30.50 px** offset on page 2 — exactly the header row's height,
  by which Chromium pushes every subsequent row down;
- the **2 unmatched runs** — header cells present in Chromium's output that our
  extraction never produced.

Note the offset is *constant*, not accumulating. The oracle is not drifting; it
is missing one known object.

### Why this needs real handling, not a post-hoc offset

The repeated header consumes 30.5 px of page 2 that our column did not reserve.
So a table row near a boundary can legitimately land on a different page than
the oracle predicts. It did not happen here, but it can.

This is plan §24.4's hybrid pagination, and it is the correct shape for the
fix: the oracle supplies fragmentation, and a small controller of ours handles
header repetition — synthesising the header at the top of each continuation
fragment and reserving its height. Bounded, enumerable work; not a
reimplementation of Blink.

---

## 6. Cost

Extraction over the whole 3-page document:

| pass | time |
| --- | --- |
| continuous flow | 11 ms |
| multicolumn re-layout + extraction | 7 ms |

Re-laying the document as multicolumn and re-extracting is cheap. Pagination
does not change the performance picture established in findings 01.

---

## 7. Method notes — two harness bugs worth recording

Both produced confident, wrong numbers before being caught. Recording them
because either would be easy to reintroduce.

**Ground truth must be captured before any DOM mutation.** Method B sets inline
`break-before` on descendants. An early version reset only
`#doc.style.cssText` afterwards, leaving those inline styles in place, so
`printToPDF` ran against a mutated DOM and reported 2 pages instead of 3.
Method A then scored a meaningless 100 %. `page.pdf()` now runs first.

**Modulo is the wrong model for pagination.** An early version computed
`y_on_page = y % pageHeight`. A page break leaves slack at the page foot and
content resumes at the top margin, so the modulo drifts by the accumulated
slack. This inflated both methods' y error to ~19 px and initially looked like
a finding about layout rather than a bug in the scorer.

**Replicate Chromium's margin rounding.** Chromium rounds `@page` margins to
whole **CSS pixels**: 20 mm → 75.59 px → 76.00 px, making the content box
970.52 px rather than the 971.34 px CSS arithmetic gives.

> **Correction (findings 03).** This was originally written as "rounds to whole
> *points*", because 76 px happens to be exactly 57 pt and a 20 mm margin fits
> both rules. A 10 mm margin separates them: 37.795 px → 38 px = 28.5 pt, which
> is not a whole number of points. The rule is whole pixels. Using the CSS value made the column
0.82 px taller than a real page, which was enough to fit one extra line and
flip an entire widows-constrained paragraph to the wrong page — method B scored
86.5 % instead of 100 %. The rounding rule is reproducible client-side, so this
is a correctness requirement, not a limitation.

---

## 8. Gate status

| Gate | Status | Basis |
| --- | --- | --- |
| 1 — Text geometry | **PASS** | findings 01 |
| 2 — Text shaping | **PASS** (core claim) | findings 01 + 05; complex-script glyph selection **confirmed**. Devanagari *extraction order* still wrong |
| 3 — Paint reconstruction | Not started | boxes, borders, stacking order |
| **4 — Pagination** | **PASS** | 100 % page assignment, 0.00 px y on unaffected pages, one enumerated divergence |
| 5 — PDF backend | PASS for text | findings 01 |

§38's critical failure D does not hold. Common page fragmentation is
reproducible client-side without privileged Blink print APIs, because Blink can
be induced to do the fragmenting through ordinary CSS.

The remaining risk in this area is not "can it be done" but "how many more
page-vs-column divergences exist." One was found here. Others plausibly exist
around `@page` margin boxes, named pages, and `position: fixed` repetition —
each of which is enumerable by the same method used here.

---

## 9. Next

1. **Enumerate page-vs-column divergences systematically.** Repeated table
   headers were found by accident. Build fixtures that probe each fragmentation
   feature and diff the two modes directly, rather than waiting to trip over
   them.
2. **Header-repetition controller** (§5), the first piece of genuinely
   hybrid pagination.
3. **Font registry with loud diagnostics** — still the most dangerous
   outstanding behaviour from findings 01, where a missing glyph became
   `U+0000` silently.
4. **Gate 3 — boxes and paint order**, still untouched.
