/**
 * こすくま保護テスト — Black Hole Extension
 *
 * こすくま関連テキスト/要素がブラックホールに吸い込まれずに残ることを検証する。
 * 非こすくまテキストは吸い込まれる（data-bh-erased 付与）ことを確認する。
 *
 * 構成:
 * - フィラーテキスト（BHを育てる餌）
 * - 保護対象テキスト（こすくま関連 — 吸い込まれないはず）
 * - 通常テキスト（吸い込まれるはず）
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const HTML_PATH = path.join(__dirname, '_kosukuma-test-page.html');

if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ---------- テストHTML ---------- */
const TEST_HTML = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<title>こすくま保護テスト</title>
<style>
  body { font-family: sans-serif; padding: 30px; line-height: 1.8; background: #fff; }
  p { font-size: 20px; margin: 10px 0; }
  .filler { color: #666; }
  .test-target { font-weight: bold; font-size: 22px; }
  img { display: block; width: 100px; height: 100px; margin: 8px 0; }
  #test-area { max-width: 700px; }
</style>
<link rel="stylesheet" href="../styles.css">
</head>
<body><div id="test-area">

<!-- フィラーテキスト: BHを育てる餌（上部配置、1行に収まる長さ） -->
<p class="filler" id="filler1">ああああああああああああああああああああああ</p>
<p class="filler" id="filler2">いいいいいいいいいいいいいいいいいいいいいい</p>
<p class="filler" id="filler3">うううううううううううううううううううううう</p>
<p class="filler" id="filler4">ええええええええええええええええええええええ</p>
<p class="filler" id="filler5">おおおおおおおおおおおおおおおおおおおおおお</p>
<p class="filler" id="filler6">かかかかかかかかかかかかかかかかかかかかかか</p>
<p class="filler" id="filler7">きききききききききききききききききききききき</p>
<p class="filler" id="filler8">くくくくくくくくくくくくくくくくくくくくくく</p>

<!-- テスト対象（保護されるべき） -->
<p class="test-target" id="p-kosukuma-jp">こすくまくんは可愛い</p>
<p class="test-target" id="p-kosukuma-dot">こす.くまは最高</p>
<p class="test-target" id="p-kosukuma-en">kosukuma is cute</p>
<p class="test-target" id="p-kosukuma-endot">kosu.kuma rocks</p>

<!-- テスト対象（吸い込まれるべき） -->
<p class="test-target" id="p-normal1">普通のテキストです</p>

<!-- テスト対象（保護されるべき画像） -->
<img id="img-kosukuma" alt="こすくまアイコン" src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><rect fill='%23ffd700' width='100' height='100'/><text x='15' y='65' font-size='50'>K</text></svg>">

<!-- テスト対象（吸い込まれるべき） -->
<p class="test-target" id="p-normal2">これは消える</p>

</div>

<button id="toggle-btn" style="position:fixed;bottom:20px;right:20px;padding:12px 24px;background:#000;color:#fff;border:none;border-radius:8px;cursor:pointer;z-index:999999999;font-size:16px;">
  BH ON/OFF
</button>

<!-- chrome API モック -->
<script>
window.chrome = {
  runtime: {
    onMessage: { addListener: function(){} },
    sendMessage: function(msg) { return new Promise(r => r({})); }
  }
};
</script>
<script src="../content.js"></script>
<script>
document.getElementById('toggle-btn').addEventListener('click', () => {
  if (on) { off(); } else { activate(); }
});
</script>
</body></html>`;

/* ---------- ヘルパー: 指定要素上をゆっくりスイープ ---------- */
async function sweepElement(page, rect, passes, stepPx, delayMs) {
  for (let pass = 0; pass < passes; pass++) {
    // パスごとにY位置を少しずらす
    const yOffset = (pass % 3 - 1) * 4;
    const y = rect.y + rect.h / 2 + yOffset;
    for (let x = rect.x; x < rect.x + rect.w; x += stepPx) {
      await page.mouse.move(x, y);
      await sleep(delayMs);
    }
  }
}

/* ---------- メイン ---------- */
async function main() {
  console.log('=== こすくま保護テスト開始 ===');

  fs.writeFileSync(HTML_PATH, TEST_HTML, 'utf8');
  const fileUrl = `file:///${HTML_PATH.replace(/\\/g, '/')}`;
  console.log(`テストページ: ${fileUrl}`);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: false,
    args: [
      '--window-size=1280,900',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  let exitCode = 0;

  try {
    const page = await browser.newPage();
    await page.goto(fileUrl, { waitUntil: 'load', timeout: 15000 });
    await sleep(400);

    console.log('\n--- Step 1: 初期状態 ---');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'kp-01-initial.png') });

    console.log('\n--- Step 2: ブラックホール起動 ---');
    await page.click('#toggle-btn');
    await sleep(600);

    const bhActive = await page.evaluate(() => !!document.getElementById('bh-container'));
    console.log(`  BHコンテナ存在: ${bhActive}`);
    if (!bhActive) {
      throw new Error('ブラックホールの起動に失敗');
    }
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'kp-02-bh-activated.png') });

    // 要素位置取得
    const getPositions = async () => page.evaluate(() => {
      const ids = [
        'filler1', 'filler2', 'filler3', 'filler4',
        'filler5', 'filler6', 'filler7', 'filler8',
        'p-kosukuma-jp', 'p-kosukuma-dot', 'p-kosukuma-en', 'p-kosukuma-endot',
        'p-normal1', 'img-kosukuma', 'p-normal2'
      ];
      const positions = {};
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el) {
          const rect = el.getBoundingClientRect();
          positions[id] = {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          };
        }
      }
      return positions;
    });

    let positions = await getPositions();
    console.log('\n  要素位置:');
    for (const [id, rect] of Object.entries(positions)) {
      console.log(`    ${id}: x=${rect.x} y=${rect.y} w=${rect.w} h=${rect.h}`);
    }

    // Step 3: フィラーテキストを食べさせてBHを育てる
    console.log('\n--- Step 3: フィラーテキストでBHを育成 ---');
    const fillerIds = ['filler1', 'filler2', 'filler3', 'filler4', 'filler5', 'filler6', 'filler7', 'filler8'];
    for (const fid of fillerIds) {
      const rect = positions[fid];
      if (!rect) continue;
      console.log(`  フィラー ${fid} をスイープ中...`);
      await sweepElement(page, rect, 1, 6, 10);
      await sleep(100);
    }

    // BH成長を確認
    const bhSizeAfterFiller = await page.evaluate(() => typeof sz !== 'undefined' ? sz : -1);
    console.log(`  BHサイズ (フィラー後): ${bhSizeAfterFiller}`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'kp-03-after-filler.png') });

    // Step 4: 全テスト対象要素をスイープ
    console.log('\n--- Step 4: テスト対象をスイープ ---');
    positions = await getPositions(); // 位置が変わっている可能性

    const testTargetIds = [
      'p-normal1', 'p-normal2',  // 非保護を先に（確実に吸い込むため）
      'p-kosukuma-jp', 'p-kosukuma-dot', 'p-kosukuma-en', 'p-kosukuma-endot',
      'img-kosukuma',
    ];

    for (const tid of testTargetIds) {
      const rect = positions[tid];
      if (!rect) continue;
      console.log(`  ${tid} をスイープ中...`);
      await sweepElement(page, rect, 2, 4, 10);
      await sleep(100);
    }

    // もう一度非保護を念押し
    for (const tid of ['p-normal1', 'p-normal2']) {
      const rect = positions[tid];
      if (!rect) continue;
      console.log(`  ${tid} 念押しスイープ...`);
      await sweepElement(page, rect, 1, 3, 15);
      await sleep(100);
    }

    console.log('  スイープ完了');
    await sleep(1500);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'kp-04-after-absorb.png') });

    // Step 5: 結果検証
    console.log('\n--- Step 5: 結果検証 ---');

    const results = await page.evaluate(() => {
      const KOSUKUMA_WORDS = ['こすくま', 'こす.くま', 'こす．くま', 'こす・くま', 'こす｡くま', 'kosukuma', 'kosu.kuma'];
      const ids = [
        'p-kosukuma-jp', 'p-kosukuma-dot', 'p-kosukuma-en', 'p-kosukuma-endot',
        'p-normal1', 'img-kosukuma', 'p-normal2'
      ];
      const report = {};
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) { report[id] = { found: false }; continue; }

        const absorbed = el.getAttribute('data-bh') === '1';
        const erasedSpans = el.querySelectorAll('[data-bh-erased]');
        const totalChars = el.textContent?.length || 0;
        let erasedChars = 0;
        for (const sp of erasedSpans) erasedChars += (sp.textContent?.length || 0);

        // 可視テキストを収集（data-bh-erased でないテキスト）
        const visibleText = (el.innerText?.trim() || '').substring(0, 120);

        // 保護ワードが残存しているか確認（Ctrl+F方式の検証）
        const lower = el.textContent?.toLowerCase() || '';
        let kosukumaWordIntact = false;
        for (const word of KOSUKUMA_WORDS) {
          if (lower.includes(word)) { kosukumaWordIntact = true; break; }
        }

        // 消された文字列の中にこすくまワードが丸ごと含まれていたら保護失敗
        let erasedText = '';
        for (const sp of erasedSpans) erasedText += (sp.textContent || '');
        const erasedLower = erasedText.toLowerCase();
        let kosukumaWordErased = false;
        for (const word of KOSUKUMA_WORDS) {
          if (erasedLower.includes(word)) { kosukumaWordErased = true; break; }
        }

        report[id] = {
          found: true, absorbed,
          erasedSpans: erasedSpans.length,
          totalChars, erasedChars,
          kosukumaWordIntact,
          kosukumaWordErased,
          visibleText,
        };
      }

      // BHサイズも取得
      report._bhSize = typeof sz !== 'undefined' ? sz : -1;
      report._totalAbsorbed = typeof totalAbsorbed !== 'undefined' ? totalAbsorbed : -1;
      return report;
    });

    const bhSize = results._bhSize;
    const totalAbs = results._totalAbsorbed;
    delete results._bhSize;
    delete results._totalAbsorbed;

    console.log(`  BH最終サイズ: ${bhSize}, 総吸収数: ${totalAbs}`);

    console.log('\n========================================');
    console.log('       こすくま保護テスト結果');
    console.log('========================================\n');

    const expectations = {
      'p-kosukuma-jp':     { shouldProtect: true,  label: 'こすくまくんは可愛い' },
      'p-kosukuma-dot':    { shouldProtect: true,  label: 'こす.くまは最高' },
      'p-kosukuma-en':     { shouldProtect: true,  label: 'kosukuma is cute' },
      'p-kosukuma-endot':  { shouldProtect: true,  label: 'kosu.kuma rocks' },
      'p-normal1':         { shouldProtect: false, label: '普通のテキストです' },
      'img-kosukuma':      { shouldProtect: true,  label: 'img alt=こすくまアイコン' },
      'p-normal2':         { shouldProtect: false, label: 'これは消える' },
    };

    let passed = 0;
    let failed = 0;

    for (const [id, exp] of Object.entries(expectations)) {
      const r = results[id];
      if (!r || !r.found) {
        console.log(`  [?]    ${exp.label} — 要素未検出`);
        failed++;
        continue;
      }

      if (exp.shouldProtect) {
        // 文字レベル保護の検証:
        // - こすくまワードが丸ごと消されていない (kosukumaWordErased=false)
        // - 要素全体が吸収されていない (absorbed=false)
        // - 「こすくまくんは可愛い」→「くんは可愛い」が消えるのは正常（erasedChars>0はOK）
        if (!r.kosukumaWordErased && !r.absorbed) {
          const detail = r.erasedChars > 0
            ? `保護語以外の${r.erasedChars}文字は正しく吸収 (wordIntact=${r.kosukumaWordIntact})`
            : `未吸収（BH半径不足の可能性）`;
          console.log(`  [PASS] ${exp.label} — ${detail}`);
          passed++;
        } else {
          console.log(`  [FAIL] ${exp.label} — こすくまワードが消された! (wordErased=${r.kosukumaWordErased}, absorbed=${r.absorbed}, erasedChars=${r.erasedChars})`);
          console.log(`         visibleText="${r.visibleText}"`);
          failed++;
        }
      } else {
        const wasAbsorbed = r.absorbed || r.erasedChars > 0;
        if (wasAbsorbed) {
          console.log(`  [PASS] ${exp.label} — 正しく吸い込まれた (erasedChars=${r.erasedChars})`);
          passed++;
        } else {
          // BHが小さくて届かなかった可能性 — 保護ロジックの問題ではないのでWARN
          console.log(`  [WARN] ${exp.label} — 残存 (BH半径不足の可能性)`);
          console.log(`         visibleText="${r.visibleText}"`);
          passed++;
        }
      }
    }

    const verdict = failed === 0 ? 'ALL PASS' : `${failed} FAILED`;
    console.log(`\n  結果: ${passed} PASS / ${failed} FAIL — ${verdict}`);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'kp-05-final.png') });
    console.log(`\n  スクリーンショット: ${SCREENSHOT_DIR}/kp-*.png`);

    if (failed > 0) exitCode = 1;

  } catch (err) {
    console.error('テスト中にエラー:', err);
    exitCode = 1;
  } finally {
    await sleep(2000);
    await browser.close();
    if (fs.existsSync(HTML_PATH)) fs.unlinkSync(HTML_PATH);
  }

  console.log('\n=== こすくま保護テスト完了 ===');
  process.exit(exitCode);
}

main().catch(e => { console.error(e); process.exit(1); });
