/**
 * Chrome Web Store用スクリーンショット生成
 * 1280x800 のスクリーンショットを3枚生成
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const STORE_DIR = path.join(__dirname, '..', 'store-assets');
const EXT_PATH = path.resolve(__dirname, '..').replace(/\\/g, '/');

if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function activateBH(browser, page) {
  const targets = await browser.targets();
  const swTarget = targets.find(t =>
    t.type() === 'service_worker' && t.url().includes('background.js')
  );
  if (!swTarget) return false;
  const sw = await swTarget.worker();
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
      } catch {
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['styles.css'] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        await new Promise(r => setTimeout(r, 300));
        await chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
      }
    }
  });
  await sleep(1000);
  return true;
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: false,
    args: [
      `--load-extension=${EXT_PATH}`,
      `--disable-extensions-except=${EXT_PATH}`,
      '--window-size=1280,800',
      '--no-first-run',
      '--no-default-browser-check'
    ],
    defaultViewport: { width: 1280, height: 800 }
  });

  const page = await browser.newPage();

  // === Screenshot 1: Wikipedia — テキスト吸い込み中 ===
  console.log('Screenshot 1: Wikipedia');
  await page.goto('https://en.wikipedia.org/wiki/Black_hole', {
    waitUntil: 'networkidle2', timeout: 30000
  });
  await sleep(2000);
  await activateBH(browser, page);
  // 適度にテキストを吸い込む
  for (let y = 200; y < 500; y += 5) {
    await page.mouse.move(500, y);
    await sleep(16);
  }
  for (let x = 200; x < 800; x += 5) {
    await page.mouse.move(x, 350);
    await sleep(16);
  }
  await sleep(500);
  await page.screenshot({ path: path.join(STORE_DIR, 'screenshot-1-wikipedia.png') });
  console.log('  Done');

  // OFF
  await page.mouse.click(640, 400, { button: 'right' });
  await sleep(4000);

  // === Screenshot 2: YouTube — サムネ吸い込み中 ===
  console.log('Screenshot 2: YouTube');
  await page.goto('https://www.youtube.com/results?search_query=space+documentary', {
    waitUntil: 'networkidle2', timeout: 30000
  });
  await sleep(3000);
  await activateBH(browser, page);
  for (let y = 150; y < 450; y += 4) {
    await page.mouse.move(400, y);
    await sleep(16);
  }
  for (let x = 100; x < 700; x += 4) {
    await page.mouse.move(x, 300);
    await sleep(16);
  }
  await sleep(500);
  await page.screenshot({ path: path.join(STORE_DIR, 'screenshot-2-youtube.png') });
  console.log('  Done');

  // OFF
  await page.mouse.click(640, 400, { button: 'right' });
  await sleep(4000);

  // === Screenshot 3: 復元アニメーション ===
  console.log('Screenshot 3: 復元アニメーション');
  await page.goto('https://en.wikipedia.org/wiki/Supermassive_black_hole', {
    waitUntil: 'networkidle2', timeout: 30000
  });
  await sleep(2000);
  await activateBH(browser, page);
  for (let y = 200; y < 600; y += 3) {
    await page.mouse.move(600, y);
    await sleep(16);
  }
  for (let x = 300; x < 900; x += 3) {
    await page.mouse.move(x, 400);
    await sleep(16);
  }
  await sleep(300);
  // 復元開始直後にスクショ
  await page.mouse.click(640, 400, { button: 'right' });
  await sleep(600);  // アニメーション途中
  await page.screenshot({ path: path.join(STORE_DIR, 'screenshot-3-restore.png') });
  console.log('  Done');

  await sleep(5000);

  console.log(`\nストアアセット: ${STORE_DIR}`);
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
