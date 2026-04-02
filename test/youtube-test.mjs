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
      '--no-default-browser-check',
      '--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies'
    ],
    defaultViewport: { width: 1280, height: 900 }
  });

  const page = await browser.newPage();

  // YouTubeトップページへ
  console.log('=== YouTube トップページへ ===');
  await page.goto('https://www.youtube.com/', {
    waitUntil: 'networkidle2',
    timeout: 30000
  });
  await sleep(3000);

  console.log('=== Step 1: 初期状態 ===');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'yt-01-initial.png') });

  // 拡張機能のservice workerを見つけてBH ON
  console.log('=== Step 2: BH ON ===');
  const targets = await browser.targets();
  const swTarget = targets.find(t =>
    t.type() === 'service_worker' && t.url().includes('background.js')
  );

  if (!swTarget) {
    console.log('  Service Worker not found!');
    await browser.close();
    return;
  }

  console.log('  Service Worker found:', swTarget.url());
  const sw = await swTarget.worker();

  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
      } catch (e) {
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['styles.css'] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        await new Promise(r => setTimeout(r, 300));
        await chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
      }
    }
  });

  await sleep(1500);

  const bhState = await page.evaluate(() => {
    return { hasBhContainer: !!document.getElementById('bh-container') };
  });
  console.log('  BH状態:', JSON.stringify(bhState));

  if (!bhState.hasBhContainer) {
    console.log('  BH起動失敗');
    await sleep(2000);
    await browser.close();
    return;
  }

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'yt-02-bh-on.png') });

  // Step 3: サムネイル領域をマウスで吸い込み
  console.log('=== Step 3: サムネイル領域を吸い込み ===');
  // YouTubeのサムネイルは大体 y=200-500, x=100-600 あたり
  for (let y = 200; y < 500; y += 4) {
    await page.mouse.move(300, y);
    await sleep(16);
  }
  await sleep(200);
  for (let x = 100; x < 600; x += 4) {
    await page.mouse.move(x, 350);
    await sleep(16);
  }
  await sleep(300);

  console.log('=== Step 4: サムネ吸い込み後 ===');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'yt-03-after-absorb.png') });

  const erasedCheck = await page.evaluate(() => {
    const erasedSpans = document.querySelectorAll('[data-bh-erased]');
    const hidden = document.querySelectorAll('[data-bh="1"]');
    const particles = document.querySelectorAll('.bh-particle').length;
    // 動画プレビューが勝手に再生されていないかチェック
    const videos = [...document.querySelectorAll('video')];
    const playingVideos = videos.filter(v => !v.paused).length;
    return {
      totalErased: erasedSpans.length,
      hiddenElements: hidden.length,
      particles,
      totalVideos: videos.length,
      playingVideos
    };
  });
  console.log('  吸収結果:', JSON.stringify(erasedCheck));

  // Step 5: サムネ領域に戻ってhoverしても自動再生されないか確認
  console.log('=== Step 5: hover自動再生チェック ===');
  await page.mouse.move(300, 300);
  await sleep(2000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'yt-04-hover-check.png') });

  const hoverCheck = await page.evaluate(() => {
    const videos = [...document.querySelectorAll('video')];
    const playingVideos = videos.filter(v => !v.paused).length;
    return { totalVideos: videos.length, playingVideos };
  });
  console.log('  hover後の動画再生状態:', JSON.stringify(hoverCheck));

  // Step 6: テキスト吸い込み（タイトル部分）
  console.log('=== Step 6: テキスト吸い込み ===');
  for (let x = 100; x < 800; x += 3) {
    await page.mouse.move(x, 550);
    await sleep(16);
  }
  await sleep(300);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'yt-05-text-absorb.png') });

  const textCheck = await page.evaluate(() => {
    return {
      totalErased: document.querySelectorAll('[data-bh-erased]').length,
      hiddenElements: document.querySelectorAll('[data-bh="1"]').length,
      particles: document.querySelectorAll('.bh-particle').length,
      bhSize: document.getElementById('bh-container')?.style.getPropertyValue('--bh-size')
    };
  });
  console.log('  テキスト吸収後:', JSON.stringify(textCheck));

  // Step 7: 高速移動テスト
  console.log('=== Step 7: 高速移動テスト ===');
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(100, 200);
    await sleep(30);
    await page.mouse.move(1100, 700);
    await sleep(30);
  }
  await sleep(500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'yt-06-fast-move.png') });

  // Step 8: BH OFF → 復元
  console.log('=== Step 8: BH OFF ===');
  await page.mouse.click(640, 450, { button: 'right' });
  await sleep(3000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'yt-07-after-off.png') });

  const offCheck = await page.evaluate(() => {
    return {
      bhContainer: !!document.getElementById('bh-container'),
      erasedSpans: document.querySelectorAll('[data-bh-erased]').length,
      hiddenElements: document.querySelectorAll('[data-bh="1"]').length,
      particles: document.querySelectorAll('.bh-particle').length
    };
  });
  console.log('  OFF後:', JSON.stringify(offCheck));

  console.log('\n=== YouTubeテスト完了 ===');
  console.log(`スクリーンショット: ${SCREENSHOT_DIR}`);

  await sleep(2000);
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
