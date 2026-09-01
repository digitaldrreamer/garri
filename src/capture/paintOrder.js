/**
 * Static paint-order reconstruction.
 *
 * Plan §12: DOM order is not paint order. Chromium decides painting from
 * stacking contexts, z-index, positioning and a handful of properties that
 * silently create new contexts. None of that is exposed directly — but all of
 * its *inputs* are readable from computed style, so the order can be recomputed
 * rather than observed.
 *
 * This implements the CSS 2.1 Appendix E painting algorithm over the subset a
 * document renderer actually meets. It is the one place in the architecture
 * where we deliberately reimplement browser logic, because there is no API that
 * provides the ordering directly.
 *
 * Installs globalThis.__pdf_paintOrder(root) -> ordered array of elements.
 */
(function () {
  /**
   * Does this element establish a stacking context?
   * Subset of the full list, covering what documents actually use.
   */
  function isStackingContext(el, cs) {
    if (el === document.documentElement) return true;

    const positioned = cs.position !== 'static';
    const zAuto = cs.zIndex === 'auto';

    // Positioned with an explicit z-index.
    if (positioned && !zAuto) return true;
    // Fixed and sticky always do, regardless of z-index.
    if (cs.position === 'fixed' || cs.position === 'sticky') return true;

    if (parseFloat(cs.opacity) < 1) return true;
    if (cs.transform && cs.transform !== 'none') return true;
    if (cs.filter && cs.filter !== 'none') return true;
    if (cs.perspective && cs.perspective !== 'none') return true;
    if (cs.clipPath && cs.clipPath !== 'none') return true;
    if (cs.mask && cs.mask !== 'none' && cs.mask !== 'match-source') return true;
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') return true;
    if (cs.isolation === 'isolate') return true;
    if (cs.contain && /paint|layout|strict|content/.test(cs.contain)) return true;
    if (cs.willChange && /transform|opacity|filter/.test(cs.willChange)) return true;

    // A flex or grid item with an explicit z-index.
    const parent = el.parentElement;
    if (parent && !zAuto) {
      const pd = getComputedStyle(parent).display;
      if (/flex|grid/.test(pd)) return true;
    }
    return false;
  }

  function visible(cs) {
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  function zIndexOf(cs) {
    return cs.zIndex === 'auto' ? null : parseInt(cs.zIndex, 10);
  }

  /**
   * Paint one stacking context, returning its elements in painting order.
   *
   * CSS 2.1 Appendix E, steps that matter for block-level document content:
   *   1. the context root's own background and borders
   *   2. child stacking contexts with negative z-index, most negative first
   *   3. in-flow, non-positioned, block-level descendants
   *   4. non-positioned floats
   *   5. in-flow inline-level descendants
   *   6. positioned descendants with z-index auto/0
   *   7. child stacking contexts with positive z-index, ascending
   */
  function paintStackingContext(root) {
    const flow = [];      // step 3
    const floats = [];    // step 4
    const inlines = [];   // step 5
    const negZ = [];      // step 2
    const zeroZ = [];     // step 6
    const posZ = [];      // step 7

    function walk(el) {
      for (const child of el.children) {
        const cs = getComputedStyle(child);
        if (!visible(cs)) continue;

        const sc = isStackingContext(child, cs);
        const positioned = cs.position !== 'static';
        const z = zIndexOf(cs);

        if (sc) {
          // Atomic: its whole subtree paints together, at its own z position.
          if (z !== null && z < 0) negZ.push({ el: child, z });
          else if (z !== null && z > 0) posZ.push({ el: child, z });
          else zeroZ.push({ el: child, atomic: true });
          continue;
        }

        if (positioned) {
          // Positioned with z-index:auto — paints in step 6, but does NOT
          // establish a context, so its descendants still participate here.
          zeroZ.push({ el: child, atomic: false });
          continue;
        }

        if (cs.float !== 'none') {
          floats.push(child);
          walk(child);
          continue;
        }

        if (/^inline/.test(cs.display)) inlines.push(child);
        else flow.push(child);
        walk(child);
      }
    }

    walk(root);

    negZ.sort((a, b) => a.z - b.z);
    posZ.sort((a, b) => a.z - b.z);

    const out = [root];
    for (const n of negZ) out.push(...paintStackingContext(n.el));
    out.push(...flow, ...floats, ...inlines);
    for (const item of zeroZ) {
      // Both cases paint their subtree here; only a real stacking context
      // re-runs the full algorithm internally.
      out.push(...paintStackingContext(item.el));
    }
    for (const p of posZ) out.push(...paintStackingContext(p.el));
    return out;
  }

  globalThis.__pdf_paintOrder = function (root) {
    return paintStackingContext(root);
  };
  globalThis.__pdf_isStackingContext = isStackingContext;
})();
