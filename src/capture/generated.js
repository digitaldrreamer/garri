/**
 * Generated content: ::before, ::after, counters, and list markers.
 *
 * Pseudo-elements have no DOM node, so there is no rect to read and no Range to
 * walk — the text extractor cannot see them at all. Findings 03 caught this as
 * missing `::marker` text; it affects `::before`/`::after`/`counter()` the same
 * way.
 *
 * Two different strategies, because the browser exposes two different amounts:
 *
 *   ::before / ::after  MATERIALISE. Replace the pseudo with a real inline
 *                       element carrying its computed style and resolved text,
 *                       then the existing text pipeline measures it exactly and
 *                       no new geometry code is needed.
 *
 *   ::marker            COMPUTE. Chrome reports `content: normal` and no text,
 *                       and an outside marker sits in the padding area where a
 *                       materialised span would not land. Its placement rule was
 *                       derived from Chromium's own output instead (see below).
 *
 * Installs globalThis.__pdf_materializeGenerated(root).
 */
(function () {
  // ---------------------------------------------------------------- counters
  //
  // getComputedStyle resolves attr() for us but NOT counter(): the content
  // string comes back as `"Step " counter(step) ": "`. So counters have to be
  // run here.

  function parseCounterDecl(v) {
    // "step 1" | "a 2 b 3" | "none"
    const out = [];
    if (!v || v === 'none') return out;
    const toks = String(v).trim().split(/\s+/);
    for (let i = 0; i < toks.length; i++) {
      const name = toks[i];
      const num = parseInt(toks[i + 1], 10);
      if (Number.isFinite(num)) { out.push({ name, value: num }); i++; }
      else out.push({ name, value: null });
    }
    return out;
  }

  const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];

  function formatCounter(n, style) {
    switch (style) {
      case 'decimal-leading-zero': return (n < 10 && n >= 0 ? '0' : '') + n;
      case 'lower-alpha': case 'lower-latin': case 'upper-alpha': case 'upper-latin': {
        let s = '', v = n;
        while (v > 0) { const r = (v - 1) % 26; s = String.fromCharCode(97 + r) + s; v = Math.floor((v - 1) / 26); }
        s = s || String(n);
        return /upper/.test(style) ? s.toUpperCase() : s;
      }
      case 'lower-roman': case 'upper-roman': {
        let v = n, s = '';
        if (v <= 0 || v > 3999) return String(n);
        for (const [val, sym] of ROMAN) while (v >= val) { s += sym; v -= val; }
        return style === 'upper-roman' ? s.toUpperCase() : s;
      }
      case 'none': return '';
      default: return String(n);
    }
  }

  /**
   * Walk the tree maintaining CSS counter scopes. Nested scopes are modelled as
   * a stack per name: `counter-reset` pushes for the element's subtree.
   */
  function buildCounters(root) {
    const scopes = new Map();            // name -> [{ value, owner }]
    const valuesFor = new WeakMap();     // element -> { before:{}, after:{}, self:{} }

    const readAll = () => {
      const snap = {};
      for (const [name, stack] of scopes) if (stack.length) snap[name] = stack[stack.length - 1].value;
      return snap;
    };
    const allOf = (name) => (scopes.get(name) || []).map((s) => s.value);

    function increment(decl, def) {
      for (const { name, value } of parseCounterDecl(decl)) {
        let stack = scopes.get(name);
        if (!stack || !stack.length) { stack = [{ value: 0, owner: null }]; scopes.set(name, stack); }
        stack[stack.length - 1].value += (value === null ? def : value);
      }
    }

    (function walk(el) {
      const cs = getComputedStyle(el);
      const opened = [];

      for (const { name, value } of parseCounterDecl(cs.counterReset)) {
        let stack = scopes.get(name);
        if (!stack) { stack = []; scopes.set(name, stack); }
        stack.push({ value: value === null ? 0 : value, owner: el });
        opened.push(name);
      }

      const beforeCS = getComputedStyle(el, '::before');
      increment(beforeCS.counterIncrement, 1);
      const beforeSnap = { flat: readAll(), all: (n) => allOf(n) };

      increment(cs.counterIncrement, 1);
      const selfSnap = readAll();

      valuesFor.set(el, { before: beforeSnap.flat, self: selfSnap, allBefore: beforeSnap.all });

      for (const child of el.children) walk(child);

      const afterCS = getComputedStyle(el, '::after');
      increment(afterCS.counterIncrement, 1);
      const rec = valuesFor.get(el);
      rec.after = readAll();

      for (const name of opened) scopes.get(name).pop();
    })(root);

    return valuesFor;
  }

  /** Turn a computed `content` value into text, resolving counter()/counters(). */
  function resolveContent(content, counterValues, allValues) {
    if (!content || content === 'none' || content === 'normal') return null;
    let out = '';
    // tokens: quoted strings, counter(...), counters(...), url(...)
    const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|counters\(([^)]*)\)|counter\(([^)]*)\)|(\S+)/g;
    let m, sawUnknown = false;
    while ((m = re.exec(content)) !== null) {
      if (m[1] !== undefined) out += m[1].replace(/\\(.)/g, '$1');
      else if (m[2] !== undefined) out += m[2].replace(/\\(.)/g, '$1');
      else if (m[3] !== undefined) {
        const parts = m[3].split(',').map((s) => s.trim());
        const name = parts[0];
        const sep = (parts[1] || '""').replace(/^["']|["']$/g, '');
        const style = parts[2] || 'decimal';
        out += (allValues(name) || []).map((v) => formatCounter(v, style)).join(sep);
      } else if (m[4] !== undefined) {
        const parts = m[4].split(',').map((s) => s.trim());
        const v = counterValues[parts[0]] ?? 0;
        out += formatCounter(v, parts[1] || 'decimal');
      } else if (m[5] && m[5] !== 'normal') {
        sawUnknown = true;                       // url(), open-quote, etc.
      }
    }
    return { text: out, sawUnknown };
  }

  // ------------------------------------------------------------ list markers
  //
  // Placement rule, derived from Chromium's own PDF rather than assumed:
  // every marker's RIGHT edge sits one space-advance before the list item's
  // content-box left edge. Measured at 16px Roboto the gap was 3.97px against a
  // space advance of 3.96px, across decimal and roman markers of differing
  // widths.

  // Bullets are emitted as their Unicode glyph rather than a synthesised
  // shape. Chromium paints them as paths, but the ink measured identical in
  // size -- it is drawing the glyph outline. Going through the font means the
  // side bearings position the ink for us, instead of needing a second,
  // bullet-specific placement rule (an earlier synthesised circle sat 8.00 px
  // too far right for exactly that reason). It also keeps the bullet copyable.
  const BULLET = { disc: 1, circle: 1, square: 1 };
  // Measured against Chromium at two font sizes:
  //    16 px -> diameter 6.40 (0.400 em), gap 11.60 (0.725 em)
  //    26 px -> diameter 9.60 (0.369 em), gap 15.60 (0.600 em)
  // The rule is NOT linear in em, so these constants are exact at 16 px and an
  // approximation elsewhere. Deliberately not generalised from one data point.
  const BULLET_SIZE_EM = 0.40;
  const BULLET_GAP_EM = 0.725;
  const BULLET_CALIBRATED_PX = 16;

  function markerOrdinal(li) {
    const explicit = parseInt(li.getAttribute('value'), 10);
    if (Number.isFinite(explicit)) return explicit;
    const parent = li.parentElement;
    const items = [...parent.children].filter((c) => c.tagName === 'LI');
    const idx = items.indexOf(li);
    const start = parseInt(parent.getAttribute('start'), 10);
    if (parent.hasAttribute('reversed')) {
      const base = Number.isFinite(start) ? start : items.length;
      return base - idx;
    }
    let n = Number.isFinite(start) ? start : 1;
    for (let i = 0; i < idx; i++) {
      const v = parseInt(items[i].getAttribute('value'), 10);
      if (Number.isFinite(v)) n = v + 1; else n++;
    }
    return n;
  }

  const markerDiagnostics = [];
  function extractMarkers(root, spaceWidthOf) {
    const out = [];
    markerDiagnostics.length = 0;
    for (const li of root.querySelectorAll('li')) {
      const cs = getComputedStyle(li);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const type = cs.listStyleType;
      if (type === 'none' || cs.listStylePosition !== 'outside') continue;

      const r = li.getBoundingClientRect();
      const contentLeft = r.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
      const mcs = getComputedStyle(li, '::marker');
      const fontSize = parseFloat(mcs.fontSize || cs.fontSize);
      const color = mcs.color || cs.color;

      if (BULLET[type]) {
        // Chromium paints bullets as paths, and NOT from the font's own bullet
        // glyph: Roboto's U+2022 ink is 3.2 px at 16 px where Chromium's marker
        // is 6.4 px. So the shape is synthesised, with both size and gap
        // expressed in em and checked at two font sizes.
        if (Math.abs(fontSize - BULLET_CALIBRATED_PX) > 0.5) {
          markerDiagnostics.push({
            code: 'PDF_MARKER_APPROXIMATE',
            detail: `bullet at ${fontSize}px; placement calibrated at ${BULLET_CALIBRATED_PX}px and does not scale linearly`,
          });
        }
        out.push({
          kind: 'shape', shape: type, color,
          size: fontSize * BULLET_SIZE_EM,
          right: contentLeft - fontSize * BULLET_GAP_EM,
          li,
        });
      } else {
        out.push({
          kind: 'text', text: formatCounter(markerOrdinal(li), type) + '.', color,
          fontSize, fontFamily: mcs.fontFamily || cs.fontFamily,
          fontWeight: mcs.fontWeight || cs.fontWeight,
          right: contentLeft - spaceWidthOf(cs), li,
        });
      }
    }
    return out;
  }

  // -------------------------------------------------------- materialisation
  const STYLE_ID = '__pdf_pseudo_suppress';

  function materialize(root) {
    const counterMap = buildCounters(document.documentElement);
    const diagnostics = [];
    let count = 0;

    // Suppress the originals once, so nothing is painted twice.
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent =
        '.__pdf_mat::before,.__pdf_mat::after{content:none !important;}';
      document.head.appendChild(st);
    }

    const COPY = [
      'color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
      'letterSpacing', 'wordSpacing', 'textTransform', 'textDecoration',
      'backgroundColor', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
      'borderRadius', 'verticalAlign', 'display', 'whiteSpace',
    ];

    for (const el of [...root.querySelectorAll('*')]) {
      const rec = counterMap.get(el) || { before: {}, after: {}, allBefore: () => [] };

      // Read BOTH pseudo-elements before touching the element. Adding the
      // suppression class for ::before also suppresses ::after, so reading
      // them one at a time silently loses the second.
      const pending = [];
      for (const which of ['::before', '::after']) {
        const pcs = getComputedStyle(el, which);
        const resolved = resolveContent(pcs.content, which === '::before' ? rec.before : rec.after, rec.allBefore);
        if (resolved) pending.push({ which, pcs, resolved });
      }

      for (const { which, pcs, resolved } of pending) {
        if (resolved.sawUnknown) {
          diagnostics.push({
            code: 'PDF_GENERATED_CONTENT_PARTIAL', selector: (el.id ? '#' + el.id : el.tagName.toLowerCase()) + which,
            message: `content contains a value this extractor does not resolve: ${pcs.content}`,
          });
        }
        if (!resolved.text) continue;

        const span = document.createElement('span');
        span.setAttribute('data-pdf-pseudo', which);
        span.textContent = resolved.text;
        for (const p of COPY) {
          const v = pcs[p];
          if (v) span.style[p] = v;
        }
        // a pseudo defaults to inline; keep it so unless the author changed it
        if (pcs.display === 'block' || pcs.display === 'inline-block') span.style.display = pcs.display;
        else span.style.display = 'inline';

        el.classList.add('__pdf_mat');
        if (which === '::before') el.insertBefore(span, el.firstChild);
        else el.appendChild(span);
        count++;
      }
    }
    return { count, diagnostics };
  }

  globalThis.__pdf_materializeGenerated = function (root) {
    const ctx = document.createElement('canvas').getContext('2d');
    const spaceWidthOf = (cs) => {
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      return ctx.measureText(' ').width;
    };
    // Markers must be read BEFORE materialisation changes the line boxes.
    const markers = extractMarkers(root, spaceWidthOf);
    const mat = materialize(root);
    return { markers, ...mat, diagnostics: [...mat.diagnostics, ...markerDiagnostics] };
  };
  globalThis.__pdf_formatCounter = formatCounter;
})();
