/**
 * マルチサイト実機テスト — あらゆるブラウザ/サイトで吸えるか検証
 *
 * テスト対象:
 * 1. YouTube検索結果（サムネイル + テキスト + 自動再生防止）
 * 2. Twitter/X（ログイン不要のツイート埋め込みページ）
 * 3. Wikipedia（テキスト + SVG + 画像）
 * 4. Google検索（テキスト + サイドバー + CSS背景）
 * 5. GitHub（コード + SVGアイコン + ボタン）
 */
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

const SITES = [
  {
    name: 'YouTube検索',
    url: 'https://www.youtube.com/results?search_query=black+hole+space',
    sweepAreas: [
      { label: 'サムネ領域', x: [100, 700], y: [200, 500], step: 4 },
      { label: 'テキスト領域', x: [100, 800], y: [500, 600], step: 3 },
    ],
    checks: ['autoplay']
  },
  {
    name: 'Wikipedia',
    url: 'https://en.wikipedia.org/wiki/Black_hole',
    sweepAreas: [
      { label: '本文', x: [200, 800], y: [200, 500], step: 4 },
      { label: '画像+SVG領域', x: [700, 1100], y: [200, 600], step: 5 },
    ],
    checks: []
  },
  {
    name: 'Google検索',
    url: 'https://www.google.com/search?q=black+hole+chrome+extension',
    sweepAreas: [
      { label: '検索結果', x: [200, 700], y: [200, 600], step: 4 },
    ],
    checks: []
  },
  {
    name: 'GitHub',
    url: 'https://github.com/nicolo-ribaudo/tc39-proposal-structs',
    sweepAreas: [
      { label: 'READMEテキスト+SVG', x: [300, 900], y: [300, 700], step: 4 },
      { label: 'ボタン+タブ', x: [400, 900], y: [100, 250], step: 5 },
    ],
    checks: []
  },
];

async function activateBH(browser, page) {
  const targets = await browser.targets();
  const swTarget = targets.find(t =>
    t.type() === 'service_worker' && t.url().includes('background.js')
  );
  if (!swTarget) { console.log('  SW not found!'); return false; }
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
  const ok = await page.evaluate(() => !!document.getElementById('bh-container'));
  return ok;
}

async function runSiteTest(browser, page, site) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${site.name}: ${site.url}`);
  console.log(`${'='.repeat(60)}`);

  await page.goto(site.url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  await sleep(3000);

  const prefix = site.name.replace(/[^a-zA-Z]/g, '').slice(0, 8).toLowerCase();
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${prefix}-01-initial.png`) });

  // BH ON
  const bhOk = await activateBH(browser, page);
  if (!bhOk) { console.log('  BH起動失敗 → スキップ'); return; }
  console.log('  BH ON');

  // 各エリアをスイープ
  for (const area of site.sweepAreas) {
    console.log(`  吸い込み: ${area.label}`);
    // 横スイープ
    for (let y = area.y[0]; y < area.y[1]; y += area.step * 3) {
      for (let x = area.x[0]; x < area.x[1]; x += area.step) {
        await page.mouse.move(x, y);
        await sleep(16);
      }
    }
    // 縦スイープ
    for (let x = area.x[0]; x < area.x[1]; x += area.step * 5) {
      for (let y = area.y[0]; y < area.y[1]; y += area.step) {
        await page.mouse.move(x, y);
        await sleep(16);
      }
    }
    await sleep(200);
  }

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${prefix}-02-absorbed.png`) });

  // 吸収結果
  const result = await page.evaluate(() => {
    const erased = document.querySelectorAll('[data-bh-erased]').length;
    const hidden = document.querySelectorAll('[data-bh="1"]').length;
    const particles = document.querySelectorAll('.bh-particle').length;
    const bhSz = document.getElementById('bh-container')?.style.getPropertyValue('--bh-size');
    const videos = [...document.querySelectorAll('video')];
    const playing = videos.filter(v => !v.paused).length;
    return { erased, hidden, particles, bhSize: bhSz, videos: videos.length, playing };
  });
  console.log('  結果:', JSON.stringify(result));

  // autoplayチェック
  if (site.checks.includes('autoplay')) {
    console.log('  hover自動再生チェック...');
    await page.mouse.move(400, 350);
    await sleep(2000);
    const hover = await page.evaluate(() => {
      const videos = [...document.querySelectorAll('video')];
      return { playing: videos.filter(v => !v.paused).length };
    });
    console.log('  自動再生状態:', JSON.stringify(hover));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${prefix}-03-hover.png`) });
  }

  // スクロールテスト
  await page.evaluate(() => window.scrollBy(0, 400));
  await sleep(500);
  const scrollCheck = await page.evaluate(() => {
    const erased = document.querySelectorAll('[data-bh-erased]');
    let stillOk = 0;
    for (const sp of erased) { if (sp.style.color === 'transparent') stillOk++; }
    return { total: erased.length, stillTransparent: stillOk };
  });
  console.log('  スクロール後:', JSON.stringify(scrollCheck));

  // BH OFF（右クリック）— 復元アニメの待ち時間を吸収数に比例
  await page.mouse.click(640, 450, { button: 'right' });
  const erasedCount = await page.evaluate(() => document.querySelectorAll('[data-bh-erased]').length);
  const waitMs = Math.max(3000, Math.min(8000, erasedCount * 5 + 2000));
  console.log(`  復元待ち: ${waitMs}ms (${erasedCount}個)`);
  await sleep(waitMs);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${prefix}-04-off.png`) });

  const offCheck = await page.evaluate(() => ({
    bhContainer: !!document.getElementById('bh-container'),
    erased: document.querySelectorAll('[data-bh-erased]').length,
    hidden: document.querySelectorAll('[data-bh="1"]').length,
    particles: document.querySelectorAll('.bh-particle').length
  }));
  console.log('  OFF後:', JSON.stringify(offCheck));

  if (offCheck.erased > 0 || offCheck.hidden > 0) {
    console.log('  ⚠️ 復元不完全!');
  } else {
    console.log('  ✅ 完全復元');
  }
}

async function main() {
  console.log(`拡張機能: ${EXT_PATH}`);

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

  for (const site of SITES) {
    try {
      await runSiteTest(browser, page, site);
    } catch (e) {
      console.log(`  ❌ ${site.name} エラー: ${e.message}`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('  全サイトテスト完了');
  console.log(`  スクリーンショット: ${SCREENSHOT_DIR}`);
  console.log(`${'='.repeat(60)}`);

  await sleep(2000);
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
