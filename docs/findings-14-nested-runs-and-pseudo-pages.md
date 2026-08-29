# Findings 14 — Nested runs, page pseudo-classes, run boundaries

**Status:** PASS — all three open named-page items resolved
**Date:** 2026-08-29
**Chromium:** Google Chrome for Testing 152.0.7977.54 (arm64, headless)

Run: `node experiments/named-pages-advanced.js`

---

## 1. Results

### Nested named runs

A `page: tall` block inside a `page: wide` block. Chromium produces five pages,
and **the outer run resumes after the inner one**:

| # | run | ours | Chromium | furniture |
| --- | --- | --- | --- | --- |
| 1 | default | 454 × 340 | 453 × 340 | `DEFAULT` |
| 2 | wide | 718 × 340 | 719 × 340 | `WIDE` |
| 3 | **tall** | **454 × 529** | 453 × 529 | `TALL` |
| 4 | wide | 718 × 340 | 719 × 340 | `WIDE` |
| 5 | default | 454 × 340 | 453 × 340 | `DEFAULT` |

Page count 5/5 · sizes 5/5 · furniture 5/5.

### `:first` / `:left` / `:right`

| # | furniture (ours, all confirmed present in Chromium's page) |
| --- | --- |
| 1 | `FIRSTHEAD` `n1` `RIGHTBOX` |
| 2 | `DEFAULTHEAD` `n2` `LEFTBOX` |
| 3 | `DEFAULTHEAD` `n3` `RIGHTBOX` |
| 4 | `DEFAULTHEAD` `n4` `LEFTBOX` |

Page count 4/4 · sizes 4/4 · furniture **12/12**.

### Run boundaries

A one-line paragraph followed by a named run still occupies a whole page.
**A change of page context always forces a page break**, so run boundaries and
page boundaries coincide. A run beginning mid-page does not occur.

---

## 2. `page` is not inherited

The bug that made the first attempt collapse everything into a single run.

```
.wide                      page = "wide"
.wide > p (first child)    page = "auto"     <-- not inherited
.tall                      page = "tall"
.tall > p                  page = "auto"
```

A descendant of a `page: wide` block reports `auto`, not `wide`. Segmentation
must resolve the effective run from the **nearest self-or-ancestor** carrying a
non-auto value, not from the element's own computed value.

Grouping only top-level children (findings 13) also fails here, because a nested
run is not a top-level sibling. The walk has to be over the whole tree in
document order.

---

## 3. Page rules cascade per margin slot

Page 1 of the pseudo-class fixture carries content from **three different
rules at once**:

```
FIRSTHEAD   from  @page :first    (top-center)
n1          from  @page          (bottom-right)
RIGHTBOX    from  @page :right    (bottom-left)
```

So `@page` rules do not compete for the page — they merge, slot by slot. The
implementation applies them least to most specific: default, spread side,
`:first`, then the named page.

`:right` selects **odd**-numbered pages and `:left` even — page 1 is a
right-hand page.

---

## 4. Nothing here was a platform limitation

Four items were carried as untested with an implied doubt about support.
Chromium implements all of them: nested named runs, `:first`, `:left`, `:right`,
and forced breaks at run boundaries. Every input needed is exposed through
`getComputedStyle` and the CSSOM.

That is now five capability claims in this programme that failed when measured,
four of them mine asserting a limit. The corrective is simple and has worked
every time: probe before describing.

---

## 5. Still open

- **`@page :blank`** — untested.
- Named runs interacting with `break-before: <named-page>`.
- Whether a nested run of the *same* name as its grandparent merges or splits.
- The reservation and emission paths are exercised per run here, but a repeated
  table header spanning a nested run boundary is untested.
