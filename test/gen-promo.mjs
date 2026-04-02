import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

async function main() {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    defaultViewport: { width: 440, height: 280 }
  });
  const page = await browser.newPage();
  const htmlPath = path.resolve(__dirname, '..', 'store-assets', 'promo-tile.html');
  const url = `file:///${htmlPath.replace(/\\/g, '/')}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: path.resolve(__dirname, '..', 'store-assets', 'promo-440x280.png') });
  console.log('Promo tile saved');
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
