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
      };
    }
  };
})();
`;

// こすくま保護テスト用HTML
const TEST_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>こすくま保護テスト</title>
<style>
body { font-family: sans-serif; font-size: 18px; line-height: 2; padding: 40px; }
.section { margin: 20px 0; padding: 20px; border: 1px solid #ccc; }
h2 { font-size: 24px; }
</style></head><body>
<h1>ブラックホール こすくま保護テスト</h1>

<div class="section" id="test-plain">
  <h2>テスト1: プレーンテキスト</h2>
  <p>こすくまは宇宙一かわいいキャラクターです。</p>
  <p>みんなこすくまが大好きです。</p>
</div>

<div class="section" id="test-inline">
  <h2>テスト2: インライン要素内</h2>
  <p><b>こすくま</b>は最強です。</p>
  <p><a href="#">こすくま</a>のリンク。</p>
  <p><span style="color:red">こすくま</span>は赤い。</p>
</div>

<div class="section" id="test-split">
  <h2>テスト3: 要素跨ぎ</h2>
  <p><b>こす</b>くまは分割されている。</p>
  <p><span>こ</span><span>す</span><span>く</span><span>ま</span>は1文字ずつ。</p>
</div>

<div class="section" id="test-mixed">
  <h2>テスト4: 混在テキスト</h2>
  <p>ABCDEFこすくまGHIJKL</p>
  <p>テスト文字列こすくまテスト文字列</p>
  <p>kosukumaも保護対象です。</p>
  <p>こす・くまもマッチするはず。</p>
</div>

<div class="section" id="test-filler">
  <h2>テスト5: 大量テキスト（吸引対象）</h2>
  <p>あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん</p>
  <p>ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789</p>
  <p>これらの文字は吸い込まれるべきです。ブラックホールのテスト用テキストです。</p>
  <p>1234567890 The quick brown fox jumps over the lazy dog.</p>
  <p>アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン</p>
</div>

</body></html>`;

