# Findings 15 — Blank pages, named breaks, same-name nesting

**Status:** all four open items closed · **one** genuine Chromium gap, one invalid stylesheet
**Corrected 2026-08-29:** this doc originally called both findings "platform limits."
Only `@page :blank` is one. See [`evidence-classes.md`](evidence-classes.md) §4–5.
**Date:** 2026-08-29
**Chromium:** Google Chrome for Testing 152.0.7977.54 (arm64, headless)

Run: `node experiments/named-pages-advanced.js page-edge-cases thead-across-runs`

---

## 1. Two real limits, at last

After five capability claims that dissolved on measurement, these two hold.

### `@page :blank` is not supported

> **Mechanism confirmed at source 2026-08-29.** The spec *does* define it
> ([css-page-3](https://drafts.csswg.org/css-page-3/): "matches content-empty
> pages that appear as a result of forced page breaks"), so this is a genuine
> Chromium gap. [`css_selector.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/css/css_selector.cc)
> `UpdatePseudoPage()` accepts only `kPseudoFirstPage`, `kPseudoLeftPage` and
> `kPseudoRightPage`; anything else becomes `kPseudoUnknown`, the page selector
> fails to parse, and the **whole rule** is discarded — which is why it never
> reaches the CSSOM at all. This also proves `:first`/`:left`/`:right` is the
> complete supported set, so findings 14 covers everything that exists.


The rule is **dropped from the CSSOM entirely**:

```
@page rules found: (default), wide      <- the :blank rule is absent
```

That is a sharp contrast with `:first`, `:left` and `:right`, which *do* appear
as `CSSPageRule`s with their `selectorText` intact (findings 14). So this is not
a reading problem on our side — Chromium does not parse `:blank` at all, and no
blank page was generated.

### `break-before: <page-name>` is not a thing

```
.breakToWide   breakBefore = "auto"
```

> **Not a Chromium limit — corrected.** [css-break-3](https://drafts.csswg.org/css-break-3/)
> defines the complete value list as
> `auto | avoid | avoid-page | page | left | right | recto | verso | avoid-column | column | avoid-region | region`
> — keywords only, no custom identifiers. Computing `break-before: wide` to
> `auto` is **conformant**; the stylesheet was invalid. Verified at source
> 2026-08-29.

`break-before: wide` is rejected as invalid and computes to `auto`; the content
did not break. Page names are selected with the `page` property, and a change of
page context forces the break by itself (findings 14). There is no separate
named-break syntax to support.

### And a partial one

`break-before: right` **is** parsed (`breakBefore = "right"`) and Chromium honours
it as an ordinary forced break — but it does **not** generate a blank verso to
land the content on an odd page. The forced content appeared on page 2, an even
page. So `left`/`right` behave as plain page breaks here.

---

## 2. Same-name nesting merges

A `page: wide` block nested inside another `page: wide` block does **not** split
into three runs. Chromium puts all of it on one wide page:

```
p3  719x340 : WIDE n3  D: outer wide run.  E: inner run, same name...  F: outer wide run resumed.
```

Grouping *consecutive* elements by effective page name — which is what
`segmentByPage` already did — produces exactly this. No change needed.

---

## 3. A repeated header spanning pages inside a named run works

| # | run | ours | Chromium | furniture |
| --- | --- | --- | --- | --- |
| 1 | wide | 718 × 265 | 719 × 264 | `WIDE` + `SPANHEAD` |
| 2 | wide | 718 × 265 | 719 × 264 | `WIDE` + `SPANHEAD` |
| 3 | default | 454 × 265 | 453 × 264 | `DEF` |

3/3 pages · 3/3 sizes · 3/3 furniture. The table lives entirely within one run,
so the per-run reservation and emission from findings 11 apply unchanged.

---

## 4. The bug this turned up: not every page break says `page`

`page-edge-cases` first came out **3 pages against Chromium's 4**. The oracle
translated `break-before: page` into a column break and nothing else — but
Chromium also breaks on `left`, `right`, `recto`, `verso` and legacy `always`.

A `break-before: right` therefore produced one column where Chromium produced
two pages. Silent under-fragmentation: no error, just a missing page.

```js
const PAGE_BREAK_VALUES = /^(page|left|right|recto|verso|always)$/;
```

With all of them translated: **4/4 pages, 4/4 sizes, 8/8 furniture.**

This lived in three experiments as copy-pasted two-line translations. It is now
one `translatePageBreaks()` in the furniture module, which is where it should
have been — the copies were how a known rule ended up incomplete in every copy
at once.

---

## 5. Where named pages stand

Everything raised across findings 13–15 is now measured:

| item | status |
| --- | --- |
| named runs, own geometry and furniture | works (13) |
| nested named runs, outer resumes | works (14) |
| `:first` / `:left` / `:right` cascade | works (14) |
| run boundary always breaks the page | confirmed (14) |
| `page` is not inherited | handled (14) |
| same-name nesting | merges; already correct (15) |
| repeated header inside a named run | works (15) |
| all forced-break keywords | fixed (15) |
| `@page :blank` | **unsupported by Chromium** |
| `break-before: <page-name>` | **not valid CSS** |
| blank verso for `left`/`right` | **not generated by Chromium** |

---

## 6. Still open

- A repeated table header spanning an actual run *boundary* — structurally the
  table would have to straddle a page-size change, which Chromium appears to
  prevent by breaking at the boundary. Untested rather than impossible.
- `@page` rules inside `@media print` blocks.
- Nested runs deeper than two levels.
