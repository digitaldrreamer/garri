# Findings 17 — Version check (two builds, not a sweep)

**Status:** no measured quantity moved between m148 and m152
**Date:** 2026-08-29
**Scope:** deliberately narrow — see §3

Run: `node experiments/version-sweep.js`

---

## 1. What this is, and what it is not

The documentary pass ([`evidence-classes.md`](evidence-classes.md)) left three
claims in class `U`: the A4 page box, the dashed-border dash/gap rule, and list
marker placement. Those are Blink *behaviour* rather than compile-time
constants, so reading the source could not settle them.

A version sweep across six majors was proposed and **abandoned**: it required
downloading several hundred megabytes of browsers, which was more than the
question was worth. What follows ran against the two Chrome for Testing builds
already installed on this machine.

**Two builds four majors apart is a spot check, not a sweep.** It can falsify
"these rules are stable"; it cannot establish it. The class-`U` rows stay open.

---

## 2. Result

Chrome for Testing **148.0.7778.97** and **152.0.7977.54**, macOS arm64:

| Quantity | m148 | m152 |
| --- | --- | --- |
| A4 page box | 594.960 × 841.920 pt | identical |
| Marker offset, 12 px | 12.875 px | identical |
| Marker offset, 16 px | 17.156 px | identical |
| Marker offset, 24 px | 25.734 px | identical |
| Marker offset, 32 px | 34.312 px | identical |
| Dash/gap, 1 px border | 3 / 2.034 | identical |
| Dash/gap, 2 px | 6 / 4.138 | identical |
| Dash/gap, 3 px | 6 / 2.909 | identical |
| Dash/gap, 4 px | 8 / 4.167 | identical |
| Dash/gap, 6 px | 12 / 6 | identical |
| Dash/gap, 8 px | 16 / 7.667 | identical |
| Dash/gap, 4 px @ 100 px side | 8 / 3.5 | identical |
| Dash/gap, 4 px @ 137 px side | 8 / 3.727 | identical |

Nothing moved. The 1 px row reproduces findings 10's thin-border special case
(dash 3, not 2 × border width).

### The controls held

These ride along on purpose. If either moved, the source-level reasoning
published in the documentary pass would be **wrong**, and this is where that
would surface.

| Control | m148 | m152 |
| --- | --- | --- |
| `baseline = top + ascent` vs printed PDF, 5 lines | −1.13 × 10⁻⁵ px | identical |
| Oracle vs `printToPDF` page assignment | 3/3 pages, character-exact | identical |

---

## 3. Limits, stated plainly

- **Two builds.** m148 and m152. No older build, no beta, no dev. The span is
  four majors, roughly five months.
- **One platform, one architecture.** macOS arm64, as everywhere else here.
- **The A4 page box is confirmed, not explained.** 594.960 × 841.920 pt is
  reproduced on both builds, but the mm→pt rounding rule that produces it has
  still not been located in Chromium source. A rule you cannot derive is a rule
  that can change without warning.

---

## 4. Three harness bugs, two of them repeats

Recorded because the pattern is the most durable finding in this programme:
**the measurement is the thing most likely to be wrong.**

1. **The drift control measured nothing.** It compared screen layout against
   `emulateMediaType('print')` at the same viewport — which does not change
   layout width, so the two were trivially equal and reported 0.0000 px.
   Replaced with a real comparison: the screen-derived prediction against the
   printed PDF's own text origin, across every probe line.
2. **A `y >= 0` filter hid the first row** — the exact bug findings 10 already
   recorded, reintroduced from scratch. It is why the 1 px dashed case showed
   no data. Fixed; it now recovers 3 / 2.034.
3. **The oracle probe conflated fragmentation with furniture.** It used
   `gate4-pagination.html`, which carries a repeating `<thead>`, and reported
   1/3 page agreement — which reads as a version regression but is the known
   furniture gap from findings 02/03. Switched to plain flow, where the raw
   oracle is what is actually being claimed: 3/3, character-exact.

The harness also reports how many builds it compared and names any that failed
to run, so a sweep where most builds died cannot read as a clean pass.