(async () => {
  const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // テストHTML読み込み
  await page.setContent(TEST_HTML, { waitUntil: 'domcontentloaded' });
  await sleep(500);

  // CSS + chrome mock + content.js inject
  await page.addStyleTag({ content: stylesCss });
  await page.evaluate(() => {
    window.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage() {} } };
  });
  await page.evaluate(testContentJs);
  await sleep(300);

  // こすくまカウント（吸引前）
  const beforeCount = await page.evaluate(() => {
    const re = /こすくま|こす[.．・]くま|kosukuma/gi;
    const body = document.body.innerText;
    const matches = body.match(re);
    return { total: matches ? matches.length : 0, text: body.substring(0, 500) };
  });
  console.log(`\n=== 吸引前 ===`);
  console.log(`こすくま出現回数: ${beforeCount.total}`);

  // BH起動
  await page.mouse.move(640, 400);
  await page.evaluate(() => window.__bhTest.activate());
  await sleep(300);

  // フレーム計測開始
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

  // 全域スイープ（8秒）
  console.log(`\n=== 吸引テスト（8秒） ===`);
  for (let i = 0; i < 480; i++) {
    const row = Math.floor(i / 60);
    const col = i % 60;
    const x = (row % 2 === 0) ? 50 + col * 20 : 1230 - col * 20;
    const y = 30 + row * 100;
    await page.mouse.move(x, Math.min(y, 870));
    await sleep(16);

    if (i % 60 === 59) {
      const s = await page.evaluate(() => window.__bhTest.getStats());
      console.log(`  ${Math.floor(i/60)+1}s: bodies=${s.bodies} sz=${s.sz.toFixed(0)} absorbed=${s.totalAbsorbed} ema=${s.frameEma.toFixed(1)}ms`);
    }
  }

  // スクリーンショット（吸引中）
  await page.screenshot({ path: path.join(__dirname, 'test-kosukuma-during.png') });

  // こすくま保護チェック（吸引中）
  const duringCheck = await page.evaluate(() => {
    // data-bh-erased属性がついた文字の中にこすくまの文字がないか
    const erasedSpans = document.querySelectorAll('[data-bh-erased]');
    const erasedChars = [];
    for (const sp of erasedSpans) {
      erasedChars.push(sp.textContent);
    }
    const erasedText = erasedChars.join('');

    // こすくまの各文字が消されたかチェック
    const kosuChars = ['こ', 'す', 'く', 'ま'];
    const erasedKosu = {};
    for (const ch of kosuChars) {
      erasedKosu[ch] = erasedChars.filter(c => c === ch).length;
    }

    // 各テストセクションのDOMを確認
    const sections = {};
    for (let i = 1; i <= 4; i++) {
      const sec = document.getElementById(`test-${['plain','inline','split','mixed'][i-1]}`);
      if (sec) {
        // テキストノードとerased spanの状態を取得
        const walker = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT, null);
        let n, visibleText = '';
        while ((n = walker.nextNode())) {
          const parent = n.parentElement;
          if (parent && !parent.hasAttribute('data-bh-erased')) {
            visibleText += n.textContent;
          }
        }
        // erased spanの中身
        const erased = [...sec.querySelectorAll('[data-bh-erased]')].map(s => s.textContent);
        sections[`test${i}`] = {
          visibleText: visibleText.replace(/\s+/g, ' ').trim(),
          erasedChars: erased.join(''),
        };
      }
    }

    return { erasedTotal: erasedSpans.length, erasedKosu, sections };
  });

  console.log(`\n=== こすくま保護チェック（吸引中） ===`);
  console.log(`消去された文字数: ${duringCheck.erasedTotal}`);
  console.log(`こすくま文字の消去回数:`, duringCheck.erasedKosu);
  for (const [key, val] of Object.entries(duringCheck.sections)) {
    console.log(`\n  ${key}:`);
    console.log(`    visible: ${val.visibleText.substring(0, 100)}`);
    console.log(`    erased: "${val.erasedChars}"`);
    const hasKosu = /[こすくま]/.test(val.erasedChars);
    console.log(`    こすくま文字が消去された: ${hasKosu ? '❌ YES — BUG!' : '✅ NO'}`);
  }

  // フレーム統計
  const ft = await page.evaluate(() => window.__perfRafLog);
  if (ft.length > 10) {
    const sorted = [...ft].sort((a, b) => a - b);
    const avg = ft.reduce((s, v) => s + v, 0) / ft.length;
    const dropped = ft.filter(t => t > 20).length;
    const janky = ft.filter(t => t > 33).length;
    console.log(`\n=== フレーム統計 (${ft.length}f) ===`);
    console.log(`  avg=${avg.toFixed(1)}ms P50=${sorted[Math.floor(ft.length*0.5)].toFixed(1)}ms P95=${sorted[Math.floor(ft.length*0.95)].toFixed(1)}ms P99=${sorted[Math.floor(ft.length*0.99)].toFixed(1)}ms`);
    console.log(`  min=${sorted[0].toFixed(1)}ms max=${sorted[ft.length-1].toFixed(1)}ms`);
    console.log(`  >20ms: ${dropped} (${(dropped/ft.length*100).toFixed(1)}%) >33ms: ${janky} (${(janky/ft.length*100).toFixed(1)}%)`);
  }

  // 復元テスト
  console.log(`\n=== 復元テスト ===`);
  const t0 = Date.now();
  await page.mouse.click(640, 400, { button: 'right' });
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    const s = await page.evaluate(() => window.__bhTest.getStats());
    if (!s.on) { console.log(`  完了: ${Date.now() - t0}ms`); break; }
    if (i === 39) console.log(`  タイムアウト: ${Date.now() - t0}ms`);
  }

  // スクリーンショット（復元後）
  await page.screenshot({ path: path.join(__dirname, 'test-kosukuma-after.png') });

  // 復元後のこすくまカウント
  const afterCount = await page.evaluate(() => {
    const re = /こすくま|こす[.．・]くま|kosukuma/gi;
    const body = document.body.innerText;
    const matches = body.match(re);
    return { total: matches ? matches.length : 0 };
  });
  console.log(`\n=== 復元後 ===`);
  console.log(`こすくま出現回数: ${afterCount.total} (前: ${beforeCount.total})`);
  console.log(afterCount.total >= beforeCount.total ? '✅ こすくま保護OK' : '❌ こすくまが減った — BUG!');

  await browser.close();
  console.log('\n=== テスト完了 ===');
})();
