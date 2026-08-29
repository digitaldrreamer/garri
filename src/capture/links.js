/**
 * Link extraction.
 *
 * Plan §2: <a> elements should become PDF link annotations, not just styled
 * text. A link that wraps across lines occupies several disjoint rectangles,
 * which is exactly what getClientRects() reports — one annotation per rect.
 *
 * Installs globalThis.__pdf_extractLinks(root).
 */
(function () {
  function extractLinks(root) {
    const out = [];
    for (const el of root.querySelectorAll('a[href]')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;

      const href = el.href;                      // resolved absolute URL
      if (!href || href.startsWith('javascript:')) continue;

      // One rect per line fragment. A wrapped link is several rectangles, and
      // a single bounding box would make dead space clickable.
      const raw = [...el.getClientRects()];

      // getClientRects() on an INLINE anchor reports its line boxes only. A
      // link wrapping an image therefore comes back as a thin text-height
      // strip, leaving the image itself unclickable -- Chromium's own export
      // emits a second annotation for it. Add replaced and non-inline
      // descendants explicitly.
      for (const d of el.querySelectorAll('*')) {
        const ds = getComputedStyle(d);
        if (ds.display === 'none' || ds.visibility === 'hidden') continue;
        const replaced = /^(img|svg|canvas|video|object|iframe|input|button|select|textarea)$/
          .test(d.tagName.toLowerCase());
        if (replaced || ds.display !== 'inline') raw.push(d.getBoundingClientRect());
      }

      const rects = [];
      for (const r of raw) {
        if (r.width <= 0.01 || r.height <= 0.01) continue;
        const box = { x: r.left, y: r.top, w: r.width, h: r.height };
        const dup = rects.some((o) =>
          Math.abs(o.x - box.x) < 0.1 && Math.abs(o.y - box.y) < 0.1 &&
          Math.abs(o.w - box.w) < 0.1 && Math.abs(o.h - box.h) < 0.1);
        if (!dup) rects.push(box);
      }
      if (!rects.length) continue;

      out.push({
        id: el.id || '(a)',
        href,
        internal: href.startsWith(location.origin + location.pathname + '#'),
        text: (el.textContent || '').trim().slice(0, 60),
        rects,
      });
    }
    return out;
  }

  globalThis.__pdf_extractLinks = extractLinks;
})();
