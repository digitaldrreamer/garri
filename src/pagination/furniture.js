/**
 * Page furniture layer.
 *
 * Pagination splits into two independent questions:
 *
 *   the multicolumn oracle  ->  WHERE does fragmented flow content go?
 *   this layer              ->  WHAT must independently appear on each
 *                               physical page?
 *
 *        Page
 *         |- flow content        (oracle)
 *         `- furniture           (here)
 *              |- fixed elements
 *              |- repeated table header
 *              |- repeated table footer
 *              `- future running headers / footers
 *
 * Page furniture is content that paged media repeats or re-geometries per page,
 * which column fragmentation does not handle. This layer covers fixed elements,
 * repeated table sections, running headers, and page numbers.
 *
 * Three responsibilities, in order:
 *   DETACH   take furniture out of the flow before the oracle measures, so it
 *            cannot pollute column indexing
 *   RESERVE  give the oracle back the height the furniture will occupy, so page
 *            ASSIGNMENT is right and not just appearance
 *   EMIT     re-issue the furniture on every page it belongs to
 *
 * Installs globalThis.__pdf_furniture.
 */
(function () {
  const SPACER_ATTR = 'data-pdf-furniture-spacer';

  // ------------------------------------------------------- @page margin boxes
  //
  // Verified against Chromium rather than assumed: it fully supports
  // @top-center / @bottom-right / ... and counter(page) / counter(pages), and
  // exposes each as a CSSMarginRule through the CSSOM -- `.name` gives the slot
  // and `.style.content` the raw value. Static strings arrive resolved and
  // counters do not, matching generated pseudo-element content.
  //
  // Margin boxes live in the @page MARGIN, outside the content box, so unlike
  // repeated table sections they need EMIT but no RESERVE: they consume no
  // content height, and the constant-height assumption does not apply to them.

  // A margin box does NOT inherit from <body> -- it lives in the page context,
  // so its font falls back to the INITIAL value, not the document's. Measured
  // against Chromium: 16px serif reproduces its margin-box text widths to
  // 0.01px total across three strings, where the body's 11px sans-serif was
  // out by up to 42px (which then threw centred and right-aligned boxes off by
  // half and all of that error respectively).
  const MARGIN_BOX_DEFAULT_FONT = { size: 16, family: 'serif', weight: '400', style: 'normal' };

  const MARGIN_SLOTS = new Set([
    'top-left', 'top-center', 'top-right',
    'bottom-left', 'bottom-center', 'bottom-right',
  ]);

  /**
   * Every @page rule, keyed by name ('' = the default page).
   *
   * Named pages were recorded as a scope boundary. They are not: the CSSOM
   * exposes each rule's `size`, `margin` and its own margin boxes, and
   * `getComputedStyle(el).page` names the run an element belongs to. That is
   * everything needed to split a document into runs of uniform page geometry
   * and fragment each independently.
   */
  function pageRules() {
    const byName = new Map();
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      if (!rules) continue;
      for (const rule of rules) {
        if (!rule.cssRules || !/^@page/.test(rule.cssText || '')) continue;
        // selectorText is '' for the default page, 'wide' for a named page,
        // ':first' / ':left' / ':right' for the pseudo-class rules. All three
        // kinds cascade together, so they are kept separately and merged per
        // page rather than collapsed here.
        const name = (rule.selectorText || '').trim();
        byName.set(name, {
          name,
          size: rule.style.size || '',
          margin: rule.style.margin || '',
          boxes: [...(rule.cssRules || [])]
            .filter((c) => c.name && MARGIN_SLOTS.has(c.name))
            .map((c) => ({
              kind: 'margin-box', slot: c.name, content: c.style && c.style.content,
              font: {
                family: (c.style.fontFamily || '').trim(),
                size: parseFloat(c.style.fontSize) || null,
                weight: c.style.fontWeight || '',
                style: c.style.fontStyle || '',
              },
              color: c.style.color || '',
              unsupportedSlot: false,
            })),
        });
      }
    }
    return byName;
  }

  /**
   * The @page rules that apply to one page, merged.
   *
   * Verified against Chromium: page 1 of a document with a default rule, a
   * `:first` rule and a `:right` rule shows content from ALL THREE at once, so
   * these cascade per margin slot rather than one rule winning outright.
   * Order is least to most specific: default, spread side, :first, named.
   * `:right` is odd-numbered pages, `:left` even.
   */
  function rulesForPage(rules, pageName, pageIndex) {
    const order = ['', (pageIndex % 2 === 0) ? ':right' : ':left'];
    if (pageIndex === 0) order.push(':first');
    if (pageName) order.push(pageName);

    const bySlot = new Map();
    let size = '', margin = '';
    for (const key of order) {
      const r = rules.get(key);
      if (!r) continue;
      if (r.size) size = r.size;
      if (r.margin) margin = r.margin;
      for (const b of r.boxes) {
        const prior = bySlot.get(b.slot);
        if (!prior) { bySlot.set(b.slot, b); continue; }
        // Margin-box declarations cascade property-by-property. A :first rule
        // that only changes color must retain the default rule's content,
        // family and size; replacing the whole slot made it black and 16px.
        bySlot.set(b.slot, {
          ...prior,
          ...b,
          content: b.content || prior.content,
          color: b.color || prior.color,
          font: {
            family: b.font.family || prior.font.family,
            size: b.font.size || prior.font.size,
            weight: b.font.weight || prior.font.weight,
            style: b.font.style || prior.font.style,
          },
        });
      }
    }
    return {
      size, margin,
      boxes: [...bySlot.values()]
        .filter((b) => b.content && b.content !== 'none' && b.content !== 'normal'),
    };
  }

  /**
   * Split a root into consecutive runs of uniform page geometry.
   *
   * Named runs NEST: a `page: tall` block inside a `page: wide` block produces
   * wide, then tall, then wide again — Chromium resumes the outer run after the
   * inner one. So this walks the tree in document order rather than only the
   * top-level children, grouping consecutive content by its effective page
   * name.
   *
   * A change of page context always forces a page break (verified: a
   * single-line paragraph before a named run still occupied a whole page), so
   * run boundaries and page boundaries coincide.
   */
  function segmentByPage(root) {
    // `page` is NOT inherited in Chrome -- a descendant of a `page: wide`
    // block reports "auto", not "wide". The effective run therefore comes from
    // the nearest self-or-ancestor carrying a non-auto value.
    const pageOf = (el) => {
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const v = getComputedStyle(n).page;
        if (v && v !== 'auto') return v.trim();
      }
      return '';
    };
    const items = [];
    (function visit(el) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const hasOwnText = [...el.childNodes]
        .some((n) => n.nodeType === 3 && n.data.trim());
      if (hasOwnText || !el.children.length) items.push({ el, page: pageOf(el) });
      for (const child of el.children) visit(child);
    })(root);

    const runs = [];
    for (const it of items) {
      const last = runs[runs.length - 1];
      if (last && last.page === it.page) last.elements.push(it.el);
      else runs.push({ page: it.page, elements: [it.el] });
    }
    return runs;
  }

  function marginBoxes() {
    const out = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }   // cross-origin
      if (!rules) continue;
      for (const rule of rules) {
        if (!rule.cssRules || !/^@page/.test(rule.cssText || '')) continue;
        for (const child of rule.cssRules) {
          const name = child.name;
          if (!name || !MARGIN_SLOTS.has(name)) continue;
          const content = child.style && child.style.content;
          if (!content || content === 'none' || content === 'normal') continue;
          out.push({
            kind: 'margin-box', slot: name, content,
            font: {
              family: (child.style.fontFamily || '').trim(),
              size: parseFloat(child.style.fontSize) || null,
              weight: child.style.fontWeight || '',
              style: child.style.fontStyle || '',
            },
            color: child.style.color || '',
            unsupportedSlot: false,
          });
        }
        // slots we do not place, reported rather than dropped
        for (const child of rule.cssRules) {
          if (child.name && !MARGIN_SLOTS.has(child.name)) {
            out.push({ kind: 'margin-box', slot: child.name, content: null, unsupportedSlot: true });
          }
        }
      }
    }
    return out;
  }

  /** Resolve a margin box's content for one page. */
  function resolveMarginContent(content, pageNumber, pageCount) {
    let text = '';
    let unresolved = null;
    const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|counter\(\s*([a-zA-Z-]+)\s*(?:,\s*([a-zA-Z-]+))?\s*\)|(\S+)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      if (m[1] !== undefined) text += m[1].replace(/\\(.)/g, '$1');
      else if (m[2] !== undefined) text += m[2].replace(/\\(.)/g, '$1');
      else if (m[3] !== undefined) {
        if (m[3] === 'page') text += String(pageNumber);
        else if (m[3] === 'pages') text += String(pageCount);
        else unresolved = m[3];
      } else if (m[5] && m[5] !== 'normal') unresolved = m[5];
    }
    return { text, unresolved };
  }

  /**
   * Where a margin box sits, in page CSS px.
   * Horizontal follows the CONTENT box (left / centred / right); vertical
   * centres the font box within the margin band.
   */
  function marginBoxPlacement(slot, page, metrics) {
    const top = slot.startsWith('top');
    const bandTop = top ? 0 : page.h - page.marginBottom;
    const bandH = top ? page.marginTop : page.marginBottom;
    const baseline = bandTop + (bandH - (metrics.ascent + metrics.descent)) / 2 + metrics.ascent;
    const contentL = page.marginLeft;
    const contentR = page.w - page.marginRight;
    return { baseline, contentL, contentR, align: slot.split('-')[1] };
  }


  function identify(root) {
    const fixed = [];
    const tables = [];

    for (const el of root.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;

      // position: fixed repeats on every printed page, and in a multicolumn
      // container it also positions against the viewport rather than the
      // container -- which invents columns that do not exist.
      if (cs.position === 'fixed') {
        const r = el.getBoundingClientRect();
        fixed.push({ kind: 'fixed', el, rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
      }
    }

    for (const table of root.querySelectorAll('table')) {
      const thead = table.querySelector(':scope > thead');
      const tfoot = table.querySelector(':scope > tfoot');
      const headRepeats = thead && getComputedStyle(thead).display === 'table-header-group';
      const footRepeats = tfoot && getComputedStyle(tfoot).display === 'table-footer-group';
      if (!headRepeats && !footRepeats) continue;
      tables.push({
        kind: 'table', table,
        head: headRepeats ? thead : null,
        foot: footRepeats ? tfoot : null,
        headH: headRepeats ? thead.getBoundingClientRect().height : 0,
        footH: footRepeats ? tfoot.getBoundingClientRect().height : 0,
      });
    }
    return { fixed, tables };
  }

  /**
   * Remove furniture from the flow the oracle is about to measure.
   * Fixed elements are the ones that actively corrupt it; repeated table
   * sections stay in place because their FIRST occurrence is real flow content.
   */
  function detach(furniture) {
    const restore = [];
    for (const f of furniture.fixed) {
      restore.push([f.el, f.el.style.display]);
      f.el.style.display = 'none';
    }
    return () => { for (const [el, d] of restore) el.style.display = d; };
  }

  /**
   * Give back the height the repeated sections will consume.
   *
   * A continuation page carries a header the oracle never accounted for, so
   * every row below it shifts and — near a boundary — lands on the wrong page.
   * Where the break falls depends on the reservation, and the reservation
   * depends on where the break falls, so this iterates until the set of
   * column-leading rows stops moving. Two or three passes in practice.
   */
  function reserve(furniture, measureColumns, maxPasses = 6) {
    clearSpacers();
    let passes = 0;
    let previous = '';

    for (; passes < maxPasses; passes++) {
      const cols = measureColumns();
      const signature = [];
      const wanted = [];

      for (const t of furniture.tables) {
        const rows = [...t.table.querySelectorAll('tbody > tr')]
          .filter((tr) => !tr.hasAttribute(SPACER_ATTR));
        if (!rows.length) continue;

        // the first body row landing in each column after the table's first
        const seen = new Map();
        for (const tr of rows) {
          const c = cols(tr);
          if (c === null) continue;
          if (!seen.has(c)) seen.set(c, tr);
        }
        // last body row landing in each column, for footer reservation
        const lastIn = new Map();
        for (const tr of rows) {
          const c = cols(tr);
          if (c !== null) lastIn.set(c, tr);
        }

        const columns = [...seen.keys()].sort((a, b) => a - b);
        // The signature must capture WHICH ROWS sit in each column, not merely
        // which columns the table spans. Tracking the span alone declares
        // convergence while rows are still moving.
        signature.push(columns.map((c) => `${c}:${rows.indexOf(seen.get(c))}`).join(','));

        // A repeated HEADER occupies the top of every continuation column, so
        // reserve before that column's first row.
        if (t.head) {
          for (const c of columns.slice(1)) {
            wanted.push({ before: seen.get(c), height: t.headH });
          }
        }
        // A repeated FOOTER occupies the bottom of every column except the
        // last, so reserving at the top of the next column would be wrong --
        // it has to push the trailing row out of the column it sits in.
        if (t.foot) {
          for (const c of columns.slice(0, -1)) {
            const tr = lastIn.get(c);
            if (tr) wanted.push({ before: tr, height: t.footH });
          }
        }
      }

      const sig = signature.join('|');
      if (sig === previous) break;                    // stable
      previous = sig;

      clearSpacers();
      for (const w of wanted) {
        if (!w.before || !w.before.parentNode) continue;
        const cells = w.before.children.length || 1;
        const tr = document.createElement('tr');
        tr.setAttribute(SPACER_ATTR, '1');
        const td = document.createElement('td');
        td.setAttribute('colspan', String(cells));
        td.style.cssText = `padding:0;border:0;height:${w.height}px;`;
        tr.appendChild(td);
        // break-before: avoid keeps the spacer with the row it reserves for
        tr.style.cssText = 'break-after:avoid;';
        w.before.parentNode.insertBefore(tr, w.before);
      }
    }
    return { passes, spacers: document.querySelectorAll(`[${SPACER_ATTR}]`).length };
  }

  /**
   * Forced page breaks -> column breaks, for the oracle.
   *
   * `page` is not the only value that breaks a page: Chromium also breaks on
   * `left`, `right`, `recto`, `verso` and legacy `always`. Translating only
   * `page` silently under-fragments — a `break-before: right` produced one
   * column where Chromium produced two pages.
   *
   * Note Chromium does NOT generate a blank verso for `left`/`right`; it treats
   * them as an ordinary forced break, so mapping them all to `column` matches.
   */
  const PAGE_BREAK_VALUES = /^(page|left|right|recto|verso|always)$/;

  function translatePageBreaks(root) {
    let n = 0;
    for (const el of root.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (PAGE_BREAK_VALUES.test(cs.breakBefore)) { el.style.breakBefore = 'column'; n++; }
      if (PAGE_BREAK_VALUES.test(cs.breakAfter)) { el.style.breakAfter = 'column'; n++; }
    }
    return n;
  }

  function clearSpacers() {
    for (const el of document.querySelectorAll(`[${SPACER_ATTR}]`)) el.remove();
  }

  /**
   * What must be drawn on each page, beyond the flow content.
   * `columnOf(el)` maps an element to its page index; `pageCount` bounds the
   * fixed elements, which appear on every page.
   */
  /** Individual text pieces, not textContent -- adjacent cells concatenate. */
  function textsOf(el) {
    const out = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = w.nextNode())) { const t = n.data.trim(); if (t) out.push(t); }
    return out;
  }

  function emit(furniture, columnOf, pageCount) {
    const perPage = Array.from({ length: pageCount }, () => []);

    for (const f of furniture.fixed) {
      for (let p = 0; p < pageCount; p++) {
        perPage[p].push({ kind: 'fixed', el: f.el, rect: f.rect, texts: textsOf(f.el) });
      }
    }

    for (const t of furniture.tables) {
      const rows = [...t.table.querySelectorAll('tbody > tr')]
        .filter((tr) => !tr.hasAttribute(SPACER_ATTR));
      const byCol = new Map();
      for (const tr of rows) {
        const c = columnOf(tr);
        if (c === null) continue;
        if (!byCol.has(c)) byCol.set(c, []);
        byCol.get(c).push(tr);
      }
      const cols = [...byCol.keys()].sort((a, b) => a - b);
      cols.forEach((c, i) => {
        if (i === 0) return;                          // first page: real flow content
        const first = byCol.get(c)[0];
        const last = byCol.get(c)[byCol.get(c).length - 1];
        // Only the HEADER is re-issued on continuations. The footer's own flow
        // position already lands on the final page, so re-issuing it here would
        // paint it twice there.
        if (t.head) perPage[c]?.push({ kind: 'table-header', el: t.head, anchor: first, height: t.headH, texts: textsOf(t.head) });
      });
      // a repeated footer also belongs at the foot of every earlier page
      if (t.foot) {
        cols.slice(0, -1).forEach((c) => {
          const last = byCol.get(c)[byCol.get(c).length - 1];
          perPage[c]?.push({ kind: 'table-footer', el: t.foot, anchor: last, height: t.footH, texts: textsOf(t.foot) });
        });
      }
    }
    return perPage;
  }

  globalThis.__pdf_furniture = {
    identify, detach, reserve, emit, clearSpacers, SPACER_ATTR,
    marginBoxes, resolveMarginContent, marginBoxPlacement,
    pageRules, segmentByPage, rulesForPage, translatePageBreaks,
    MARGIN_BOX_DEFAULT_FONT,
  };
})();
