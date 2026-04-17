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
        trailRuns: typeof _dbgTrailRuns !== 'undefined' ? _dbgTrailRuns : 0,
        trailFound: typeof _dbgTrailFound !== 'undefined' ? _dbgTrailFound : 0,
        trailAbsorbed: typeof _dbgTrailAbsorbed !== 'undefined' ? _dbgTrailAbsorbed : 0,
        trailSkip: typeof _dbgTrailSkipReason !== 'undefined' ? _dbgTrailSkipReason : '',
        bodiesLen: typeof bodies !== 'undefined' ? bodies.length : 0,
      };
    }
  };
})();
`;

// テスト用HTML: 密度の高いテキストグリッド
const TEST_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>高速吸引テスト</title>
<style>
body { margin: 0; padding: 20px; font-family: sans-serif; font-size: 14px; line-height: 1.6; }
.row { display: flex; gap: 10px; margin: 4px 0; }
.cell { flex: 1; padding: 4px 8px; background: #f0f0f0; border-radius: 4px; }
h2 { margin: 10px 0 5px; font-size: 16px; color: #333; }
</style></head><body>
<h2>Zone A: 低速スイープ領域</h2>
${Array.from({length: 10}, (_, i) => `
<div class="row">
  ${Array.from({length: 5}, (_, j) => `<div class="cell" id="a-${i}-${j}">A${i}${j} テスト文字列 ABCDE あいうえお 12345</div>`).join('')}
</div>`).join('')}
<h2>Zone B: 高速スイープ領域</h2>
${Array.from({length: 10}, (_, i) => `
<div class="row">
  ${Array.from({length: 5}, (_, j) => `<div class="cell" id="b-${i}-${j}">B${i}${j} テスト文字列 FGHIJ かきくけこ 67890</div>`).join('')}
</div>`).join('')}
</body></html>`;

function countVisibleText(page, zone) {
  return page.evaluate((z) => {
    const cells = document.querySelectorAll(`[id^="${z}-"]`);
    let total = 0, visible = 0, erased = 0, hidden = 0;
    for (const cell of cells) {
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null);
      let tn;
      while ((tn = walker.nextNode())) {
        const text = tn.textContent.trim();
        if (!text) continue;
        const parent = tn.parentElement;
        if (parent && parent.hasAttribute('data-bh-erased')) {
          erased += text.length;
        } else {
          visible += text.length;
        }
        total += text.length;
      }
      if (cell.getAttribute('data-bh') === '1') hidden++;
    }
    return { total, visible, erased, hidden, cells: cells.length };
  }, zone);
}

