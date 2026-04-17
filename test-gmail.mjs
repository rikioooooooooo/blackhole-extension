import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contentJs = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
const stylesCss = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// eraseCharにデバッグフック: 位置ベースで正確にこすくま文字のerase試行を検出
const debugPatch = `
;(function() {
  window.__bhDebug = { erasedKosu: [], protectedKosu: [], absorbedKosu: [], protectedByPeel: 0 };

  // isProtectedChar をラップ: 保護実行を正確にカウント
  const _origIsProtected = isProtectedChar;
  isProtectedChar = function(tn, offset) {
    const result = _origIsProtected(tn, offset);
    if (result) {
      window.__bhDebug.protectedByPeel++;
    }
    return result;
  };

  // eraseChar をラップ: 位置ベースで正確判定
  const _origEraseChar = eraseChar;
  eraseChar = function(tn, offset, cpLen) {
    const text = tn.textContent;
    const ch = text.slice(offset, offset + cpLen);
    // 正確な位置チェック: このoffsetがこすくまマッチ範囲内かどうか
    const re = new RegExp(KOSUKUMA_RE.source, KOSUKUMA_RE.flags + 'g');
    let isKosuChar = false;
    let matchedWord = '';
    let m;
    // テキストノード内での直接チェック
    while ((m = re.exec(text)) !== null) {
      if (offset >= m.index && offset < m.index + m[0].length) {
        isKosuChar = true;
        matchedWord = m[0];
        break;
      }
    }
    // 祖先ウォーク（分割パターン用）
    if (!isKosuChar) {
      let el = tn.parentElement;
      for (let d = 0; el && d < 8 && !isKosuChar; d++, el = el.parentElement) {
        if (el === document.body) break;
        if (el.childNodes.length > 200) continue;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let n, fullText = '', globalOffset = -1;
        while ((n = walker.nextNode())) {
          if (n === tn) globalOffset = fullText.length + offset;
          fullText += n.textContent;
          if (fullText.length > 2000) break;
        }
        if (fullText.length > 2000) continue;
        if (globalOffset >= 0) {
          re.lastIndex = 0;
          while ((m = re.exec(fullText)) !== null) {
            if (globalOffset >= m.index && globalOffset < m.index + m[0].length) {
              isKosuChar = true;
              matchedWord = m[0];
              break;
            }
          }
        }
      }
    }

    const result = _origEraseChar(tn, offset, cpLen);
    if (isKosuChar) {
      if (result) {
        window.__bhDebug.erasedKosu.push({
          char: ch, matchedWord, nodeText: text.substring(0, 60),
        });
      } else {
        window.__bhDebug.protectedKosu.push({
          char: ch, matchedWord, nodeText: text.substring(0, 60),
        });
      }
    }
    return result;
  };

  // absorbEl をラップ
  const _origAbsorbEl = absorbEl;
  absorbEl = function(el, r) {
    const re = new RegExp(KOSUKUMA_RE.source, KOSUKUMA_RE.flags);
    const text = el.textContent || '';
    if (re.test(text)) {
      window.__bhDebug.absorbedKosu.push({
        tag: el.tagName,
        text: text.substring(0, 80),
      });
    }
    return _origAbsorbEl(el, r);
  };

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

const testContentJs = contentJs + debugPatch;

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DATA = path.join(__dirname, 'chrome-test-profile');

(async () => {
  console.log('Chrome プロファイルで起動中...');

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: CHROME_PATH,
    userDataDir: USER_DATA,
    args: [
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  console.log('Gmail にアクセス中...');
  try {
    await page.goto('https://mail.google.com/mail/u/0/#inbox', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
  } catch {
    console.log('  タイムアウト — 続行');
  }
  await sleep(5000);

  // ログイン確認
  const isLoggedIn = await page.evaluate(() => !location.href.includes('accounts.google.com'));
  if (!isLoggedIn) {
    console.log('  ❌ Gmailにログインされていません。');
    await browser.close();
    return;
  }
  console.log('  ✅ ログイン済み');

  // === Ctrl+F 検索 ===
  console.log('\n  === Ctrl+F 検索 ===');
  await page.keyboard.down('Control');
  await page.keyboard.press('f');
  await page.keyboard.up('Control');
  await sleep(800);
  await page.keyboard.type('こすくま', { delay: 50 });
  await sleep(1500);
  await page.screenshot({ path: path.join(__dirname, 'test-gmail-ctrlf.png') });
  await page.keyboard.press('Escape');
  await sleep(500);

  // === こすくまテストバナー注入 ===
  await page.evaluate(() => {
    const banner = document.createElement('div');
    banner.id = 'kosukuma-test-banner';
    banner.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:999999;background:#fff;padding:20px 40px;border:2px solid #333;font-size:18px;line-height:2;box-shadow:0 4px 12px rgba(0,0,0,0.3);border-radius:8px;';

    function mkLine(id, parts) {
      const div = document.createElement('div');
      div.id = id;
      for (const part of parts) {
        if (typeof part === 'string') {
          div.appendChild(document.createTextNode(part));
        } else {
          const el = document.createElement(part.tag);
          if (part.style) el.style.cssText = part.style;
          el.textContent = part.text;
          div.appendChild(el);
        }
      }
      return div;
    }

    banner.appendChild(mkLine('kt1', ['テスト1: ', { tag: 'b', text: 'こすくま' }, 'は保護されるべき']));
    banner.appendChild(mkLine('kt2', ['テスト2: ', { tag: 'span', text: 'こす', style: 'color:red' }, { tag: 'span', text: 'くま', style: 'color:blue' }, '分割パターン']));
    banner.appendChild(mkLine('kt3', ['テスト3: kosukumaも保護']));
    banner.appendChild(mkLine('kt4', ['テスト4: こす・くまドット区切り']));
    banner.appendChild(mkLine('kt5', ['テスト5: ABCDEFGHIJKLMNOPQRSTUVWXYZは吸引される']));
    banner.appendChild(mkLine('kt6', ['テスト6: あいうえおかきくけこさしすせそは吸引される']));

    document.body.appendChild(banner);
  });
  await sleep(500);

  // === 吸引前: こすくまインスタンスの正確な位置マッピング ===
  const beforeMap = await page.evaluate(() => {
    const re = /こすくま|こす[.．・]くま|kosukuma|kosu[._\-]kuma/gi;
    const instances = [];

    // 全テキストノードを走査して、こすくまパターンの正確な位置を記録
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      if (!text) continue;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        instances.push({
          word: m[0],
          index: m.index,
          nodeText: text.substring(Math.max(0, m.index - 10), m.index + m[0].length + 10),
          parentTag: node.parentElement ? node.parentElement.tagName : 'none',
          parentId: node.parentElement ? node.parentElement.id : '',
        });
      }
    }
    return instances;
  });
  console.log(`\n  === 吸引前こすくまマップ: ${beforeMap.length}件 ===`);
  for (const inst of beforeMap) {
    console.log(`    "${inst.word}" in <${inst.parentTag}${inst.parentId ? '#' + inst.parentId : ''}> — "...${inst.nodeText}..."`);
  }

  // === BH注入＋起動 ===
  await page.addStyleTag({ content: stylesCss });
  await page.evaluate(() => {
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = { onMessage: { addListener() {} }, sendMessage() {} };
  });
  await page.evaluate(testContentJs);
  await sleep(500);

  await page.mouse.move(640, 400);
  await page.evaluate(() => window.__bhTest.activate());
  await sleep(300);

  // === ページ全体スクロール＋スイープ ===
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const scrollSteps = Math.ceil(pageHeight / 560); // 70%のビューポート高さ
  console.log(`\n  --- ページ全体吸引 (${scrollSteps}ビューポート) ---`);

  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);

  for (let vp = 0; vp < scrollSteps; vp++) {
    const scrollY = Math.min(vp * 560, pageHeight - 800);
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await sleep(300);

    // このビューポートを密にスイープ
    for (let i = 0; i < 300; i++) {
      const row = Math.floor(i / 50);
      const col = i % 50;
      const x = (row % 2 === 0) ? 20 + col * 25 : 1260 - col * 25;
      const y = 10 + row * 130;
      await page.mouse.move(x, Math.min(y, 790));
      await sleep(16);
    }

    // ビューポートごとのデバッグ状態
    const vpDebug = await page.evaluate(() => ({
      stats: window.__bhTest.getStats(),
      debug: {
        erasedKosu: window.__bhDebug.erasedKosu.length,
        protectedKosu: window.__bhDebug.protectedKosu.length,
        absorbedKosu: window.__bhDebug.absorbedKosu.length,
      },
    }));
    console.log(`  VP${vp + 1}: absorbed=${vpDebug.stats.totalAbsorbed} | こすくまerased=${vpDebug.debug.erasedKosu} protected=${vpDebug.debug.protectedKosu} absorbBlocked=${vpDebug.debug.absorbedKosu}`);
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);

  // スクリーンショット
  await page.screenshot({ path: path.join(__dirname, 'test-gmail-during.png') });

  // === デバッグログ解析 ===
  const debugLog = await page.evaluate(() => window.__bhDebug);
  console.log(`\n  ╔═══════════════════════════════════════════╗`);
  console.log(`  ║     デバッグ: こすくま関連イベント            ║`);
  console.log(`  ╠═══════════════════════════════════════════╣`);
  console.log(`  ║ eraseChar通過（こすくま文字が消された）: ${debugLog.erasedKosu.length}件  ║`);
  console.log(`  ║ isProtectedCharで保護された:            ${debugLog.protectedKosu.length}件  ║`);
  console.log(`  ║ absorbElで保護（要素丸ごと）:           ${debugLog.absorbedKosu.length}件  ║`);
  console.log(`  ╚═══════════════════════════════════════════╝`);

  if (debugLog.erasedKosu.length > 0) {
    console.log(`\n  ❌ こすくま文字がeraseCharを通過して消された!`);
    for (const e of debugLog.erasedKosu) {
      console.log(`    文字: "${e.char}" / 親: "${e.parentText}"`);
    }
  }

  if (debugLog.protectedKosu.length > 0) {
    console.log(`\n  ✅ isProtectedCharで保護された文字:`);
    for (const p of debugLog.protectedKosu.slice(0, 20)) {
      console.log(`    文字: "${p.char}" / 親: "${p.parentText}"`);
    }
    if (debugLog.protectedKosu.length > 20) {
      console.log(`    ... 他${debugLog.protectedKosu.length - 20}件`);
    }
  }

  if (debugLog.absorbedKosu.length > 0) {
    console.log(`\n  absorbElでブロックされた要素:`);
    for (const a of debugLog.absorbedKosu.slice(0, 10)) {
      console.log(`    <${a.tag}>: "${a.text}"`);
    }
  }

  // === DOM状態の直接チェック ===
  const domCheck = await page.evaluate(() => {
    const re = /こすくま|こす[.．・]くま|kosukuma|kosu[._\-]kuma/gi;
    const results = [];

    // 全テキストノードを走査
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      if (!text) continue;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        // この「こすくま」の各文字の状態をチェック
        const charStates = [];
        for (let i = 0; i < m[0].length; i++) {
          const ch = m[0][i];
          const parent = node.parentElement;
          const isErased = parent && parent.hasAttribute('data-bh-erased');
          const isHidden = parent && parent.closest('[data-bh="1"]');
          const isVisible = parent && getComputedStyle(parent).visibility !== 'hidden';
          const color = parent ? getComputedStyle(parent).color : '';
          const fill = parent ? (getComputedStyle(parent).webkitTextFillColor || '') : '';
          const isTransparent = color === 'rgba(0, 0, 0, 0)' || color === 'transparent' ||
                               fill === 'rgba(0, 0, 0, 0)' || fill === 'transparent';
          charStates.push({ ch, isErased, isHidden: !!isHidden, isVisible, isTransparent });
        }
        const allOk = charStates.every(s => !s.isErased && !s.isHidden && s.isVisible && !s.isTransparent);
        results.push({
          word: m[0],
          parentTag: node.parentElement ? node.parentElement.tagName : 'none',
          parentId: node.parentElement ? (node.parentElement.id || '') : '',
          charStates,
          ok: allOk,
        });
      }
    }

    // erased spanの中に分割されたこすくまがないかもチェック
    const erasedSpans = document.querySelectorAll('[data-bh-erased]');
    let erasedKosuChars = 0;
    for (const sp of erasedSpans) {
      if (/[こすくま]/.test(sp.textContent)) {
        // この文字の周辺テキストでこすくまパターンをチェック
        const parent = sp.parentElement;
        if (parent) {
          const fullText = parent.textContent || '';
          if (re.test(fullText)) {
            erasedKosuChars++;
          }
        }
      }
    }

    return { instances: results, erasedKosuChars };
  });

  console.log(`\n  === DOM直接チェック ===`);
  console.log(`  こすくまインスタンス: ${domCheck.instances.length}件`);
  let passCount = 0, failCount = 0;
  for (const inst of domCheck.instances) {
    if (inst.ok) {
      passCount++;
    } else {
      failCount++;
      console.log(`  ❌ "${inst.word}" in <${inst.parentTag}${inst.parentId ? '#' + inst.parentId : ''}>`);
      for (const cs of inst.charStates) {
        if (cs.isErased || cs.isHidden || !cs.isVisible || cs.isTransparent) {
          console.log(`    "${cs.ch}": erased=${cs.isErased} hidden=${cs.isHidden} visible=${cs.isVisible} transparent=${cs.isTransparent}`);
        }
      }
    }
  }
  console.log(`  PASS: ${passCount} / FAIL: ${failCount}`);
  console.log(`  erased span内のこすくま関連文字: ${domCheck.erasedKosuChars}`);

  // === 文字復活チェック ===
  const reviveCheck = await page.evaluate(() => {
    const erasedSpans = document.querySelectorAll('[data-bh-erased]');
    let revivedCount = 0;
    for (const sp of erasedSpans) {
      const cs = getComputedStyle(sp);
      const color = cs.color;
      const fillColor = cs.webkitTextFillColor || cs.color;
      const isTransparent = color === 'rgba(0, 0, 0, 0)' || color === 'transparent' ||
                           fillColor === 'rgba(0, 0, 0, 0)' || fillColor === 'transparent';
      if (!isTransparent) revivedCount++;
    }
    return { totalErased: erasedSpans.length, revivedCount };
  });
  console.log(`\n  === 文字復活: ${reviveCheck.revivedCount}/${reviveCheck.totalErased} ===`);

  // === 復元テスト ===
  await page.evaluate(() => window.__bhTest.deactivate());
  await sleep(4500);
  const afterCheck = await page.evaluate(() => ({
    erased: document.querySelectorAll('[data-bh-erased]').length,
    hidden: document.querySelectorAll('[data-bh="1"]').length,
    particles: document.querySelectorAll('.bh-particle').length,
  }));
  console.log(`  === 復元: erased=${afterCheck.erased} hidden=${afterCheck.hidden} particles=${afterCheck.particles} ===`);

  // === 最終サマリー ===
  console.log('\n  ╔═══════════════════════════════════════════╗');
  console.log('  ║            最終テスト結果                    ║');
  console.log('  ╠═══════════════════════════════════════════╣');
  console.log(`  ║ eraseChar突破:  ${debugLog.erasedKosu.length > 0 ? '❌ ' + debugLog.erasedKosu.length + '件' : '✅ 0件'}                    ║`);
  console.log(`  ║ 保護実行:       ${debugLog.protectedKosu.length}件                           ║`);
  console.log(`  ║ DOM状態:        ${failCount > 0 ? '❌ ' + failCount + '件FAIL' : '✅ 全PASS'}                   ║`);
  console.log(`  ║ 文字復活:       ${reviveCheck.revivedCount > 0 ? '❌ ' + reviveCheck.revivedCount + '件' : '✅ 0件'}                    ║`);
  console.log(`  ║ 復元:           ${afterCheck.erased === 0 && afterCheck.hidden === 0 ? '✅' : '❌'}                           ║`);
  console.log('  ╚═══════════════════════════════════════════╝');

  console.log('\n  ブラウザを10秒後に閉じます...');
  await sleep(10000);
  await browser.close();
  console.log('\n=== Gmail テスト完了 ===');
})();
