/**
 * Generate test images. Uses the browser's own encoders so the fixtures are
 * real PNG/JPEG/WebP bytes rather than hand-rolled files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setContent('<canvas id="c"></canvas>');

const out = await page.evaluate(() => {
  const c = document.getElementById('c');
  c.width = 160; c.height = 100;
  const x = c.getContext('2d');
  // four quadrants + a diagonal, so orientation and cropping are obvious
  x.fillStyle = '#2f6f4f'; x.fillRect(0, 0, 80, 50);
  x.fillStyle = '#8a3324'; x.fillRect(80, 0, 80, 50);
  x.fillStyle = '#315b8c'; x.fillRect(0, 50, 80, 50);
  x.fillStyle = '#c26b2a'; x.fillRect(80, 50, 80, 50);
  x.strokeStyle = '#fff'; x.lineWidth = 6;
  x.beginPath(); x.moveTo(0, 0); x.lineTo(160, 100); x.stroke();
  const opaque = { jpg: c.toDataURL('image/jpeg', 0.92), webp: c.toDataURL('image/webp', 0.92) };

  // transparent version: punch a hole so alpha is testable
  x.clearRect(50, 25, 60, 50);
  const png = c.toDataURL('image/png');
  return { png, ...opaque };
});

await browser.close();

for (const [name, dataUrl] of Object.entries(out)) {
  const b64 = dataUrl.split(',')[1];
  const buf = Buffer.from(b64, 'base64');
  const file = path.join(ROOT, 'fixtures', `test.${name}`);
  fs.writeFileSync(file, buf);
  console.log(`${path.basename(file).padEnd(12)} ${String(buf.length).padStart(6)} bytes  ${dataUrl.slice(0, 24)}...`);
}
