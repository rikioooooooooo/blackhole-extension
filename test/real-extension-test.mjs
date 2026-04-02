import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const EXT_PATH = path.resolve(__dirname, '..').replace(/\\/g, '/');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log(`拡張機能パス: ${EXT_PATH}`);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: false,
    args: [
      `--load-extension=${EXT_PATH}`,
      `--disable-extensions-except=${EXT_PATH}`,
      '--window-size=1280,900',
      '--no-first-run',
      '--no-default-browser-check'
    ],
    defaultViewport: { width: 1280, height: 900 }
  });

  const page = await browser.newPage();
  await page.goto('https://ja.wikipedia.org/wiki/%E3%83%96%E3%83%A9%E3%83%83%E3%82%AF%E3%83%9B%E3%83%BC%E3%83%AB', {
    waitUntil: 'networkidle2',
    timeout: 30000
  });
  await sleep(2000);

  console.log('=== Step 1: 初期状態 ===');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'real-01-initial.png') });

  // 拡張機能のservice workerを見つけてアクションを実行
  console.log('=== Step 2: 拡張機能のアクションをトリガー ===');
  const targets = await browser.targets();
  const swTarget = targets.find(t =>
    t.type() === 'service_worker' && t.url().includes('background.js')
  );

  if (swTarget) {
    console.log('  Service Worker found:', swTarget.url());
    const sw = await swTarget.worker();

    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab) {
        try {
          await chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
        } catch (e) {
          console.log('sendMessage error:', e.message);
          await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['styles.css'] });
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
          await new Promise(r => setTimeout(r, 300));
          await chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
        }
      }
    });
  } else {
    console.log('  Service Worker not found!');
    await browser.close();
    return;
  }

  await sleep(1500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'real-02-bh-on.png') });

  // BHが起動したか確認
  const bhState = await page.evaluate(() => {
    const bhContainer = document.getElementById('bh-container');
    return { hasBhContainer: !!bhContainer };
  });
  console.log('  BH状態:', JSON.stringify(bhState));

  if (!bhState.hasBhContainer) {
    console.log('  BH起動失敗');
    await sleep(2000);
    await browser.close();
    return;
  }

  console.log('=== Step 3: マウスで吸い込み ===');
  for (let x = 100; x < 800; x += 5) {
    await page.mouse.move(x, 200);
    await sleep(16);
  }
  await sleep(200);
  for (let y = 150; y < 400; y += 5) {
    await page.mouse.move(500, y);
    await sleep(16);
  }
  await sleep(300);

  console.log('=== Step 4: 吸い込み後スクリーンショット ===');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'real-03-after-absorb.png') });

  const erasedCheck = await page.evaluate(() => {
    const erasedSpans = document.querySelectorAll('[data-bh-erased]');
    const particles = document.querySelectorAll('.bh-particle').length;
    return { totalErased: erasedSpans.length, particles };
  });
  console.log('  消去:', JSON.stringify(erasedCheck));

  console.log('=== Step 5: スクロールテスト ===');
  await page.evaluate(() => window.scrollBy(0, 300));
  await sleep(500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'real-04-after-scroll.png') });

  const scrollCheck = await page.evaluate(() => {
    const erasedSpans = document.querySelectorAll('[data-bh-erased]');
    let stillTransparent = 0;
    for (const sp of erasedSpans) {
      if (sp.style.color === 'transparent') stillTransparent++;
    }
    return { totalErased: erasedSpans.length, stillTransparent };
  });
  console.log('  スクロール後:', JSON.stringify(scrollCheck));

  console.log('=== Step 6: 右クリックでリロード ===');
  await page.mouse.click(640, 450, { button: 'right' });
  await sleep(3000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'real-05-after-reload.png') });

  console.log('\n=== テスト完了 ===');
  console.log(`スクリーンショット: ${SCREENSHOT_DIR}`);

  await sleep(2000);
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
