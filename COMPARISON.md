# Garri vs Chromium — Kami demo documents

Comparison of Chromium vs Garri when tested on native PDF generation of
[Kami demo documents](https://github.com/tw93/Kami/tree/main/assets/demos).

For each demo, the same page in the same browser produces two PDFs: Chromium's
own `printToPDF` and Garri's. They are rasterised at 110 dpi and compared pixel
by pixel. Generated PDFs, page images, and red/blue diff images are written to
the ignored `kami/out/` directory.

Reproduction requires Node.js 22.13 or newer, Chrome, `pdftoppm`, `curl`,
and the GitHub CLI (`gh`). Then run:

```bash
npm install
npm run build
sh kami/fetch-assets.sh
node experiments/kami-compare.js
node experiments/kami-compare.js --fair-fonts
node experiments/kami-report.js
```

## Summary

| Demo | Chromium | Garri | Pages | Worst diff | …with an embeddable font | Time |
| --- | ---: | ---: | :---: | ---: | ---: | ---: |
| [demo-agent-slides](https://github.com/tw93/Kami/blob/main/assets/demos/demo-agent-slides.html) | 8 | 8 | ✅ | 2.64 % | 0.68 % | 132 ms |
| [demo-changelog](https://github.com/tw93/Kami/blob/main/assets/demos/demo-changelog.html) | 1 | 1 | ✅ | 4.58 % | 0.53 % | 78 ms |
| [demo-kaku](https://github.com/tw93/Kami/blob/main/assets/demos/demo-kaku.html) | 8 | 8 | ✅ | 4.79 % | 4.67 % | 233 ms |
| [demo-kami-print](https://github.com/tw93/Kami/blob/main/assets/demos/demo-kami-print.html) | 1 | 1 | ✅ | 1.94 % | 1.34 % | 166 ms |
| [demo-letter](https://github.com/tw93/Kami/blob/main/assets/demos/demo-letter.html) | 1 | 1 | ✅ | 1.83 % | 1.81 % | 146 ms |
| [demo-mole](https://github.com/tw93/Kami/blob/main/assets/demos/demo-mole.html) | 1 | 1 | ✅ | 3.19 % | 1.31 % | 159 ms |
| [demo-musk-resume](https://github.com/tw93/Kami/blob/main/assets/demos/demo-musk-resume.html) | 2 | 2 | ✅ | 5.99 % | 2.40 % | 69 ms |
| [demo-resume-ko](https://github.com/tw93/Kami/blob/main/assets/demos/demo-resume-ko.html) | 2 | 2 | ✅ | 5.21 % | 5.20 % | 1447 ms |
| [demo-tesla](https://github.com/tw93/Kami/blob/main/assets/demos/demo-tesla.html) | 2 | 2 | ✅ | 3.36 % | 2.55 % | 263 ms |
| [demo-waza](https://github.com/tw93/Kami/blob/main/assets/demos/demo-waza.html) | 1 | 1 | ✅ | 4.32 % | 1.37 % | 82 ms |


The last column re-runs each document with the same embeddable Latin, CJK, and
Korean font families forced on both sides. That separates layout reproduction
from font availability and glyph substitution. Across every page:

| | Worst | Median | Mean |
| --- | ---: | ---: | ---: |
| As authored | 5.99 % | 2.64 % | 2.88 % |
| Embeddable font | 5.20 % | 1.01 % | 1.42 % |

**Forcing an embeddable face removes 51 % of the mean difference.**
The remaining difference includes sub-pixel placement, glyph rasterisation,
and unsupported features.

The headline difference counts pixels whose worst colour channel differs by
more than **32**/255, avoiding noise from antialiasing. The generated result
also records a **2**/255 threshold for inspecting broad, low-contrast changes;
the worst page measures 10.04 % at that threshold.

**10 of 10** demos paginate to exactly the same page count as
Chromium. Worst single page difference across all of them: **5.99 %**; median **2.64 %**.
