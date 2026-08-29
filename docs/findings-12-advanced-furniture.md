# Findings 12 — Running headers, page counters, sticky, nested repeats

**Status:** margin boxes and page counters IMPLEMENTED · sticky and nested repeats RESOLVED
**Date:** 2026-08-29
**Chromium:** Google Chrome for Testing 152.0.7977.54 (arm64, headless)

Run: `node experiments/furniture-advanced.js`

---

## 1. Retraction: Chromium's support is not limited

Findings 11 closed by saying running headers and page numbers were untested
"and Chromium's own support is limited". **That was wrong, and checking it was
the first thing this experiment did.**

Chromium fully supports all of it:

```
page 1: RUNNING HEADER  Page 1 of 3  MARGINBOXLEFT  Alpha paragraph one...
page 2: RUNNING HEADER  Page 2 of 3  MARGINBOXLEFT  OUTERHEAD INNERHEAD ...
page 3: RUNNING HEADER  Page 3 of 3  MARGINBOXLEFT  OUTERHEAD INNERHEAD ...
```

`@top-center`, `@bottom-left`, `@bottom-right`, `counter(page)` and
`counter(pages)` all work, and repeated table headers nest correctly.

That is the third assumption in this programme to survive until it was measured
and then fail. The pattern is consistent enough to be a rule: **do not describe
a platform's capability without probing it.**

---

## 2. The CSSOM hands the margin boxes over

`@page` margin boxes appear as `CSSMarginRule` objects inside the `CSSPageRule`:

```js
{ ctor: 'CSSMarginRule', name: 'top-center',
  content: '"RUNNING HEADER"' }
{ ctor: 'CSSMarginRule', name: 'bottom-right',
  content: '"Page " counter(page) " of " counter(pages)' }
```

`.name` gives the slot and `.style.content` the raw value — with static strings
already resolved and counters not, exactly as `::before` behaved in findings 09.
So the same content-resolution shape applies, with `counter(page)` and
`counter(pages)` filled per page once the fragmentation is known.

---

## 3. Margin boxes need EMIT but not RESERVE

Findings 11 flagged an assumption: the reservation treats furniture height as
constant across pages, which holds for `thead`/`tfoot` but "need not for running
headers".

**The concern does not apply.** Margin boxes live in the `@page` *margin* area,
outside the content box, so they consume no content height at all. They are
pure emission — no reservation, and their height varying per page cannot affect
page assignment.

The constant-height assumption remains, but its scope is now known: it binds
only on furniture that occupies content height, which is `thead` and `tfoot`,
where the height genuinely is constant.

---

## 4. Margin boxes do not inherit from `<body>`

> **Portability caveat found by reading, not measuring (2026-08-29).**
> [css-page-3](https://drafts.csswg.org/css-page-3/) says "page-margin boxes
> inherit from the page context. The page context inherits from the root
> element" — but adds a conformance exception permitting implementations to set
> page-context inherited properties to **initial values** instead. Chromium takes
> the exception branch, which is what the measurement below captures. A different
> conformant engine could inherit from the root, and the hard-coded 16 px serif
> would be wrong there. Treat `MARGIN_BOX_DEFAULT_FONT` as Chromium-specific.


First implementation measured margin-box text in the body's font (11 px
sans-serif). Placement came out wrong in a revealing pattern:

| slot | Δx | Δwidth |
| --- | --- | --- |
| `bottom-left` | **0.01** | −42.77 |
| `top-center` | 21.09 | −42.43 |
| `bottom-right` | 15.92 | −16.17 |

Left alignment was exact because it does not depend on text width; centred was
off by *half* the width error and right-aligned by *all* of it. The whole error
was one wrong measurement, not three placement bugs.

A margin box sits in the **page context**, not the document, so its font falls
back to the **initial** value rather than inheriting. Searching font/size
combinations against Chromium's own text widths:

```
16px serif           total error 0.01px   <-- exact
16px sans-serif      total error 12.55px
15px sans-serif      total error 18.81px
```

With `16px serif`:

| metric | result |
| --- | --- |
| Δwidth | **0.00 px** |
| Δx | 0.126 px mean, **0.244 px** max |
| Δbaseline | 0.352 px mean, **0.457 px** max |

Horizontal placement follows the **content box** — left boxes at its left edge,
centred boxes on its centre, right boxes at its right edge — and vertical
centres the font box in the margin band.

---

## 5. `position: sticky` is not furniture

Measured rather than assumed: `STICKYHEADING` appears on **1 of 3** pages.

Chromium treats a sticky element as ordinary flow content in paged media — it
does not repeat. So it needs no furniture handling at all, and the existing
treatment (plain flow) is already correct. This item is closed by measurement,
not by work.

---

## 6. Nested repeating contexts already work

Chromium repeats an inner table's header alongside the outer one — pages 2 and
3 both carry `OUTERHEAD` *and* `INNERHEAD`.

The furniture layer's `identify()` walks `querySelectorAll('table')`, which
finds nested tables without special handling:

```
rows= 15  nested=false  headH=19.0  head="OUTERHEAD"
rows= 12  nested=true   headH=19.0  head="INNERHEAD"
```

Both are detected with their heights. The reservation and emission then treat
them independently, which is the correct behaviour: each table reserves its own
header height in the columns it spans.

---

## 7. Still open

- **Furniture under named pages.** Named pages remain a scope boundary
  (findings 03): multicol cannot express per-page geometry, so furniture
  interacting with them is untested and blocked on that.
- **The other 10 margin slots.** Only the six left/centre/right boxes at top and
  bottom are placed; the corner slots (`@top-left-corner` and friends) and the
  side slots are read and reported as unplaced rather than silently dropped.
- **Vertical centring residual** of 0.46 px — the font box is centred in the
  margin band, which is close but not exactly Chromium's rule.
- Margin-box `border`, `background`, `padding` and `vertical-align`.
- Reservation still assumes constant furniture height, now known to bind only
  on `thead`/`tfoot`.
