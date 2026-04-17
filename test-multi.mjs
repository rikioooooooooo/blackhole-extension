import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contentJs = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
const stylesCss = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const testContentJs = contentJs + `
;(function() {
  window.__bhTest = {
    activate() { if (typeof activate === 'function') activate(); },
    deactivate() { if (typeof off === 'function') off(); },
    getStats() {
      return {
        on: typeof on !== 'undefined' ? on : false,
        sz: typeof sz !== 'undefined' ? sz : 0,
        bodies: typeof bodies !== 'undefined' ? bodies.length : 0,
        totalAbsorbed: typeof totalAbsorbed !== 'undefined' ? totalAbsorbed : 0,
        frameEma: typeof _frameEma !== 'undefined' ? _frameEma : 0,
        peelMs: typeof _dbgPeelMs !== 'undefined' ? _dbgPeelMs : 0,
        physMs: typeof _dbgPhysMs !== 'undefined' ? _dbgPhysMs : 0,
        restMs: typeof _dbgRestMs !== 'undefined' ? _dbgRestMs : 0,
      };
    }
  };
})();
`;

const SITES = [
  { name: 'Yahoo_JP', url: 'https://www.yahoo.co.jp/' },
  { name: 'GitHub', url: 'https://github.com/explore' },
  { name: 'MDN', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript' },
];

async function testSite(browser, site) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`=== ${site.name}: ${site.url} ===`);
  console.log('='.repeat(60));

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch (e) {
    console.log(`  ページ読み込みタイムアウト — domcontentloaded で続行`);
  }
  await sleep(2000);

  const domInfo = await page.evaluate(() => ({
    totalNodes: document.querySelectorAll('*').length,
    depth: (() => {
      let maxD = 0;
      const walk = (el, d) => { if (d > maxD) maxD = d; for (const c of el.children) walk(c, d + 1); };
      walk(document.documentElement, 0);
      return maxD;
    })(),
  }));
  console.log(`  DOM: ${domInfo.totalNodes} nodes, depth ${domInfo.depth}`);

  await page.addStyleTag({ content: stylesCss });
  await page.evaluate(() => {
    window.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage() {} } };
  });
  await page.evaluate(testContentJs);
  await sleep(300);

  await page.mouse.move(640, 400);
  await page.evaluate(() => window.__bhTest.activate());
  await sleep(300);

  // フレーム計測
  await page.evaluate(() => {
    window.__perfRafLog = [];
    let lastTs = 0, count = 0;
    function logFrame(ts) {
      if (lastTs) window.__perfRafLog.push(ts - lastTs);
      lastTs = ts;
      if (++count < 400) requestAnimationFrame(logFrame);
    }
    requestAnimationFrame(logFrame);
  });

  // ジグザグ吸引 6秒
  console.log(`  --- 吸引テスト（6秒） ---`);
  for (let i = 0; i < 360; i++) {
    const row = Math.floor(i / 40);
    const col = i % 40;
    const x = (row % 2 === 0) ? 100 + col * 27 : 1180 - col * 27;
    const y = 50 + row * 80;
    await page.mouse.move(x, Math.min(y, 750));
    await sleep(16);

    if (i % 60 === 59) {
      const s = await page.evaluate(() => window.__bhTest.getStats());
      console.log(`  ${Math.floor(i/60)+1}s: bodies=${s.bodies} sz=${s.sz.toFixed(0)} absorbed=${s.totalAbsorbed} ema=${s.frameEma.toFixed(1)}ms [peel=${s.peelMs.toFixed(1)} phys=${s.physMs.toFixed(1)} rest=${s.restMs.toFixed(1)}]`);
    }
  }

  await page.screenshot({ path: path.join(__dirname, `test-multi-${site.name.toLowerCase()}.png`) });

  // フレーム統計
  const ft = await page.evaluate(() => window.__perfRafLog);
  if (ft.length > 10) {
    const sorted = [...ft].sort((a, b) => a - b);
    const avg = ft.reduce((s, v) => s + v, 0) / ft.length;
    const dropped = ft.filter(t => t > 20).length;
    const janky = ft.filter(t => t > 33).length;
    console.log(`\n  === フレーム統計 (${ft.length}f) ===`);
    console.log(`  avg=${avg.toFixed(1)}ms P50=${sorted[Math.floor(ft.length*0.5)].toFixed(1)}ms P95=${sorted[Math.floor(ft.length*0.95)].toFixed(1)}ms P99=${sorted[Math.floor(ft.length*0.99)].toFixed(1)}ms`);
    console.log(`  min=${sorted[0].toFixed(1)}ms max=${sorted[ft.length-1].toFixed(1)}ms`);
    console.log(`  >20ms: ${dropped} (${(dropped/ft.length*100).toFixed(1)}%) >33ms: ${janky} (${(janky/ft.length*100).toFixed(1)}%)`);
  }

  const final_ = await page.evaluate(() => window.__bhTest.getStats());
  console.log(`\n  === 最終状態 ===`);
  console.log(`  sz=${final_.sz.toFixed(0)} bodies=${final_.bodies} absorbed=${final_.totalAbsorbed} ema=${final_.frameEma.toFixed(1)}ms`);

  // 復元テスト
  console.log(`\n  === 復元テスト ===`);
  const t0 = Date.now();
  await page.mouse.click(640, 400, { button: 'right' });
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    const s = await page.evaluate(() => window.__bhTest.getStats());
    if (!s.on) { console.log(`  完了: ${Date.now() - t0}ms`); break; }
    if (i === 39) console.log(`  タイムアウト: ${Date.now() - t0}ms`);
  }

  // エラーチェック
  const errors = await page.evaluate(() => {
    const errs = [];
    if (document.getElementById('bh-container')) errs.push('bh-container残存');
    if (document.getElementById('bh-overlay')) errs.push('bh-overlay残存');
    const particles = document.querySelectorAll('.bh-particle');
    if (particles.length > 0) errs.push(`particle残存: ${particles.length}`);
    const erased = document.querySelectorAll('[data-bh-erased]');
    if (erased.length > 0) errs.push(`erased残存: ${erased.length}`);
    const hidden = document.querySelectorAll('[data-bh="1"]');
    if (hidden.length > 0) errs.push(`hidden残存: ${hidden.length}`);
    return errs;
  });
  if (errors.length > 0) {
    console.log(`  ⚠️ クリーンアップ問題: ${errors.join(', ')}`);
  } else {
    console.log(`  ✅ クリーンアップ完了`);
  }

  await page.close();
}

(async () => {
  const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox'] });

  for (const site of SITES) {
    await testSite(browser, site);
  }

  await browser.close();
  console.log('\n=== 全テスト完了 ===');
})();
