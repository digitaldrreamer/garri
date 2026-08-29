/**
 * Form control capture.
 *
 * A form control has no PDF drawing equivalent, but it does have a PDF
 * *object* equivalent: AcroForm fields. Rasterising one would throw away the
 * only thing that makes it a control, so these map across as real fields and
 * the PDF stays fillable.
 *
 * Installs globalThis.__pdf_extractForms(root).
 */
(function () {
  /** Only what AcroForm can actually express. */
  const TEXTUAL = /^(text|email|url|tel|search|password|number|date|time|month|week|datetime-local)$/;

  function extractForms(root) {
    const out = [];
    let seq = 0;

    for (const el of root.querySelectorAll('input, textarea, select')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;

      const tag = el.tagName.toLowerCase();
      const type = tag === 'input' ? (el.type || 'text').toLowerCase() : tag;

      // A stable, unique field name: PDF requires uniqueness, the DOM does not.
      const name = `${el.name || el.id || type}_${seq++}`;
      const base = {
        name,
        label: el.getAttribute('aria-label') || el.name || el.id || '',
        box: { x: r.left, y: r.top, w: r.width, h: r.height },
        readOnly: el.readOnly || el.disabled,
        required: el.required,
        fontSize: parseFloat(cs.fontSize) || 12,
      };

      if (tag === 'textarea') {
        out.push({ ...base, kind: 'text', value: el.value || '', multiline: true });
      } else if (tag === 'select') {
        const options = [...el.options].map((o) => o.text);
        if (!options.length) continue;
        out.push({
          ...base,
          kind: el.multiple ? 'unsupported' : 'dropdown',
          reason: el.multiple ? 'multi-select' : undefined,
          options,
          value: el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : options[0],
        });
      } else if (type === 'checkbox') {
        out.push({ ...base, kind: 'checkbox', checked: el.checked });
      } else if (type === 'radio') {
        out.push({ ...base, kind: 'radio', group: el.name || name, checked: el.checked,
          value: el.value || 'on' });
      } else if (TEXTUAL.test(type)) {
        out.push({ ...base, kind: 'text', value: el.value || '', multiline: false });
      } else {
        // submit, button, file, colour, range: no faithful AcroForm equivalent.
        out.push({ ...base, kind: 'unsupported', reason: type });
      }
    }
    return out;
  }

  globalThis.__pdf_extractForms = extractForms;
})();
