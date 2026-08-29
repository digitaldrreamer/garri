# Findings 11 — The page furniture layer

**Status:** BUILT — all four divergence probes now pass
**Date:** 2026-08-29
**Chromium:** Google Chrome for Testing 152.0.7977.54 (arm64, headless)
**Scope:** the four page-vs-column divergences from findings 03

Run: `node experiments/furniture.js`

---

## 1. The model

Pagination is two questions, and conflating them is what made the findings-03
divergences look like four unrelated bugs:

```
Page
 |- flow content      <- the multicolumn oracle answers WHERE fragmented
 |                      content goes
 `- furniture         <- this layer answers WHAT must independently appear
     |- fixed elements                        on each physical page
     |- repeated table header
     |- repeated table footer
     `- future running headers / footers
```

Every divergence found in findings 03 is the same shape: **content that paged
media repeats or re-geometries per page, which column fragmentation has no
concept of.** One mechanism covers them, and it extends to running headers,
page numbers and watermarks without a new special case each time.

---

## 2. Result

| probe | furniture | pages/cols | page assignment | content missing |
| --- | --- | --- | --- | --- |
| `table-header-group` | off | 2/2 | 49/49 | 3 |
| | **ON** | 2/2 | **46/46 (100 %)** | **0** |
| `table-footer-group` | off | 2/2 | **22/28 (79 %)** | 3 |
| | **ON** | 2/2 | **46/46 (100 %)** | **0** |
| `position: fixed` | off | 2/**3** | **0/4 (0 %)** | 1 |
| | **ON** | 2/**2** | **18/18 (100 %)** | **0** |
| control, plain flow | off | 2/2 | 18/18 | 0 |
| | **ON** | 2/2 | 18/18 | 0 |

The control is unchanged in both modes — the layer does not disturb documents
that have no furniture.

---

## 3. Three responsibilities, in order

**DETACH.** Fixed elements come out of the flow *before* the oracle measures.
In a multicolumn container a fixed element positions against the **viewport**,
not the container, so it lands at an arbitrary x — in the probe it mapped to
column 5 and invented a third column that does not exist. Removing it takes the
column count from 3 back to 2 and page assignment from 0/4 to 18/18.

**RESERVE.** This is the part that makes assignment right rather than merely
appearance. A continuation page carries a repeated header the oracle never
accounted for, so every row below shifts and — near a boundary — lands on the
wrong page. Height is given back by inserting spacer rows, then re-measuring,
because where the break falls depends on the reservation and the reservation
depends on where the break falls. It iterates to a fixed point.

**EMIT.** Each page gets the furniture it needs re-issued, with the flow's own
copy left alone.

---

## 4. Headers and footers reserve at opposite ends

The first implementation treated both the same and only moved
`table-footer-group` from 79 % to 89 %.

- a repeated **header** occupies the **top** of every continuation column, so
  the spacer goes before that column's **first** row;
- a repeated **footer** occupies the **bottom** of every column except the last,
  so reserving at the top of the next column is wrong — the spacer must go
  before the trailing row of the column it sits in, pushing that row out.

Symmetrically for emission: the header is re-issued on continuations (its flow
copy sits on the first page), while the footer's flow copy already lands on the
**final** page, so only the *earlier* pages need it. Emitting on continuations
as well painted it twice on the last page.

---

## 5. A convergence bug worth recording

The iteration's stop condition first tracked only **which columns** a table
spans. That declared convergence after one pass while rows were still moving —
the reservation had changed the layout, but not the span, so the loop exited
early and the numbers plateaued at 89 %.

Making the signature record **which rows sit in which column** fixed it. The
footer probe now takes 2 passes and reaches 100 %.

The general lesson: a fixed-point loop's stop condition has to observe the
quantity you actually care about, not a coarser summary of it.

---

## 6. A scoring trap

Once furniture is emitted separately, a repeated section appears twice in the
output but only once in the flow. A naive sequential matcher pairs the flow copy
with Chromium's *first* occurrence and reports the difference as three
misassigned rows — which looks like a real defect and is not.

Furniture is excluded from the **page-assignment** comparison (its flow position
is meaningless once the layer places it) but still counted for **content
coverage** (the first occurrence is genuine flow content). Getting that backwards
produced, in turn, a false 3-row failure and then a false 3-string shortfall.

---

## 7. Not covered

- **Running headers and footers** from `@page` margin boxes — the model
  accommodates them; Chromium's support is limited and this is untested.
- **Page numbers / `counter(page)`** — same.
- `position: sticky`.
- Tables nested inside other repeating contexts.
- Furniture interacting with named pages (still a scope boundary).
- The reservation assumes furniture height is constant across pages, which is
  true for `thead`/`tfoot` but need not be for running headers.
