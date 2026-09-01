# Contributing

Contributions are welcome. Garri treats the browser as the layout engine and
writes the measured result as native PDF objects, so changes should be checked
against both the browser output and the resulting PDF structure.

## Setup

Development requires Node.js 22.13 or newer.

```bash
npm install
npx puppeteer browsers install chrome
npm run build
npm test
```

Run the interactive demo with:

```bash
npm run demo
```

It is served at `http://127.0.0.1:8080/demo/`.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Build the ESM, CommonJS, browser and standalone bundles |
| `npm test` | Compare the core fixtures with Chromium's PDF output |
| `npm run test:bundle` | Run the assertions through IIFE, ES-module and standalone builds |
| `npm run test:furniture` | Generate the repeating-furniture diagnostic report |
| `npm run test:named-pages` | Generate the named-page diagnostic report |
| `npm run test:scale` | Generate the scale benchmark report |
| `npm run demo` | Build and serve the browser demo |

## Pull requests

- Add or update a focused fixture for rendering behavior changes.
- Compare pagination, extracted text and visual output with Chromium.
- Return a diagnostic for content Garri cannot emit safely.
- Update `FEATURES.md` and `COMPATIBILITY.md` when support changes.
- Do not commit generated or machine-local files listed in `.gitignore`,
  including `dist/`, `out/`, `kami/out/`, `.demo-dist/`, `.wrangler/`, and
  `kami/fonts/`.
- Run the relevant tests and `npm run build` before submitting.

Development notes belong in the ignored `notes/` directory. Public technical
documentation should describe current behavior rather than the chronology of
how it was implemented.
