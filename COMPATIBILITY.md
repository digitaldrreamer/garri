# Compatibility

Garri runs inside a browser page with a live DOM. It does not render HTML in
Node.js and does not launch a browser.

## Tested environment

| Environment | Status |
| --- | --- |
| Chrome for Testing 152 on macOS arm64 | Tested |
| Other Chromium versions and platforms | Not yet verified |
| Safari and Firefox | Not yet verified |
| Node.js without a browser DOM | Not supported |

The package includes ES module, CommonJS and browser-script builds. These are
module formats, not separate rendering environments: every build still needs
browser layout APIs.

## Fonts and writing systems

Fonts declared with accessible `@font-face` URLs can be embedded. Font and
stylesheet requests must satisfy the page's origin and CORS rules. When font
bytes are unavailable, Garri substitutes a standard PDF font and returns a
`PDF_FONT_SUBSTITUTED` diagnostic.

Arabic and Devanagari cluster shaping is not currently reliable. Joined Arabic
letters, Devanagari conjuncts and vowel marks may overlap in the generated PDF.
Hebrew and Latin-script text do not require the same contextual joining, but
documents should still be checked before publication.

See the [README quick start](README.md#quick-start) for setup guidance and
[FEATURES.md](FEATURES.md) for the full support matrix and known caveats.