(async () => {
  const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  await page.setContent(TEST_HTML, { waitUntil: 'domcontentloaded' });
  await sleep(300);

  await page.addStyleTag({ content: stylesCss });
  await page.evaluate(() => {
    window.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage() {} } };
  });
  await page.evaluate(testContentJs);
  await sleep(300);

  // 初期カウント
  const beforeA = await countVisibleText(page, 'a');
  const beforeB = await countVisibleText(page, 'b');
  console.log(`\n=== 初期状態 ===`);
  console.log(`Zone A: ${beforeA.total} chars (${beforeA.cells} cells)`);
  console.log(`Zone B: ${beforeB.total} chars (${beforeB.cells} cells)`);

  // BH起動 + 育成（Zone AとBを公平に比較するため先に育てる）
  await page.mouse.move(640, 10);
  await page.evaluate(() => window.__bhTest.activate());
  await sleep(300);

  // 画面端で素早くBHを育成（ページ上端の非テスト領域）
  console.log(`\n=== BH育成フェーズ ===`);
  for (let i = 0; i < 200; i++) {
    await page.mouse.move(640 + (i % 2 === 0 ? -200 : 200), 15);
    await sleep(8);
  }
  const seedStats = await page.evaluate(() => window.__bhTest.getStats());
  console.log(`  BH sz=${seedStats.sz.toFixed(0)} absorbed=${seedStats.totalAbsorbed}`);

  // 同一時間（8秒）で両Zoneを同じ回数スイープ

  // === Zone A: 低速スイープ（8秒）===
  console.log(`\n=== Zone A: 低速スイープ（8秒）===`);
  const t0A = Date.now();
  for (let pass = 0; pass < 6 && Date.now() - t0A < 8000; pass++) {
    for (let x = 50; x <= 1230; x += 6) {
      const y = 70 + pass * 40;
      await page.mouse.move(x, y);
      await sleep(8);
    }
    for (let x = 1230; x >= 50; x -= 6) {
      const y = 90 + pass * 40;
      await page.mouse.move(x, y);
      await sleep(8);
    }
  }
  const elapsedA = ((Date.now() - t0A) / 1000).toFixed(1);
  const afterSlowA = await countVisibleText(page, 'a');
  const statsA = await page.evaluate(() => window.__bhTest.getStats());
  console.log(`  ${elapsedA}s — visible: ${afterSlowA.visible}/${afterSlowA.total} (${(afterSlowA.visible/afterSlowA.total*100).toFixed(1)}% 残存)`);
  console.log(`  erased: ${afterSlowA.erased}, hidden: ${afterSlowA.hidden}`);
  console.log(`  BH: sz=${statsA.sz.toFixed(0)} absorbed=${statsA.totalAbsorbed}`);

  // === Zone B: 高速スイープ（同じ8秒）===
  console.log(`\n=== Zone B: 高速スイープ（8秒）===`);
  const t0B = Date.now();
  for (let pass = 0; pass < 30 && Date.now() - t0B < 8000; pass++) {
    for (let x = 50; x <= 1230; x += 40) {
      const y = 350 + (pass % 8) * 30;
      await page.mouse.move(x, y);
      await sleep(8);
    }
    for (let x = 1230; x >= 50; x -= 40) {
      const y = 365 + (pass % 8) * 30;
      await page.mouse.move(x, y);
      await sleep(8);
    }
  }
  const elapsedB = ((Date.now() - t0B) / 1000).toFixed(1);
  const afterFastB = await countVisibleText(page, 'b');
  const statsB = await page.evaluate(() => window.__bhTest.getStats());
  console.log(`  ${elapsedB}s — visible: ${afterFastB.visible}/${afterFastB.total} (${(afterFastB.visible/afterFastB.total*100).toFixed(1)}% 残存)`);
  console.log(`  erased: ${afterFastB.erased}, hidden: ${afterFastB.hidden}`);
  console.log(`  BH: sz=${statsB.sz.toFixed(0)} absorbed=${statsB.totalAbsorbed}`);

  // スクリーンショット
  await page.screenshot({ path: path.join(__dirname, 'test-fast-sweep-result.png') });

  // 比較
  console.log(`\n=== 比較 ===`);
  const slowRemain = afterSlowA.visible / afterSlowA.total;
  const fastRemain = afterFastB.visible / afterFastB.total;
  const slowRate = afterSlowA.erased / (parseFloat(elapsedA) || 1);
  const fastRate = afterFastB.erased / (parseFloat(elapsedB) || 1);
  console.log(`低速: ${(slowRemain * 100).toFixed(1)}% 残存 (${slowRate.toFixed(1)} chars/s)`);
  console.log(`高速: ${(fastRemain * 100).toFixed(1)}% 残存 (${fastRate.toFixed(1)} chars/s)`);
  console.log(`秒あたり吸収率: 高速は低速の ${(fastRate / slowRate).toFixed(1)}x`);
  if (fastRate >= slowRate * 0.7) {
    console.log(`✅ 高速移動の吸収効率は良好`);
  } else {
    console.log(`⚠️ 高速移動の吸収効率が低い`);
  }

  await browser.close();
  console.log('\n=== テスト完了 ===');
})();
