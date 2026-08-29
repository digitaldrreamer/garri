# Third-party notices

The MIT licence in [`LICENSE`](LICENSE) covers this project's own source. The
following third-party material is redistributed here under its own terms.

## Fonts in `fixtures/`

Test fixtures only — none of these is required to use the library, and none is
included in any `dist/` bundle. Identified from each file's own `name` table
rather than assumed.

| File | Family | Licence |
| --- | --- | --- |
| `font.ttf` | Roboto | Apache License 2.0 |
| `NotoSansArabic-Regular.ttf` | Noto Sans Arabic | SIL Open Font License 1.1 |
| `NotoSansDevanagari-Regular.ttf` | Noto Sans Devanagari | SIL Open Font License 1.1 |
| `NotoSansHebrew-Regular.ttf` | Noto Sans Hebrew | SIL Open Font License 1.1 |
| `Tinos-Regular.ttf` | Tinos | SIL Open Font License 1.1 |

- Apache License 2.0 — https://www.apache.org/licenses/LICENSE-2.0
- SIL Open Font License 1.1 — https://openfontlicense.org

Under the OFL these files may be redistributed provided they are not sold on
their own and the licence travels with them. Under Apache 2.0 the licence and
any notices must be retained.

## Bundled into `dist/peedeeeff.standalone.js`

The standalone build vendors its two runtime dependencies so a page needs only
one script tag. Both are MIT, the same licence as this project.

| Package | Licence |
| --- | --- |
| [`pdf-lib`](https://github.com/Hopding/pdf-lib) | MIT |
| [`@pdf-lib/fontkit`](https://github.com/Hopding/fontkit) | MIT |

The smaller `dist/peedeeeff.js` and `dist/peedeeeff.mjs` builds vendor nothing;
they declare both as `peerDependencies`.

## Development only

`puppeteer`, `pdfjs-dist` and `regenerator-runtime` are `devDependencies` —
the test oracle, never shipped.
