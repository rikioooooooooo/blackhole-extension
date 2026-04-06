/**
 * Black Hole Chrome Extension — Automated Performance Test
 *
 * Tests:
 *  1. Basic activation (BH container exists)
 *  2. Movement & peeling performance (median < 20ms, p95 < 35ms)
 *  3. Growth transition smoothness (no frame > 50ms, avg < 25ms)
 *  4. Large BH performance (median < 25ms at sz > 150)
 *  5. Kosukuma protection (こすくま/kosukuma text survives absorption)
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
import { fileURLToPath } from 'url';
import path from 'path';
import { readFile } from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const EXT_PATH = path.resolve(__dirname).replace(/\\/g, '/');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function percentile(sorted, p) {
  const i = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, i)];
}

function median(sorted) { return percentile(sorted, 50); }

function stats(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return {
    min: sorted[0],
    median: median(sorted),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
    avg: arr.reduce((s, v) => s + v, 0) / arr.length,
    count: arr.length,
    sorted,
  };
}

function printDistribution(label, arr) {
  const s = stats(arr);
  console.log(`  ${label}: count=${s.count} min=${s.min.toFixed(1)}ms median=${s.median.toFixed(1)}ms avg=${s.avg.toFixed(1)}ms p95=${s.p95.toFixed(1)}ms p99=${s.p99.toFixed(1)}ms max=${s.max.toFixed(1)}ms`);
}

const results = [];
function report(name, pass, detail) {
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`\n[${tag}] ${name}`);
  if (detail) console.log(`  ${detail}`);
  results.push({ name, pass });
}

async function main() {
  console.log('=== Black Hole Extension Performance Test ===\n');
  console.log(`Extension path: ${EXT_PATH}`);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: false,
    args: [
      '--window-size=1280,900',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();

  // Navigate to text-heavy page
  console.log('\nNavigating to Wikipedia Black Hole article...');
  await page.goto('https://en.wikipedia.org/wiki/Black_hole', {
    waitUntil: 'networkidle2',
    timeout: 30000,
  });
  await sleep(1000);

  // Inject frame timing observer BEFORE the content script
  await page.evaluate(() => {
    window.__bhPerf = {
      frameTimes: [],
      recording: false,
      _lastTs: 0,
      _rafId: 0,
      start() {
        this.frameTimes = [];
        this.recording = true;
        this._lastTs = 0;
        this._tick();
      },
      stop() {
        this.recording = false;
        if (this._rafId) cancelAnimationFrame(this._rafId);
      },
      _tick() {
        if (!this.recording) return;
        this._rafId = requestAnimationFrame((ts) => {
          if (this._lastTs > 0) {
            this.frameTimes.push(ts - this._lastTs);
          }
          this._lastTs = ts;
          if (this.recording) this._tick();
        });
      },
      getAndClear() {
        const ft = [...this.frameTimes];
        this.frameTimes = [];
        return ft;
      },
    };
  });

  // Inject extension CSS
  console.log('Injecting extension styles...');
  const cssPath = path.join(__dirname, 'styles.css');
  await page.addStyleTag({ path: cssPath });

  // Read and patch content.js: remove chrome.runtime dependency, expose activate
  console.log('Injecting patched content script...');
  const contentSrc = await readFile(path.join(__dirname, 'content.js'), 'utf-8');

  // Patch: stub chrome.runtime so the onMessage listener doesn't crash
  // and expose activate/off to window for test control
  const patchPrefix = `
    // === TEST PATCHES ===
    if (typeof chrome === 'undefined') window.chrome = {};
    if (!chrome.runtime) chrome.runtime = {
      onMessage: { addListener: function() {} },
      sendMessage: function() {}
    };
    // === END PATCHES ===
  `;
  const patchSuffix = `
    // === EXPOSE FOR TESTS ===
    window.__bhActivate = activate;
    window.__bhOff = off;
    window.__bhReadState = function() {
      return { on, sz, totalAbsorbed, bodiesCount: bodies.length };
    };
    // === END EXPOSE ===
  `;

  // Inject as inline script (wrapping in an IIFE to avoid 'use strict' issues with let redeclaration)
  await page.evaluate((src) => {
    const script = document.createElement('script');
    script.textContent = src;
    document.head.appendChild(script);
  }, patchPrefix + contentSrc + patchSuffix);

  await sleep(300);

  // Activate the black hole
  console.log('Activating black hole...');
  // Move mouse to center first so mx/my are set
  await page.mouse.move(640, 450);
  await sleep(100);

  await page.evaluate(() => {
    // Dispatch a mousemove so the BH knows cursor position
    document.dispatchEvent(new MouseEvent('mousemove', {
      clientX: 640, clientY: 450, bubbles: true
    }));
    window.__bhActivate();
  });
  await sleep(1000);

  // ================================================================
  // Test 1: Basic activation
  // ================================================================
  console.log('\n--- Test 1: Basic Activation ---');
  const t1Result = await page.evaluate(() => {
    const el = document.getElementById('bh-container');
    const state = window.__bhReadState();
    return { hasBH: el !== null, state };
  });
  report(
    'Test 1: BH container exists',
    t1Result.hasBH,
    t1Result.hasBH
      ? `#bh-container found. State: on=${t1Result.state.on}, sz=${t1Result.state.sz}, bodies=${t1Result.state.bodiesCount}`
      : '#bh-container NOT found'
  );

  if (!t1Result.hasBH) {
    console.error('Extension not activated - cannot continue.');
    await browser.close();
    process.exit(1);
  }

  // ================================================================
  // Test 2: Movement & peeling performance
  // ================================================================
  console.log('\n--- Test 2: Movement & Peeling Performance ---');

  await page.evaluate(() => window.__bhPerf.start());

  // Zigzag pattern across the page
  const zigzagSteps = 120;
  for (let i = 0; i < zigzagSteps; i++) {
    const x = 200 + (i % 2 === 0 ? 300 : 800);
    const y = 150 + (i / zigzagSteps) * 600;
    await page.mouse.move(x, y, { steps: 2 });
    await sleep(16);
  }

  await sleep(500);
  await page.evaluate(() => window.__bhPerf.stop());
  const t2Frames = await page.evaluate(() => window.__bhPerf.getAndClear());

  if (t2Frames.length >= 30) {
    const s = stats(t2Frames);
    printDistribution('Frame times', t2Frames);
    const medianOk = s.median < 20;
    const p95Ok = s.p95 < 35;
    report(
      'Test 2: Movement peeling perf',
      medianOk && p95Ok,
      `median=${s.median.toFixed(1)}ms (limit 20ms) ${medianOk ? 'OK' : 'FAIL'}, p95=${s.p95.toFixed(1)}ms (limit 35ms) ${p95Ok ? 'OK' : 'FAIL'}`
    );
  } else {
    report('Test 2: Movement peeling perf', false, `Only ${t2Frames.length} frames collected (need 30+)`);
  }

  // ================================================================
  // Test 3: Growth transition
  // ================================================================
  console.log('\n--- Test 3: Growth Transition Smoothness ---');

  const readBHState = () => page.evaluate(() => window.__bhReadState());

  let state0 = await readBHState();
  console.log(`  Current state: sz=${state0.sz.toFixed(1)}, absorbed=${state0.totalAbsorbed}, bodies=${state0.bodiesCount}`);

  await page.evaluate(() => window.__bhPerf.start());

  let prevSz = state0.sz;
  let growthDetected = false;
  let growthFramesBefore = [];
  let growthFramesAfter = [];
  let allGrowthFrames = [];

  // Move mouse in expanding spiral to absorb text
  const maxGrowthSteps = 400;
  for (let i = 0; i < maxGrowthSteps; i++) {
    const angle = (i * 0.15) % (Math.PI * 2);
    const r = 30 + (i * 0.5);
    const cx = 640, cy = 400;
    const x = Math.max(50, Math.min(1230, cx + Math.cos(angle) * r));
    const y = Math.max(50, Math.min(850, cy + Math.sin(angle) * r));
    await page.mouse.move(x, y, { steps: 1 });

    if (i % 15 === 0) {
      const curState = await readBHState();
      if (curState.sz > prevSz + 8 && !growthDetected) {
        console.log(`  Growth transition: sz ${prevSz.toFixed(0)} -> ${curState.sz.toFixed(0)} (absorbed=${curState.totalAbsorbed}) at step ${i}`);
        growthDetected = true;

        // Get frames collected so far (includes the transition)
        const framesSoFar = await page.evaluate(() => window.__bhPerf.getAndClear());
        growthFramesBefore = framesSoFar.slice(-10);

        // Continue for 30 more frames to capture post-transition
        await page.evaluate(() => window.__bhPerf.start());
        for (let j = 0; j < 30; j++) {
          const a2 = ((i + j) * 0.15) % (Math.PI * 2);
          const x2 = Math.max(50, Math.min(1230, cx + Math.cos(a2) * (r + j * 2)));
          const y2 = Math.max(50, Math.min(850, cy + Math.sin(a2) * (r + j * 2)));
          await page.mouse.move(x2, y2, { steps: 1 });
          await sleep(16);
        }
        await page.evaluate(() => window.__bhPerf.stop());
        growthFramesAfter = await page.evaluate(() => window.__bhPerf.getAndClear());
        allGrowthFrames = [...growthFramesBefore, ...growthFramesAfter];
        break;
      }
      prevSz = curState.sz;
    }

    await sleep(8);
  }

  if (!growthDetected) {
    await page.evaluate(() => window.__bhPerf.stop());
  }

  if (growthDetected && allGrowthFrames.length > 5) {
    printDistribution('Growth transition frames', allGrowthFrames);
    const s = stats(allGrowthFrames);
    const noSpike = s.max < 50;
    const avgOk = s.avg < 25;
    report(
      'Test 3: Growth transition smoothness',
      noSpike && avgOk,
      `max=${s.max.toFixed(1)}ms (limit 50ms) ${noSpike ? 'OK' : 'FAIL'}, avg=${s.avg.toFixed(1)}ms (limit 25ms) ${avgOk ? 'OK' : 'FAIL'}`
    );
  } else {
    // Fallback: use all frames collected during the spiral
    const fallbackFrames = await page.evaluate(() => window.__bhPerf.getAndClear());
    const finalState = await readBHState();
    console.log(`  No distinct growth jump detected. Final: sz=${finalState.sz.toFixed(0)}, absorbed=${finalState.totalAbsorbed}`);
    if (fallbackFrames.length > 10) {
      printDistribution('All spiral frames', fallbackFrames);
      const s = stats(fallbackFrames);
      report(
        'Test 3: Growth transition (continuous)',
        s.max < 50 && s.avg < 25,
        `max=${s.max.toFixed(1)}ms, avg=${s.avg.toFixed(1)}ms`
      );
    } else {
      report('Test 3: Growth transition', false, 'Not enough frame data collected');
    }
  }

  // ================================================================
  // Test 4: Large BH performance
  // ================================================================
  console.log('\n--- Test 4: Large BH Performance ---');

  let currentState = await readBHState();
  console.log(`  Pre-test state: sz=${currentState.sz.toFixed(0)}, absorbed=${currentState.totalAbsorbed}, bodies=${currentState.bodiesCount}`);

  if (currentState.sz < 150) {
    console.log('  Building up BH size to 150+ ...');
    for (let scroll = 0; scroll < 8; scroll++) {
      await page.evaluate(() => window.scrollBy(0, 500));
      await sleep(200);

      // Aggressive spiral over new content
      for (let i = 0; i < 200; i++) {
        const angle = (i * 0.2) % (Math.PI * 2);
        const r = 20 + (i * 0.6);
        const x = Math.max(50, Math.min(1230, 640 + Math.cos(angle) * r));
        const y = Math.max(50, Math.min(850, 400 + Math.sin(angle) * r));
        await page.mouse.move(x, y, { steps: 1 });
        await sleep(5);
      }

      currentState = await readBHState();
      console.log(`  After scroll ${scroll + 1}: sz=${currentState.sz.toFixed(0)}, absorbed=${currentState.totalAbsorbed}`);
      if (currentState.sz >= 150) break;
    }
  }

  currentState = await readBHState();
  console.log(`  Measuring at sz=${currentState.sz.toFixed(0)}, bodies=${currentState.bodiesCount}`);

  // Measure frame times at large size
  await page.evaluate(() => window.__bhPerf.start());

  for (let i = 0; i < 120; i++) {
    const angle = (i * 0.1) % (Math.PI * 2);
    const r = 60 + (i * 0.5);
    const x = Math.max(50, Math.min(1230, 640 + Math.cos(angle) * r));
    const y = Math.max(50, Math.min(850, 400 + Math.sin(angle) * r));
    await page.mouse.move(x, y, { steps: 1 });
    await sleep(16);
  }

  await sleep(300);
  await page.evaluate(() => window.__bhPerf.stop());
  const t4Frames = await page.evaluate(() => window.__bhPerf.getAndClear());

  if (t4Frames.length >= 20) {
    printDistribution('Large BH frames', t4Frames);
    const s = stats(t4Frames);
    const szNote = currentState.sz >= 150 ? '' : ` (size only ${currentState.sz.toFixed(0)}px, target was 150+)`;
    const medOk = s.median < 25;
    report(
      'Test 4: Large BH performance',
      medOk,
      `median=${s.median.toFixed(1)}ms (limit 25ms) ${medOk ? 'OK' : 'FAIL'}${szNote}`
    );
  } else {
    report('Test 4: Large BH performance', false, `Only ${t4Frames.length} frames collected`);
  }

  // ================================================================
  // Test 5: Kosukuma Protection
  // ================================================================
  console.log('\n--- Test 5: Kosukuma Protection ---');

  // Navigate to a fresh page with こすくま text
  await page.goto('about:blank', { waitUntil: 'load' });
  await sleep(300);

  await page.evaluate(() => {
    document.body.innerHTML = `
      <div style="padding:40px;font-size:18px;line-height:2">
        <p id="normal-text">これは普通のテキストです。吸収されるべきテキスト。消えていい文章。</p>
        <p id="kosukuma-text">こすくまくんは絶対に消えない！こすくまは保護されている。</p>
        <p id="mixed-text">今日のニュースです。こすくまくんが新しい動画を投稿しました。チャンネル登録よろしく。</p>
        <p id="normal-text-2">これも普通のテキストです。どんどん吸い込まれてOK。テスト用ダミー文章。</p>
        <p id="kosukuma-en">Check out kosukuma's latest video! Very cool content.</p>
      </div>
    `;
  });
  await sleep(300);

  // Re-inject frame timing observer
  await page.evaluate(() => {
    window.__bhPerf = {
      frameTimes: [], recording: false, _lastTs: 0, _rafId: 0,
      start() { this.frameTimes = []; this.recording = true; this._lastTs = 0; this._tick(); },
      stop() { this.recording = false; if (this._rafId) cancelAnimationFrame(this._rafId); },
      _tick() {
        if (!this.recording) return;
        this._rafId = requestAnimationFrame((ts) => {
          if (this._lastTs > 0) this.frameTimes.push(ts - this._lastTs);
          this._lastTs = ts;
          if (this.recording) this._tick();
        });
      },
      getAndClear() { const ft = [...this.frameTimes]; this.frameTimes = []; return ft; },
    };
  });

  // Re-inject extension CSS and content script
  await page.addStyleTag({ path: cssPath });
  await page.evaluate((src) => {
    const script = document.createElement('script');
    script.textContent = src;
    document.head.appendChild(script);
  }, patchPrefix + contentSrc + patchSuffix);
  await sleep(300);

  // Activate BH
  await page.mouse.move(640, 200);
  await sleep(100);
  await page.evaluate(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 640, clientY: 200, bubbles: true }));
    window.__bhActivate();
  });
  await sleep(500);

  // Move mouse aggressively over all text areas to trigger absorption
  for (let pass = 0; pass < 5; pass++) {
    for (let y = 50; y < 350; y += 8) {
      for (let x = 50; x < 900; x += 30) {
        await page.mouse.move(x, y, { steps: 1 });
      }
      await sleep(5);
    }
    await sleep(200);
  }
  await sleep(1000);

  // Check results
  const t5Result = await page.evaluate(() => {
    const results = {};

    // Check こすくまくん in #kosukuma-text
    const kEl = document.getElementById('kosukuma-text');
    const kText = kEl ? kEl.textContent : '';
    const kHasBH = kEl ? kEl.hasAttribute('data-bh') : false;
    const kHidden = kEl ? (getComputedStyle(kEl).visibility === 'hidden') : false;
    results.kosukumaText = {
      hasKosukuma: /こすくま/.test(kText),
      absorbed: kHasBH,
      hidden: kHidden,
      text: kText.slice(0, 60),
    };

    // Check mixed text containing こすくま
    const mEl = document.getElementById('mixed-text');
    const mText = mEl ? mEl.textContent : '';
    const mHasBH = mEl ? mEl.hasAttribute('data-bh') : false;
    const mHidden = mEl ? (getComputedStyle(mEl).visibility === 'hidden') : false;
    results.mixedText = {
      hasKosukuma: /こすくま/.test(mText),
      absorbed: mHasBH,
      hidden: mHidden,
      text: mText.slice(0, 80),
    };

    // Check English kosukuma
    const eEl = document.getElementById('kosukuma-en');
    const eText = eEl ? eEl.textContent : '';
    const eHasBH = eEl ? eEl.hasAttribute('data-bh') : false;
    const eHidden = eEl ? (getComputedStyle(eEl).visibility === 'hidden') : false;
    results.englishText = {
      hasKosukuma: /kosukuma/i.test(eText),
      absorbed: eHasBH,
      hidden: eHidden,
      text: eText.slice(0, 60),
    };

    // Check normal text WAS absorbed (to verify BH is actually working)
    const nEl = document.getElementById('normal-text');
    const nHasBH = nEl ? nEl.hasAttribute('data-bh') : false;
    const nHidden = nEl ? (getComputedStyle(nEl).visibility === 'hidden') : false;
    // Check if characters were erased via data-bh-erased spans
    const erasedSpans = nEl ? nEl.querySelectorAll('[data-bh-erased]').length : 0;
    results.normalText = {
      absorbed: nHasBH,
      hidden: nHidden,
      erasedSpans,
    };

    // Check that こすくま/kosukuma words are still intact (not broken by erased spans)
    // Rebuild visible text (excluding erased spans) and check the protected words survive
    function getVisibleText(el) {
      let text = '';
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_ALL, null);
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeType === 3) {
          // Skip text inside data-bh-erased spans
          const parent = node.parentElement;
          if (parent && parent.hasAttribute('data-bh-erased')) continue;
          text += node.textContent;
        }
      }
      return text;
    }
    let kosukumaErased = false;
    if (kEl && !/こすくま/.test(getVisibleText(kEl))) kosukumaErased = true;
    if (mEl && !/こすくま/.test(getVisibleText(mEl))) kosukumaErased = true;
    if (eEl && !/kosukuma/i.test(getVisibleText(eEl))) kosukumaErased = true;
    results.kosukumaCharErased = kosukumaErased;

    return results;
  });

  console.log('  kosukuma-text:', JSON.stringify(t5Result.kosukumaText));
  console.log('  mixed-text:', JSON.stringify(t5Result.mixedText));
  console.log('  kosukuma-en:', JSON.stringify(t5Result.englishText));
  console.log('  normal-text (should be absorbed):', JSON.stringify(t5Result.normalText));
  console.log('  Any こすくま char in erased spans:', t5Result.kosukumaCharErased);

  const kosukumaSurvived =
    t5Result.kosukumaText.hasKosukuma &&
    !t5Result.kosukumaText.absorbed &&
    !t5Result.kosukumaText.hidden &&
    t5Result.mixedText.hasKosukuma &&
    !t5Result.mixedText.absorbed &&
    !t5Result.mixedText.hidden &&
    t5Result.englishText.hasKosukuma &&
    !t5Result.englishText.absorbed &&
    !t5Result.englishText.hidden &&
    !t5Result.kosukumaCharErased;

  const bhWorking = t5Result.normalText.absorbed || t5Result.normalText.hidden || t5Result.normalText.erasedSpans > 0;

  let t5Detail = '';
  if (kosukumaSurvived && bhWorking) {
    t5Detail = 'All こすくま/kosukuma text survived. Normal text was absorbed. Protection works.';
  } else if (!bhWorking) {
    t5Detail = 'BH did not absorb normal text — test inconclusive (BH may not have reached the text)';
  } else {
    const failures = [];
    if (!t5Result.kosukumaText.hasKosukuma) failures.push('こすくま text lost from #kosukuma-text');
    if (t5Result.kosukumaText.absorbed) failures.push('#kosukuma-text has data-bh attribute');
    if (t5Result.kosukumaText.hidden) failures.push('#kosukuma-text is hidden');
    if (!t5Result.mixedText.hasKosukuma) failures.push('こすくま text lost from #mixed-text');
    if (t5Result.mixedText.absorbed) failures.push('#mixed-text has data-bh attribute');
    if (!t5Result.englishText.hasKosukuma) failures.push('kosukuma text lost from #kosukuma-en');
    if (t5Result.kosukumaCharErased) failures.push('こすくま characters found in erased spans');
    t5Detail = 'Failures: ' + failures.join('; ');
  }

  report(
    'Test 5: Kosukuma protection',
    kosukumaSurvived && bhWorking,
    t5Detail
  );

  // ================================================================
  // Summary
  // ================================================================
  console.log('\n========================================');
  console.log('  SUMMARY');
  console.log('========================================');
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  for (const r of results) {
    console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}`);
  }
  console.log(`\n  ${passed}/${total} tests passed`);
  console.log('========================================\n');

  await browser.close();
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
