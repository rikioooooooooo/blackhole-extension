import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: false,
    args: ['--window-size=1280,900'],
    defaultViewport: { width: 1280, height: 900 }
  });

  const page = await browser.newPage();
  const testUrl = `file:///${path.resolve(__dirname, 'test-page.html').replace(/\\/g, '/')}`;
  await page.goto(testUrl, { waitUntil: 'domcontentloaded' });
  await sleep(500);

  console.log('=== Step 1: 初期状態 ===');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-initial.png') });

  console.log('=== Step 2: BH ON ===');
  await page.click('#toggle-btn');
  await sleep(500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02-bh-on.png') });

  // BH DOM確認
  const setupCheck = await page.evaluate(() => {
    const bhContainer = document.getElementById('bh-container');
    return {
      hasBhContainer: !!bhContainer,
      bhOn: typeof on !== 'undefined' ? on : 'N/A'
    };
  });
  console.log('  セットアップ:', JSON.stringify(setupCheck));

  console.log('=== Step 3: マウスで吸い込み ===');
  // ゆっくりテキスト上を移動（セクション1-2）
  for (let x = 100; x < 700; x += 5) {
    await page.mouse.move(x, 120);
    await sleep(16);
  }
  await sleep(200);
  // 縦にも移動（セクション2-3-4のリスト領域まで）
  for (let y = 100; y < 800; y += 4) {
    await page.mouse.move(400, y);
    await sleep(16);
  }
  await sleep(200);
  // リスト領域を横にも移動（箇条書きのマーカー部分）
  for (let x = 40; x < 500; x += 5) {
    await page.mouse.move(x, 720);
    await sleep(16);
  }
  for (let x = 40; x < 500; x += 5) {
    await page.mouse.move(x, 750);
    await sleep(16);
  }
  await sleep(300);

  console.log('=== Step 4: 吸い込み後スクリーンショット ===');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03-after-absorb.png') });

  // 消した文字の確認
  const erasedCheck = await page.evaluate(() => {
    const erasedSpans = document.querySelectorAll('[data-bh-erased]');
    let transparentCount = 0;
    for (const sp of erasedSpans) {
      if (sp.style.color === 'transparent') transparentCount++;
    }
    const markerHidden = document.querySelectorAll('[data-bh-marker]').length;
    const hiddenEls = document.querySelectorAll('[data-bh="1"]').length;
    return {
      totalErased: erasedSpans.length,
      transparentCount,
      markerHidden,
      hiddenEls,
      particles: document.querySelectorAll('.bh-particle').length
    };
  });
  console.log('  消去チェック:', JSON.stringify(erasedCheck));

  console.log('=== Step 5: スクロールテスト ===');
  await page.evaluate(() => window.scrollBy(0, 300));
  await sleep(500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04-after-scroll.png') });

  // スクロール後も文字が透明のままか確認
  const scrollCheck = await page.evaluate(() => {
    const erasedSpans = document.querySelectorAll('[data-bh-erased]');
    let stillTransparent = 0;
    for (const sp of erasedSpans) {
      if (sp.style.color === 'transparent') stillTransparent++;
    }
    return {
      totalErased: erasedSpans.length,
      stillTransparent
    };
  });
  console.log('  スクロール後:', JSON.stringify(scrollCheck));

  console.log('=== Step 6: BH OFF ===');
  await page.mouse.move(640, 450);
  await sleep(100);
  await page.click('#toggle-btn');
  await sleep(500);
  // 復元アニメーション途中のスクリーンショット
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-restoring.png') });
  await sleep(2500);
  // 復元完了後のスクリーンショット
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '06-after-off.png') });

  const offCheck = await page.evaluate(() => {
    return {
      bhContainer: !!document.getElementById('bh-container'),
      erasedSpans: document.querySelectorAll('[data-bh-erased]').length,
      particles: document.querySelectorAll('.bh-particle').length
    };
  });
  console.log('  OFF後:', JSON.stringify(offCheck));

  console.log('\n=== テスト完了 ===');
  console.log(`スクリーンショット: ${SCREENSHOT_DIR}`);

  await sleep(2000);
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
