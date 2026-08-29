# Findings 07 — Images and link annotations

**Status:** Gate 5 COMPLETE
**Date:** 2026-08-29
**Chromium:** Google Chrome for Testing 152.0.7977.54 (arm64, headless)
**Scope:** plan §2 (hyperlinks), §20 (images), build-order item 4

The last untested part of Gate 5. Both work, and both turned up a defect that
only a specific case exposes.

Run: `node experiments/make-images.js` then `node experiments/images-links.js`
and `node experiments/image-placement.js`

---

## 1. Result

| | ours | Chromium |
| --- | --- | --- |
| Images painted | 12 | 12 |
| Link annotations | **6** | **6** |
| PDF size | 28.8 KB | 27.8 KB |

Rendered image extents, measured from the raster at 120 dpi:

| object-fit case | Δ extents |
| --- | --- |
| `none` | **0, 0, 0, 0** |
| `scale-down` | **0, 0, 0, 0** |
| `cover` + `object-position` | **0, 0, 0, 0** |
| `fill`, `contain`, `cover` | 1 px on the top edge only |

`border-radius` clipping and a `rotate(-9deg)` transform on images both land at
0 px.

---

## 2. Images are passed through, not re-encoded

Plan §20 asks for native image resources. The original encoded bytes are
embedded wherever the backend accepts them:

| source | bytes | disposition |
| --- | --- | --- |
| `test.png` (with alpha) | 1479 | **PNG passthrough** |
| `test.jpg` | 3221 | **JPEG passthrough** |
| `test.webp` | 2016 | re-encoded to PNG — **9654** |

A JPEG stays a JPEG; its compression is never spent and re-spent.

**WebP is the exception and it is expensive.** pdf-lib can embed PNG and JPEG
only, so WebP goes through a canvas round-trip to PNG — a **4.8× size
increase** on this fixture. That is a real deployment consideration for
image-heavy documents, since WebP is now a common authoring format. It is
reported rather than hidden:

```
PDF_IMAGE_REENCODED  test.webp
  Format not embeddable directly; re-encoded to PNG (2016 -> 9654 bytes).
```

The remedy is a backend that can wrap WebP (or transcoding to JPEG rather than
PNG for opaque images, which would shrink rather than grow).

---

## 3. `object-fit` is computed, and validated against Chromium's own matrices

`object-fit` and `object-position` are not exposed as a resolved rectangle by
any API, so this is one of the few places the CSS algorithm is implemented
rather than observed. It is ~20 lines: pick a scale per keyword, place the
scaled box with `object-position`, and let the content-box clip do the rest —
which is what makes `cover` and `none` correct without special-casing.

To check it independently of rasterisation, `experiments/image-placement.js`
walks both PDFs' operator lists, tracks the CTM through `save`/`restore`/`cm`,
and reads the matrix in force at each image paint. A PDF image occupies the
unit square transformed by that matrix, so **the matrix is the placement**.

| case | Δx | Δy | Δw | Δh |
| --- | --- | --- | --- | --- |
| `fill` | 0.000 | 0.000 | 0.000 | 0.000 |
| natural / jpeg / webp / rounded | 0.000 | 0.000 | 0.000 | 0.000 |
| `contain`, `scale-down` | 0.000 | −0.281 | 0.000 | +0.563 |
| `cover` | −0.525 | 0.000 | +1.050 | 0.000 |
| `none` | −18.750 | −11.250 | +37.500 | +22.500 |

### Chromium crops; we clip

The `none` row looks alarming and is not. For fits that overflow the content
box, **Chromium paints only the visible sub-rectangle of the image**, with a
matrix to match. We paint the whole image and clip it. The two produce the same
pixels by different means, so the matrices are not comparable for overflow
cases — confirmed by the rendered extents in §1, where `none` is exact.

An honest residual: `contain` and `scale-down` differ by **0.563 pt (~0.75 px)**
in destination height, and `cover` by 1.05 pt in width. Rendered extents still
agree to 1 px, but the interior scales by ~1 %, which is why those boxes show
the largest pixel differences in the raster diff. The cause is not established;
Chromium's cropping makes its matrices an unreliable oracle here, so this needs
a different measurement rather than a guess.

---

## 4. The link defect: `getClientRects()` misses replaced descendants

A wrapped link is several rectangles, and `getClientRects()` handles that
correctly — the two-line link produced two annotations, matching Chromium.

But a link **wrapping an image** did not:

```
ours     : 5 annotations
chromium : 6 annotations      <- same 4 URLs
```

Chromium emitted **two** annotations for `<a><img></a>`:

| | rect height |
| --- | --- |
| the anchor's inline line box | 14.3 pt |
| the image's own box | **42.0 pt** (= 56 px) |

`getClientRects()` on an inline anchor reports its *line boxes*. The image is a
replaced element that overflows that line box, so the link's clickable area was
a thin text-height strip across the top of a 56 px-tall image — technically a
link, practically unusable, and silent.

The fix adds replaced and non-inline descendants explicitly, with dedupe:

```js
for (const d of el.querySelectorAll('*')) {
  const ds = getComputedStyle(d);
  const replaced = /^(img|svg|canvas|video|object|iframe|input|button|...)$/.test(d.tagName.toLowerCase());
  if (replaced || ds.display !== 'inline') raw.push(d.getBoundingClientRect());
}
```

After it: 6 annotations, matching Chromium exactly, with per-rect positions
agreeing to ~0.5 pt.

This is the same shape as the RTL word-extent bug in findings 05 — an API that
answers a slightly different question than the one being asked, and only one
specific case reveals the difference.

---

## 5. Not covered

- **CSS `background-image`** — untested; common for logos and letterheads
- `image-rendering`, `srcset` selection beyond `currentSrc`
- SVG images referenced via `<img src="*.svg">`
- CMYK JPEGs, ICC profiles, EXIF orientation
- Internal/fragment link destinations (`/Dest`), only external URIs are emitted
- Link annotation appearance streams (borders, highlight modes)

---

## 6. Gate 5 status

**COMPLETE.** Native text, subset font embedding, vector paths, transforms,
opacity, multi-page output, SVG, **native image passthrough**, and **link
annotations** — all verified against Chromium's own PDF.

The remaining build-order items are the page furniture layer, generated
content, scale testing, and the cross-environment matrix.
