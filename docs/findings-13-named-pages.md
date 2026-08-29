# Findings 13 — Furniture under named pages

**Status:** PASS — named pages are not a scope boundary
**Date:** 2026-08-29
**Chromium:** Google Chrome for Testing 152.0.7977.54 (arm64, headless)

Run: `node experiments/named-pages.js`

---

## 1. Retraction: named pages are not blocked

Findings 03 recorded named pages as a **scope boundary** — "a multicolumn
container has one fixed column geometry and cannot express per-page sizes" —
and findings 12 repeated that furniture under them was blocked on it.

The premise was right and the conclusion wrong. A *single* multicolumn container
cannot express two page sizes. But the remedy proposed alongside it — split the
document into runs of uniform page geometry and fragment each with its own
oracle pass — was never attempted. It works completely.

That is the fourth capability claim in this programme to fail on contact with a
measurement. Three of the four were mine describing what the platform *could
not* do.

---

## 2. Everything needed is exposed

| what | where |
| --- | --- |
| which run an element belongs to | `getComputedStyle(el).page` → `"wide"` |
| each run's page size and margins | CSSOM `CSSPageRule.selectorText` / `.style.size` / `.style.margin` |
| each run's **own** margin boxes | the rule's child `CSSMarginRule`s |

So segmentation is a one-pass walk grouping consecutive top-level siblings by
their computed `page` value — `page` is inherited, so that is the right
granularity.

---

## 3. Result

Three runs, one oracle pass each:

```
page="(default)"   content 377.5 x 234.2 px  -> 1 column
page="wide"        content 642.1 x 234.2 px  -> 2 columns
page="(default)"   content 377.5 x 234.2 px  -> 1 column
```

| # | run | ours (w × h) | Chromium | furniture |
| --- | --- | --- | --- | --- |
| 1 | default | 453.5 × 340.2 | 453.4 × 340.2 | `NARROWHEAD`, `p1/4` |
| 2 | wide | 718.1 × 340.2 | 718.7 × 340.2 | `WIDEHEAD`, `W2` |
| 3 | wide | 718.1 × 340.2 | 718.7 × 340.2 | `WIDEHEAD`, `W3` |
| 4 | default | 453.5 × 340.2 | 453.4 × 340.2 | `NARROWHEAD`, `p4/4` |

- **page count** 4 vs 4
- **page sizes matching** 4/4
- **furniture strings on the correct page** 8/8

Each run also carries its *own* furniture: the narrow pages get `NARROWHEAD`,
the wide pages `WIDEHEAD`, straight from their respective `@page` rules.

---

## 4. Page counters are document-global, not per run

The single detail that would be easy to get wrong. Chromium numbers pages across
the whole document, not within each run:

```
p1/4    W2    W3    p4/4
```

`counter(page)` on page 4 is **4**, not "2nd page of the second default run",
and `counter(pages)` is the total across every run. So the counter is resolved
from the accumulated global page index after all runs are fragmented, not from
any per-run index.

Repeated table headers also work inside a named run: the wide table's header
appears on both wide pages.

---

## 5. What this changes

The furniture model now covers every case the divergence matrix found:

```
Page
 |- flow content        oracle, one pass per run of uniform page geometry
 `- furniture           per page, from that page's own @page rule
     |- fixed elements
     |- repeated table header / footer
     `- running headers, footers, page numbers
```

Named pages are no longer a boundary — they are simply the reason the oracle
runs more than once.

---

## 6. Still open

- **Nested named pages** — a named run inside another named run.
- `:first`, `:left`/`:right` page pseudo-classes, which select different rules
  for the first page or by spread side.
- Explicit page breaks that force a *change of named page* mid-run.
- Whether a run boundary always coincides with a page break in Chromium (it did
  here; a run beginning mid-page is untested).
