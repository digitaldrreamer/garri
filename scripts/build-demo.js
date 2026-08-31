import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, ".demo-dist");

const copy = (relativePath) => {
  const destination = join(output, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(root, relativePath), destination);
};

mkdirSync(output, { recursive: true });

const demo = readFileSync(join(root, "demo/index.html"), "utf8")
  .replaceAll("../fixtures/", "./fixtures/")
  .replaceAll("../dist/", "./dist/");

writeFileSync(join(output, "index.html"), demo);

[
  "dist/garri.standalone.js",
  "fixtures/font.ttf",
  "fixtures/Tinos-Regular.ttf",
  "fixtures/NotoSansArabic-Regular.ttf",
  "fixtures/NotoSansHebrew-Regular.ttf",
  "fixtures/NotoSansDevanagari-Regular.ttf",
  "fixtures/test.png",
  "fixtures/test.jpg",
  "fixtures/test.webp",
].forEach(copy);

console.log(`Built the Garri demo in ${output}`);
