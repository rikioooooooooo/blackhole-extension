'use strict';

/* ================================================================
   Black Hole v7 — Pure DOM Engine

   ■ キャンバス不要 — 元ページをそのまま表示
   ■ caretRangeFromPoint で1文字検出
   ■ テキストノードを分割し、文字を <span style="color:transparent"> で消去
   ■ 背景色はそのまま残る（黒背景なし）
   ■ スクロールしても文字は復活しない（DOM永続変更）
   ■ 文字がオブジェクトとして物理的にブラックホールへ吸い込まれる
   ================================================================ */

/* ==== 定数 ==== */
const BH_INITIAL  = 12;
const BH_FIELD    = 4;

const GRAVITY     = 5000;
const TANGENT     = 0.12;
const DAMPING     = 0.990;
const MAX_SPEED   = 1600;
const INIT_SPEED  = 200;
const MAX_SPEED_SQ = MAX_SPEED * MAX_SPEED;

const GROW_RATE   = 0.03;
const MAX_BODIES  = 800;
const TILE_PX     = 18;
const MAX_TILES   = 200;

const PHASE2      = 150;
const PHASE_FIXED = 200;

const SKIP = new Set([
  'HTML','BODY','HEAD','SCRIPT','STYLE','LINK','META','NOSCRIPT','TEMPLATE'
]);
const LEAF_TAGS = new Set([
  'IMG','INPUT','TEXTAREA','SELECT','VIDEO','AUDIO','CANVAS','SVG','HR','BR',
  'BUTTON','OBJECT','EMBED'
]);

const COL1 = ['#8B5CF6','#3B82F6','#7C3AED'];
const COL2 = ['#8B5CF6','#3B82F6','#EF4444','#7C3AED'];
const COL3 = ['#F97316','#EF4444','#DC2626','#EA580C'];

/* ==== 状態 ==== */
let on = false, toggling = false;
let sz = BH_INITIAL;
let mx = 0, my = 0;
let ctr = null;
let raf = null, ambId = null, ambCnt = 0;
let lastTs = 0, samplePhase = 0, prevMx = 0, prevMy = 0;
let totalAbsorbed = 0;

let szDirty = false;
let lastPosMx = -1, lastPosMy = -1;
let frameCount = 0;


/* ==== MutationObserver フレーム抑制 ==== */
let _suppressMutationHandler = false;

/* ==== getComputedStyle キャッシュ（毎フレームのstyle recalc回避） ==== */
const _posCache = new WeakMap();
let _posCacheGen = 0;
function getCachedPosition(el) {
  const cached = _posCache.get(el);
  if (cached && cached.gen === _posCacheGen) return cached.pos;
  const pos = getComputedStyle(el).position;
  _posCache.set(el, { pos, gen: _posCacheGen });
  return pos;
}

const _bgCache = new WeakMap();
let _bgCacheGen = 0;

const _visTextCache = new WeakMap();
let _visTextGen = 0;

/* ==== Full computed style cache (fontSize, fontFamily, fontWeight, color) ==== */
const _fullStyleCache = new WeakMap();
let _fullStyleGen = 0;
function getCachedFullStyle(el) {
  const c = _fullStyleCache.get(el);
  if (c && c.gen === _fullStyleGen) return c;
  const s = getComputedStyle(el);
  const entry = { fontSize: s.fontSize, fontFamily: s.fontFamily,
                  fontWeight: s.fontWeight, color: s.color, gen: _fullStyleGen };
  _fullStyleCache.set(el, entry);
  return entry;
}

function getCachedBgImage(el) {
  const cached = _bgCache.get(el);
  if (cached && cached.gen === _bgCacheGen) return cached.bg;
  const bg = getComputedStyle(el).backgroundImage;
  _bgCache.set(el, { bg, gen: _bgCacheGen });
  return bg;
}

/* ==== Per-frame collection pools (GC圧力削減) ==== */
let _ptsFlat = new Float64Array(512);
let _ptsLen = 0;
const _triedEls = new Set();
const _sweepOffsets = new Map();

/* ==== DOM defrag ==== */
const _dirtyParents = new Set();
let _lastNormalize = 0;

/* ==== SPA再消去（文字復活防止） ==== */
const _dirtyReEraseTargets = new Set();
let _reEraseScheduled = false;
function _scheduleReErase() {
  if (_reEraseScheduled) return;
  _reEraseScheduled = true;
  requestAnimationFrame(() => {
    _reEraseScheduled = false;
    if (!on) { _dirtyReEraseTargets.clear(); return; }
    _suppressMutationHandler = true;
    const remaining = new Set();
    for (const el of _dirtyReEraseTargets) {
      if (!el.isConnected) continue;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let tn;
      let didErase = false;
      while ((tn = walker.nextNode())) {
        const p = tn.parentElement;
        if (!p || p.hasAttribute('data-bh-erased')) continue;
        const text = tn.textContent;
        if (!text.trim()) continue;
        for (let i = 0; i < text.length; i++) {
          const cpl = cpLength(text, i);
          const ch = text.slice(i, i + cpl);
          if (!ch.trim()) continue;
          if (isProtectedChar(tn, i)) continue;
          const span = eraseChar(tn, i, cpl);
          if (span) {
            didErase = true;
            break; // TreeWalker無効化
          }
        }
        if (didErase) break; // 外側ループも抜ける
      }
      if (didErase) {
        remaining.add(el); // まだ残っているので次フレームも処理
      }
    }
    _dirtyReEraseTargets.clear();
    for (const el of remaining) _dirtyReEraseTargets.add(el);
    spaObs.takeRecords();
    _suppressMutationHandler = false;
    // まだ未処理のターゲットがあれば再スケジュール
    if (_dirtyReEraseTargets.size > 0) {
      _scheduleReErase();
    }
  });
}
function _reEraseViewport() {
  // BH半径内の領域をサンプリングして、erasedでないテキストを検出・再消去
  const scanR = Math.min(sz * 0.8, 300);
  const step = 40;
  let count = 0;
  for (let dx = -scanR; dx <= scanR && count < 5; dx += step) {
    for (let dy = -scanR; dy <= scanR && count < 5; dy += step) {
      if (dx * dx + dy * dy > scanR * scanR) continue;
      const px = mx + dx, py = my + dy;
      if (px < 0 || py < 0 || px > window.innerWidth || py > window.innerHeight) continue;
      const range = document.caretRangeFromPoint(px, py);
      if (!range || range.startContainer.nodeType !== 3) continue;
      const tn = range.startContainer;
      const offset = range.startOffset;
      if (tn.parentElement && tn.parentElement.hasAttribute('data-bh-erased')) continue;
      if (offset >= tn.textContent.length) continue;
      const cpl = cpLength(tn.textContent, offset);
      const ch = tn.textContent.slice(offset, offset + cpl);
      if (!ch.trim()) continue;
      if (isProtectedChar(tn, offset)) continue;
      // この文字はerasedであるべきなのにerasedでない → 再消去
      eraseChar(tn, offset, cpl);
      count++;
    }
  }
}
function maybeNormalize(ts) {
  if (_dirtyParents.size === 0) return;
  if (ts - _lastNormalize < 800) return;
  _lastNormalize = ts;
  const parents = [];
  let count = 0;
  for (const el of _dirtyParents) {
    if (count >= 80) break;
    parents.push(el);
    _dirtyParents.delete(el);
    count++;
  }
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback((deadline) => {
      _suppressMutationHandler = true;
      for (const el of parents) {
        if (deadline.timeRemaining() < 1) { _dirtyParents.add(el); continue; }
        // erased spanが残っている親はnormalizeすると透明化が壊れるのでスキップ
        if (el.querySelector && el.querySelector('[data-bh-erased]')) { _dirtyParents.add(el); continue; }
        try { el.normalize(); } catch {}
      }
      spaObs.takeRecords();
      _suppressMutationHandler = false;
    }, { timeout: 3000 });
  } else {
    _suppressMutationHandler = true;
    for (const el of parents) {
      if (el.querySelector && el.querySelector('[data-bh-erased]')) { _dirtyParents.add(el); continue; }
      try { el.normalize(); } catch {}
    }
    spaObs.takeRecords();
    _suppressMutationHandler = false;
  }
}

/* ==== こすくま保護 ==== */
// ZW = ゼロ幅文字クラス（Gmail/CloudSignが挿入するU+2060 WORD JOINER等を許容）
const _ZW = '[\u200B-\u200D\u2060\uFEFF\u00AD]*';
const KOSUKUMA_RE = new RegExp(
  'こ'+_ZW+'す'+_ZW+'く'+_ZW+'ま|' +
  'こ'+_ZW+'す'+_ZW+'[.．・]'+_ZW+'く'+_ZW+'ま|' +
  'k'+_ZW+'o'+_ZW+'s'+_ZW+'u'+_ZW+'k'+_ZW+'u'+_ZW+'m'+_ZW+'a|' +
  'k'+_ZW+'o'+_ZW+'s'+_ZW+'u'+_ZW+'[._\\-]'+_ZW+'k'+_ZW+'u'+_ZW+'m'+_ZW+'a',
  'i'
);
const KOSUKUMA_RE_G = new RegExp(KOSUKUMA_RE.source, KOSUKUMA_RE.flags + 'g');

/* 階段式成長テーブル: [吸収数, ジャンプ先サイズ] */
const GROWTH_STEPS = [
  [90,    28],
  [240,   55],
  [480,   95],
  [840,  150],
  [1350, 220],
  [2100, 300],
  [3000, 400],
];

const tids      = new Set();
const bodies    = [];
const ambParts  = new Set();

/* ==== メッセージ ==== */
chrome.runtime.onMessage.addListener((m) => {
  if (m.action === 'toggle') {
    if (toggling) return;
    on ? off() : activate();
  }
});

/* ==== SPA + YouTube サムネ復活防止 ==== */
const spaObs = new MutationObserver((mutations) => {
  if (_suppressMutationHandler) return;
  if (on && ctr && !document.body.contains(ctr)) mkBH();

  // 吸収済み要素の中に新しく追加されたIMG/VIDEO等も自動で隠す
  if (!on) return;
  for (const m of mutations) {
    if (m.type !== 'childList') continue;

    // SPA対策: フレームワークがdata-bh-erasedスパンを削除→テキストノード復活を検出
    for (const node of m.removedNodes) {
      if (node.nodeType === 1) {
        // 直接のdata-bh-erasedスパン削除、またはdata-bh-erasedを含む親要素の削除
        if ((node.hasAttribute && node.hasAttribute('data-bh-erased')) ||
            (node.querySelector && node.querySelector('[data-bh-erased]'))) {
          const target = m.target;
          if (target && target.nodeType === 1) {
            _dirtyReEraseTargets.add(target);
          }
        }
      }
    }

    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      // 親が吸収済みなら新しい子も隠す
      const parent = node.parentElement;
      if (parent && parent.getAttribute('data-bh') === '1') {
        // こすくま保護: 保護テキストを含むノードは隠さない
        if (node.textContent && KOSUKUMA_RE.test(node.textContent)) continue;
        node.style.visibility = 'hidden';
        node.style.pointerEvents = 'none';
        continue;
      }
      // YouTube: 新しく挿入されたIMGがマウス付近にあれば即吸収
      if ((node.tagName === 'IMG' || node.tagName === 'VIDEO') && node.getAttribute('data-bh') !== '1') {
        const nr = node.getBoundingClientRect();
        if (nr.width > 2 && nr.height > 2) {
          const dist = Math.hypot(mx - (nr.left + nr.width / 2), my - (nr.top + nr.height / 2));
          if (dist < sz + 50) {
            if (node.tagName === 'IMG') {
              const bs = tileImg(node);
              for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
            } else {
              const bs = tileVideo(node);
              for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
            }
          }
        }
      }
    }
  }

  // 復活したテキストを再消去（バッチ処理）
  if (_dirtyReEraseTargets.size > 0) {
    _scheduleReErase();
  }
});
spaObs.observe(document.body || document.documentElement, { childList: true, subtree: true });

/* ==== ON ==== */
function activate() {
  if (!document.body) { toggling = false; return; }
  toggling = true;
  on = true;
  _suppressMutationHandler = true; // activate〜最初のloop間のフレームワーク再レンダー防止
  sz = BH_INITIAL; ambCnt = 0; samplePhase = 0;
  bodies.length = 0; lastTs = 0; totalAbsorbed = 0;
  prevMx = mx; prevMy = my;

  // data-bh-erased CSS rule注入（ページCSSの!importantに負けない二重防御）
  if (!document.getElementById('bh-erased-style')) {
    const st = document.createElement('style');
    st.id = 'bh-erased-style';
    st.textContent = '[data-bh-erased][data-bh-erased]{color:transparent!important;-webkit-text-fill-color:transparent!important}';
    document.head.appendChild(st);
  }

  mkBH();
  document.addEventListener('mousemove', onM);
  document.addEventListener('contextmenu', onRC);
  // YouTube等のhoverトリガーを無効化
  for (const ev of HOVER_EVENTS) document.addEventListener(ev, blockHover, true);
  raf = requestAnimationFrame(loop);
  requestAnimationFrame(() => { toggling = false; });
}

/* ==== OFF — 復元アニメーション ==== */
function off() {
  toggling = true; on = false;


  // ループ・入力を即停止
  if (raf) { cancelAnimationFrame(raf); raf = null; }
  document.removeEventListener('contextmenu', onRC);
  for (const ev of HOVER_EVENTS) document.removeEventListener(ev, blockHover, true);

  // 吸引中のパーティクル除去
  for (const b of bodies) b.el.remove();
  bodies.length = 0;

  // 環境パーティクル除去
  for (const p of ambParts) {
    p.getAnimations().forEach(a => a.cancel());
    p.remove();
  }
  ambParts.clear();
  ambCnt = 0;

  // ---- 復元対象を収集 ----
  const restoreJobs = [];
  const bhX = mx, bhY = my;

  // 消したテキスト
  const erased = document.querySelectorAll('[data-bh-erased]');
  for (const sp of erased) {
    const rc = sp.getBoundingClientRect();
    if (rc.width < 0.3 || rc.height < 0.3) continue;
    const pe = sp.parentElement;
    const st = pe ? getComputedStyle(pe) : null;
    restoreJobs.push({
      type: 'text', span: sp,
      text: sp.textContent,
      tx: rc.left + rc.width / 2, ty: rc.top + rc.height / 2,
      fontSize: st ? st.fontSize : '16px',
      fontFamily: st ? st.fontFamily : 'inherit',
      fontWeight: st ? st.fontWeight : 'normal',
      color: st ? st.color : '#000'
    });
  }

  // 隠した要素
  const hidden = document.querySelectorAll('[data-bh="1"]');
  for (const el of hidden) {
    const rc = el.getBoundingClientRect();
    restoreJobs.push({
      type: 'element', el,
      tx: rc.left + rc.width / 2, ty: rc.top + rc.height / 2
    });
  }

  // リストマーカー
  const markers = document.querySelectorAll('[data-bh-marker]');
  for (const el of markers) {
    const rc = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    const parentList = el.closest('ol, ul');
    let markerText = '•';
    if (parentList && parentList.tagName === 'OL') {
      const items = [...parentList.children].filter(c => c.tagName === 'LI');
      markerText = (items.indexOf(el) + 1) + '.';
    }
    restoreJobs.push({
      type: 'marker', el, text: markerText,
      tx: rc.left - 10, ty: rc.top + (parseFloat(st.fontSize) || 16) / 2,
      fontSize: st.fontSize, fontFamily: st.fontFamily,
      fontWeight: st.fontWeight, color: st.color
    });
  }

  if (restoreJobs.length === 0) {
    finishOff();
    return;
  }

  // ---- BHから文字が飛び出す復元アニメーション ----
  // ランダム順にシャッフル（自然な噴出感）
  for (let i = restoreJobs.length - 1; i > 0; i--) {
    const j = Math.random() * (i + 1) | 0;
    [restoreJobs[i], restoreJobs[j]] = [restoreJobs[j], restoreJobs[i]];
  }

  let completed = 0;
  const total = restoreJobs.length;
  // 3秒デッドライン: 発射2秒 + 最後のアニメ飛行0.8秒 + fadeout余裕0.2秒
  const DEADLINE_MS = 3000;
  const MAX_ANIM_DUR = 800;
  const LAUNCH_BUDGET = DEADLINE_MS - MAX_ANIM_DUR - 200;  // 2000ms
  const TOTAL_LAUNCH_MS = Math.min(LAUNCH_BUDGET, total * 3);
  const STAGGER = Math.max(0.5, TOTAL_LAUNCH_MS / total);
  const startSz = sz;

  restoreJobs.forEach((job, i) => {
    const tid = setTimeout(() => {
      tids.delete(tid);

      // BHが縮む（吐き出すほど小さくなる）
      const progress = (i + 1) / total;
      const newSz = Math.max(BH_INITIAL, startSz * (1 - progress * 0.9));
      if (ctr) {
        ctr.style.setProperty('--bh-size', newSz + 'px');
        // 吐き出し時に微振動（offsetHeight強制リフロー排除: animation再トリガーをrAFで分離）
        if (i % 8 === 0) {
          ctr.classList.remove('bh-gulp');
          requestAnimationFrame(() => { if (ctr) ctr.classList.add('bh-gulp'); });
        }
      }

      launchRestore(job, bhX, bhY, total, () => {
        completed++;
        if (completed >= total) finishOff();
      });
    }, i * STAGGER);
    tids.add(tid);
  });

  // デッドラインタイマー: 3秒で強制完了
  const deadlineTid = setTimeout(() => {
    tids.delete(deadlineTid);
    if (completed < total) {
      for (const t of tids) clearTimeout(t);
      tids.clear();
      finishOff();
    }
  }, DEADLINE_MS);
  tids.add(deadlineTid);

  document.removeEventListener('mousemove', onM);
}

/* ---- 1つの復元パーティクルを射出 ---- */
function launchRestore(job, bhX, bhY, total, onDone) {
  const p = document.createElement('span');
  p.className = 'bh-particle';

  if (job.type === 'text' || job.type === 'marker') {
    p.textContent = job.text;
    p.style.cssText =
      `position:fixed;left:${bhX}px;top:${bhY}px;` +
      `font-size:${job.fontSize};font-family:${job.fontFamily};` +
      `font-weight:${job.fontWeight};color:${job.color};` +
      `line-height:1;margin:0;padding:0;background:none;` +
      `pointer-events:none;z-index:2147483645;contain:layout style paint;border-radius:0;` +
      `transform:scale(0);opacity:0;`;
  } else {
    p.textContent = '';
    p.style.cssText =
      `position:fixed;left:${bhX}px;top:${bhY}px;width:8px;height:8px;` +
      `background:#888;border-radius:50%;` +
      `pointer-events:none;z-index:2147483645;contain:layout style paint;` +
      `transform:scale(0);opacity:0;`;
  }
  document.body.appendChild(p);

  // BH中心→一度外に飛び出す→螺旋→元の位置
  const dx = job.tx - bhX, dy = job.ty - bhY;
  const dist = Math.hypot(dx, dy) || 1;
  const perpX = -dy / dist, perpY = dx / dist;
  const curve = (Math.random() - 0.5) * dist * 0.8;
  // 一度BHの反対方向に飛び出す
  const burstX = -dx * 0.15 + perpX * curve * 0.3;
  const burstY = -dy * 0.15 + perpY * curve * 0.3;
  const midX = dx * 0.5 + perpX * curve;
  const midY = dy * 0.5 + perpY * curve;
  const rotDir = (Math.random() - 0.5) * 720;

  // totalが多いほどアニメを短縮（3秒に収める）
  const dur = total > 500 ? 150 + Math.random() * 150
            : total > 200 ? 250 + Math.random() * 200
            : total > 50  ? 400 + Math.random() * 300
            :               500 + Math.random() * 300;

  const anim = p.animate([
    { transform: 'scale(0) rotate(0deg)', opacity: 0 },
    { transform: `translate(${burstX}px,${burstY}px) scale(1.5) rotate(${rotDir * 0.3}deg)`, opacity: 1, offset: 0.2 },
    { transform: `translate(${midX}px,${midY}px) scale(1.1) rotate(${rotDir * 0.7}deg)`, opacity: 0.9, offset: 0.6 },
    { transform: `translate(${dx}px,${dy}px) scale(1) rotate(0deg)`, opacity: 1 }
  ], { duration: dur, easing: 'cubic-bezier(0.1, 0.9, 0.3, 1)', fill: 'forwards' });

  anim.onfinish = () => {
    p.remove();

    // 実際の復元処理
    if (job.type === 'text' && job.span && job.span.parentNode) {
      job.span.style.color = '';
      job.span.removeAttribute('data-bh-erased');
    } else if (job.type === 'element' && job.el) {
      job.el.removeAttribute('data-bh');
      job.el.style.visibility = '';
      job.el.style.pointerEvents = '';
    } else if (job.type === 'marker' && job.el) {
      job.el.removeAttribute('data-bh-marker');
      job.el.style.listStyle = '';
    }

    onDone();
  };
}

/* ---- 復元完了後のクリーンアップ ---- */
function finishOff() {
  // テキストノード正規化（data-bh-erasedが残っている場合のフォールバック）
  const leftover = document.querySelectorAll('[data-bh-erased]');
  const parents = new Set();
  for (const sp of leftover) {
    const par = sp.parentNode;
    if (!par) continue;
    sp.style.color = '';
    sp.removeAttribute('data-bh-erased');
    parents.add(par);
  }
  // spanを解除してテキストノードに戻す
  for (const par of parents) par.normalize();

  // 残りのフラグ除去
  const hidden = document.querySelectorAll('[data-bh="1"]');
  for (const el of hidden) {
    el.removeAttribute('data-bh'); el.style.visibility = ''; el.style.pointerEvents = '';
    if (el.tagName === 'VIDEO' && el.paused) try { el.play(); } catch {}
  }
  const markers = document.querySelectorAll('[data-bh-marker]');
  for (const el of markers) { el.removeAttribute('data-bh-marker'); el.style.listStyle = ''; }
  const befores = document.querySelectorAll('[data-bh-before]');
  for (const el of befores) el.removeAttribute('data-bh-before');
  const afters = document.querySelectorAll('[data-bh-after]');
  for (const el of afters) el.removeAttribute('data-bh-after');

  // erased style rule除去
  const erasedStyle = document.getElementById('bh-erased-style');
  if (erasedStyle) erasedStyle.remove();
  // Shadow DOM内のerased-styleも除去
  const shadowStyles = document.querySelectorAll('#bh-erased-style-shadow');
  for (const s of shadowStyles) s.remove();
  // 再消去キューをクリア
  _dirtyReEraseTargets.clear();

  for (const t of tids) clearTimeout(t);
  tids.clear();

  // BHフェードアウト
  if (ctr) {
    ctr.classList.add('bh-fadeout');
    const fin = () => { if (ctr) { ctr.remove(); ctr = null; } toggling = false; };
    const fb = setTimeout(() => { fin(); }, 700);
    tids.add(fb);
    ctr.addEventListener('animationend', () => { clearTimeout(fb); tids.delete(fb); fin(); }, { once: true });
  } else { toggling = false; }
}

function onRC(e) {
  if (!on) return;
  e.preventDefault();
  if (!toggling) off();
}

/* ==== BH DOM ==== */
function mkBH() {
  if (ctr && document.body.contains(ctr)) return;
  ctr = document.createElement('div');
  ctr.id = 'bh-container';
  const c = document.createElement('div');
  c.className = 'bh-core';
  ctr.appendChild(c);
  document.body.appendChild(ctr);
  updSz(); updPos();
}

function onM(e) { mx = e.clientX; my = e.clientY; }

/* マウスイベントをキャプチャフェーズで止め、YouTube等の自動再生トリガーを無効化 */
function blockHover(e) {
  const el = e.target;
  if (!el || el === ctr || (ctr && ctr.contains(el))) return;
  if (el.classList && el.classList.contains('bh-particle')) return;
  e.stopPropagation();
}
const HOVER_EVENTS = ['mouseenter', 'mouseover', 'mouseleave', 'mouseout', 'pointerenter', 'pointerover', 'pointerleave', 'pointerout'];

function updPos() {
  if (!ctr) return;
  if (mx === lastPosMx && my === lastPosMy) return;
  lastPosMx = mx; lastPosMy = my;
  ctr.style.setProperty('--bh-x', mx + 'px');
  ctr.style.setProperty('--bh-y', my + 'px');
  ctr.style.transform = `translate(${mx}px,${my}px)`;
}

function updSz() {
  if (!ctr) return;
  ctr.style.setProperty('--bh-size', sz + 'px');
}

/* ================================================================
   モード — フィルタリング関数
   ================================================================ */

/** こすくま保護: 指定オフセットの文字が保護ワードの一部か判定 */
function isProtectedChar(tn, offset) {
  // テキストノード内でのオフセットを使って判定
  const text = tn.textContent;
  let match;
  KOSUKUMA_RE_G.lastIndex = 0;
  while ((match = KOSUKUMA_RE_G.exec(text)) !== null) {
    if (offset >= match.index && offset < match.index + match[0].length) return true;
  }

  // 8階層まで遡って分割されたケースを検出
  // (Gmail等の深いDOM構造やeraseCharのspan挿入で "こすくま" が複数ノードに跨る場合)
  let el = tn.parentElement;
  for (let depth = 0; el && depth < 8; depth++, el = el.parentElement) {
    if (el === document.body || el === document.documentElement) break;
    // 巨大コンテナは走査コストが高すぎるのでスキップ
    if (el.childNodes.length > 200) continue;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let n;
    let fullText = '';
    let globalOffset = -1;
    while ((n = walker.nextNode())) {
      if (n === tn) globalOffset = fullText.length + offset;
      fullText += n.textContent;
      if (fullText.length > 2000) break;
    }
    if (fullText.length > 2000) continue;
    if (globalOffset >= 0) {
      KOSUKUMA_RE_G.lastIndex = 0;
      while ((match = KOSUKUMA_RE_G.exec(fullText)) !== null) {
        if (globalOffset >= match.index && globalOffset < match.index + match[0].length) return true;
      }
    }
  }

  return false;
}

/* ================================================================
   メインループ
   ================================================================ */
let reducedPeel = false;
let _skipPeelFrames = 0;

function loop(ts) {
  if (!on) return;
  const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.05) : 0.016;
  lastTs = ts;
  const frameStart = performance.now();

  // フレーム全体でMutationObserverを抑制
  _suppressMutationHandler = true;

  // Cache gen bump (reads happen in peel, before writes)
  _posCacheGen++;
  _bgCacheGen++;
  _visTextGen++;
  _fullStyleGen++;

  // Phase 1: Layout reads (peel) — before any style writes
  const moved = Math.hypot(mx - prevMx, my - prevMy) > 2;
  if (_skipPeelFrames > 0) {
    _skipPeelFrames--;
  } else {
    peel();
  }

  // Phase 2: Style writes (physics + position)
  physicsAndAbsorb(dt);
  if (szDirty) { updSz(); szDirty = false; }
  updPos();
  trySpawnAmb(ts);
  maybeNormalize(ts);

  // 定期フルスキャン（安全ネット）: BH半径内の可視テキストを再スキャン
  frameCount++;
  if (frameCount % 60 === 0) {
    _reEraseViewport();
  }

  // フレーム終了: 溜まったmutationを破棄してからobserver再開
  spaObs.takeRecords();
  _suppressMutationHandler = false;

  const elapsed = performance.now() - frameStart;
  // 120fps目標: 8ms超で間引き開始（16.6msの48%でまだ余裕あり）
  reducedPeel = elapsed > 8;

  raf = requestAnimationFrame(loop);
}

/* ================================================================
   ピーリング — Pure DOM

   caretRangeFromPoint で文字検出
   → テキストノードを分割、文字を <span data-bh-erased> で透明化
   → パーティクルとして物理吸引
   ================================================================ */
function peel() {
  if (bodies.length >= MAX_BODIES) return;

  const touchR = sz / 2 * 1.15 + 1;
  const vw = window.innerWidth, vh = window.innerHeight;

  // 移動距離を先に計算 — 高速移動時はスキャン戦略を切り替える
  const moveDist = Math.hypot(mx - prevMx, my - prevMy);
  // fastMoving: 経路スキャンポイントを先に配置（caretの精度向上）
  const fastMoving = moveDist > touchR * 0.5;

  const baseRate = Math.min(28, 4 + Math.floor(sz / 15));
  const pressure = bodies.length / MAX_BODIES;
  const rate = pressure > 0.7 ? Math.max(3, Math.floor(baseRate * (1 - pressure))) : baseRate;

  const nAngles = Math.min(32, 6 + Math.floor(sz / 10));
  const nRings  = Math.min(7, 2 + Math.floor(sz / 40));

  _ptsLen = 0;
  function pushPt(x, y) {
    // Viewport clipping
    if (x < -10 || x > vw + 10 || y < -10 || y > vh + 10) return;
    if (_ptsLen + 2 > _ptsFlat.length) {
      const next = new Float64Array(_ptsFlat.length * 2);
      next.set(_ptsFlat);
      _ptsFlat = next;
    }
    _ptsFlat[_ptsLen++] = x;
    _ptsFlat[_ptsLen++] = y;
  }

  /* ---- Trail-Priority Scan: 高速移動時、経路を最優先スキャン ----
     BHが前フレームから通過した経路は二度とスキャンされない。
     現在位置のリングは次フレームでも再スキャン可能。
     よって高速移動時は経路ポイントを最初に配置し、
     budgetを経路消化に優先配分する。 */
  if (fastMoving) {
    const steps = Math.min(20, Math.ceil(moveDist / (touchR * 0.25)));
    const trailAngles = Math.min(12, 6 + Math.floor(sz / 25));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const ix = prevMx + (mx - prevMx) * t;
      const iy = prevMy + (my - prevMy) * t;
      pushPt(ix, iy);
      for (let a = 0; a < trailAngles; a++) {
        const ang = ((samplePhase * 0.37 + a) / trailAngles) * Math.PI * 2;
        pushPt(ix + Math.cos(ang) * touchR * 0.45, iy + Math.sin(ang) * touchR * 0.45);
        pushPt(ix + Math.cos(ang) * touchR * 0.85, iy + Math.sin(ang) * touchR * 0.85);
      }
    }
  }

  // 大型BH: 外側リングを先に（budgetを新領域に優先配分）
  // 小型BH: 中心を先に（従来通り）
  const edgeFirst = sz > 60;

  // 大型BH: innerFracを下げて内部全域をカバー
  const innerFrac = sz > 150 ? 0.15 : sz > 60 ? 0.35 - (sz - 60) * 0.0022 : 0.35;
  if (edgeFirst) {
    const edgeAngles = Math.min(nAngles, 16);
    const edgeOff = samplePhase * 0.618;
    for (let i = 0; i < edgeAngles; i++) {
      const ang = ((edgeOff + i) / edgeAngles) * Math.PI * 2;
      pushPt(mx + Math.cos(ang) * touchR * 0.98, my + Math.sin(ang) * touchR * 0.98);
    }
    for (let r = nRings; r >= 1; r--) {
      const frac = innerFrac + (r / (nRings + 0.15)) * (1 - innerFrac);
      for (let i = 0; i < nAngles; i++) {
        const ang = ((samplePhase * 0.618 + i) / nAngles) * Math.PI * 2;
        pushPt(mx + Math.cos(ang) * touchR * frac, my + Math.sin(ang) * touchR * frac);
      }
    }
  }

  // 中心点
  pushPt(mx, my);

  if (!edgeFirst) {
    for (let i = 0; i < nAngles; i++) {
      const ang = ((samplePhase * 0.618 + i) / nAngles) * Math.PI * 2;
      for (let r = 1; r <= nRings; r++) {
        const frac = innerFrac + (r / (nRings + 0.15)) * (1 - innerFrac);
        pushPt(mx + Math.cos(ang) * touchR * frac, my + Math.sin(ang) * touchR * frac);
      }
    }
  }
  samplePhase++;

  prevMx = mx; prevMy = my;

  _triedEls.clear();
  let n = 0;
  let caretCalls = 0;
  let elemCalls = 0;
  const MAX_CARET_PER_FRAME = reducedPeel ? 12 : 36;
  const MAX_ELEM_PER_FRAME = 16;
  const PEEL_BUDGET_MS = reducedPeel ? 4 : Math.min(8, 7 - bodies.length * 0.005);
  const peelStart = performance.now();

  /* ---- Pass 1: READ — collect all hits without DOM writes ---- */
  const textHits = [];   // { tn, offset, cpLen, parentEl, charRect }
  const elemHits = [];   // { type, el, rect?, img?, bgImg? }

  for (let pi = 0; pi < _ptsLen; pi += 2) {
    if (n >= rate) break;
    // performance.now()を4反復ごとにチェック（呼び出しコスト削減）
    if ((pi & 6) === 0 && performance.now() - peelStart > PEEL_BUDGET_MS) break;
    const px = _ptsFlat[pi], py = _ptsFlat[pi + 1];

    // ① テキスト文字を検出 (READ only)
    if (caretCalls < MAX_CARET_PER_FRAME) {
      const range = document.caretRangeFromPoint(px, py);
      caretCalls++;
      if (range && range.startContainer.nodeType === 3) {
        const tn = range.startContainer;
        const offset = range.startOffset;
        if (tn.parentElement && tn.parentElement.hasAttribute('data-bh-erased')) continue;
        if (offset < tn.textContent.length) {
          const cpLen = cpLength(tn.textContent, offset);
          const ch = tn.textContent.slice(offset, offset + cpLen);
          if (ch && ch !== '\n' && ch !== '\r' && ch !== '\t' && ch.trim()) {
            if (isProtectedChar(tn, offset)) continue;
            const rc = charRect(tn, offset, cpLen);
            if (rc && rc.width > 0.3 && rc.height > 0.3) {
              const pe = tn.parentElement;
              // contenteditable領域はSPAの入力を壊すのでスキップ
              if (pe && pe.isContentEditable) continue;
              if (pe && sz < PHASE_FIXED) {
                const pos = getCachedPosition(pe);
                if (pos === 'fixed' || pos === 'sticky') continue;
              }
              textHits.push({ tn, offset, cpLen, parentEl: pe, charRect: rc });
              n++;
              continue;
            }
          }
        }
      }
    }

    // ② 非テキスト要素を検出 (READ only)
    if (elemCalls >= MAX_ELEM_PER_FRAME) continue;
    const el = document.elementFromPoint(px, py);
    elemCalls++;
    if (!el || _triedEls.has(el)) continue;
    _triedEls.add(el);
    if (SKIP.has(el.tagName)) continue;
    if (el.id === 'bh-container' || el.id === 'bh-overlay') continue;
    if (ctr && ctr.contains(el)) continue;
    if (el.classList && el.classList.contains('bh-particle')) continue;
    if (el.getAttribute('data-bh') === '1') continue;
    if (el.hasAttribute('data-bh-erased')) continue;

    if (sz < PHASE_FIXED) {
      const pos = getCachedPosition(el);
      if (pos === 'fixed' || pos === 'sticky') continue;
    }

    if (hasVisibleText(el)) {
      elemHits.push({ type: 'pseudo', el });
      continue;
    }

    if (el.tagName === 'IMG' || el.tagName === 'PICTURE') {
      const img = el.tagName === 'PICTURE' ? el.querySelector('img') : el;
      if (img) {
        elemHits.push({ type: 'img', el: img });
        n++;
      }
      continue;
    }

    if (el.tagName === 'VIDEO') {
      elemHits.push({ type: 'video', el });
      n++;
      continue;
    }

    if (el.tagName === 'CANVAS') {
      elemHits.push({ type: 'canvas', el });
      n++;
      continue;
    }

    if (el.tagName === 'svg' || el.tagName === 'SVG' || el instanceof SVGElement) {
      elemHits.push({ type: 'svg', el });
      n++;
      continue;
    }

    if (el.tagName === 'IFRAME') {
      elemHits.push({ type: 'iframe', el });
      n++;
      continue;
    }

    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;

    if (el.shadowRoot) {
      elemHits.push({ type: 'shadow', el, shadowRoot: el.shadowRoot });
    }

    const bgImg = getCachedBgImage(el);
    if (bgImg && bgImg !== 'none' && !hasVisibleText(el)) {
      elemHits.push({ type: 'bgImage', el, rect: r, bgImg });
      n++;
      continue;
    }

    if (r.width * r.height > 40000 && el.children.length > 5) continue;

    if (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      if (!hasVisibleText(el) || el.tagName === 'INPUT') {
        elemHits.push({ type: 'absorb', el, rect: r });
        n++;
        continue;
      }
    }

    elemHits.push({ type: 'absorbWithPseudo', el, rect: r });
    n++;
  }

  /* ---- Pass 1.5: Neighbor sweep — ヒット済みテキストノードの全文字をBH半径内でスイープ ---- */
  const touchRSq = touchR * touchR;
  _sweepOffsets.clear();
  for (const h of textHits) {
    if (!_sweepOffsets.has(h.tn)) _sweepOffsets.set(h.tn, new Set());
    _sweepOffsets.get(h.tn).add(h.offset);
  }
  let sweepBudget = reducedPeel ? 20 : 60;
  for (const [tn, offsets] of _sweepOffsets) {
    if (sweepBudget <= 0) break;
    const text = tn.textContent;
    if (!text) continue;
    const pe = tn.parentElement;
    if (!pe) continue;
    // 親要素矩形でBH圏外を一括スキップ（charRect呼び出しを大幅削減）
    const peRect = pe.getBoundingClientRect();
    const clX = Math.max(peRect.left, Math.min(mx, peRect.right));
    const clY = Math.max(peRect.top, Math.min(my, peRect.bottom));
    if ((clX - mx) * (clX - mx) + (clY - my) * (clY - my) > touchRSq) continue;
    if (sz < PHASE_FIXED) {
      const pos = getCachedPosition(pe);
      if (pos === 'fixed' || pos === 'sticky') continue;
    }
    for (let off = 0; off < text.length && sweepBudget > 0; ) {
      const cpl = cpLength(text, off);
      if (offsets.has(off)) { off += cpl; continue; }
      const ch = text.slice(off, off + cpl);
      if (!ch.trim() || ch === '\n' || ch === '\r' || ch === '\t') { off += cpl; continue; }
      if (isProtectedChar(tn, off)) { off += cpl; continue; }
      const rc = charRect(tn, off, cpl);
      if (!rc || rc.width < 0.3 || rc.height < 0.3) { off += cpl; continue; }
      const ccx = rc.left + rc.width / 2, ccy = rc.top + rc.height / 2;
      const ddx = ccx - mx, ddy = ccy - my;
      if (ddx * ddx + ddy * ddy <= touchRSq) {
        textHits.push({ tn, offset: off, cpLen: cpl, parentEl: pe, charRect: rc });
        offsets.add(off);
        sweepBudget--;
      }
      off += cpl;
    }
  }

  /* ---- Pass 1.75: Sibling sweep — ヒット済みテキストノードの直接親要素内の兄弟テキストノードも走査 ---- */
  if (!reducedPeel) {
    const sibStart = performance.now();
    const SIB_BUDGET_MS = 2;
    const _siblingParents = new Set();
    for (const [tn] of _sweepOffsets) {
      const pe = tn.parentElement;
      if (pe && pe !== document.body && pe !== document.documentElement) {
        _siblingParents.add(pe);
      }
    }
    let sibBudget = 30;
    for (const parent of _siblingParents) {
      if (sibBudget <= 0 || performance.now() - sibStart > SIB_BUDGET_MS) break;
      if (parent.childNodes.length > 30) continue;
      // 親要素矩形でBH圏外を一括スキップ
      const pRect = parent.getBoundingClientRect();
      const cpX = Math.max(pRect.left, Math.min(mx, pRect.right));
      const cpY = Math.max(pRect.top, Math.min(my, pRect.bottom));
      if ((cpX - mx) * (cpX - mx) + (cpY - my) * (cpY - my) > touchRSq) continue;
      const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
      let stn;
      while ((stn = walker.nextNode()) && sibBudget > 0) {
        if (performance.now() - sibStart > SIB_BUDGET_MS) break;
        if (_sweepOffsets.has(stn)) continue;
        const stxt = stn.textContent;
        if (!stxt || !stxt.trim()) continue;
        const spe = stn.parentElement;
        if (!spe || spe.hasAttribute('data-bh-erased')) continue;
        if (sz < PHASE_FIXED) {
          const pos = getCachedPosition(spe);
          if (pos === 'fixed' || pos === 'sticky') continue;
        }
        const sOffsets = new Set();
        _sweepOffsets.set(stn, sOffsets);
        for (let off = 0; off < stxt.length && sibBudget > 0; ) {
          const cpl = cpLength(stxt, off);
          const ch = stxt.slice(off, off + cpl);
          if (!ch.trim() || ch === '\n' || ch === '\r' || ch === '\t') { off += cpl; continue; }
          if (isProtectedChar(stn, off)) { off += cpl; continue; }
          const rc = charRect(stn, off, cpl);
          if (!rc || rc.width < 0.3 || rc.height < 0.3) { off += cpl; continue; }
          const ccx = rc.left + rc.width / 2, ccy = rc.top + rc.height / 2;
          const ddx = ccx - mx, ddy = ccy - my;
          if (ddx * ddx + ddy * ddy <= touchRSq) {
            textHits.push({ tn: stn, offset: off, cpLen: cpl, parentEl: spe, charRect: rc });
            sOffsets.add(off);
            sibBudget--;
          }
          off += cpl;
        }
      }
    }
  }

  /* ---- Pass 2: WRITE — apply DOM mutations from collected hits ---- */

  // Text hits: sort by descending offset within each textNode so that
  // erasing later characters first preserves earlier offsets.
  textHits.sort((a, b) => a.tn === b.tn ? b.offset - a.offset : 0);
  for (let i = 0; i < textHits.length; i++) {
    const hit = textHits[i];
    const span = eraseChar(hit.tn, hit.offset, hit.cpLen);
    if (span) {
      mkCharBody(span, hit.charRect, hit.parentEl);
      // eraseCharがreplaceChildで元textNodeを破壊するため、
      // 同じtextNodeへの残りヒットを新しい"before"テキストノードに差し替える
      const beforeNode = span.previousSibling;
      if (beforeNode && beforeNode.nodeType === 3) {
        const destroyed = hit.tn;
        for (let j = i + 1; j < textHits.length; j++) {
          if (textHits[j].tn === destroyed) {
            textHits[j].tn = beforeNode;
          }
        }
      }
    }
  }

  // Element hits: dispatch by type
  for (let i = 0; i < elemHits.length; i++) {
    const hit = elemHits[i];
    switch (hit.type) {
      case 'pseudo':
        peelPseudo(hit.el);
        break;
      case 'img': {
        const bs = tileImg(hit.el);
        for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
        break;
      }
      case 'video': {
        const bs = tileVideo(hit.el);
        for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
        break;
      }
      case 'canvas': {
        const bs = tileCanvas(hit.el);
        for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
        break;
      }
      case 'svg': {
        const bs = tileSVG(hit.el);
        for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
        break;
      }
      case 'iframe': {
        const bs = tileIframe(hit.el);
        for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
        break;
      }
      case 'shadow':
        peelShadow(hit.shadowRoot);
        break;
      case 'bgImage': {
        const bs = tileBgImage(hit.el, hit.rect, hit.bgImg);
        for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
        break;
      }
      case 'absorb':
        absorbEl(hit.el, hit.rect);
        break;
      case 'absorbWithPseudo':
        peelPseudo(hit.el);
        absorbEl(hit.el, hit.rect);
        break;
    }
  }

}

/* ---- リストマーカー・疑似要素のパーティクル化 ---- */
const _pseudoHandled = new WeakSet();

function peelPseudo(el) {
  if (_pseudoHandled.has(el)) return;

  // ::marker（リスト項目の番号・ビュレット）
  if (el.tagName === 'LI' && !el.getAttribute('data-bh-marker')) {
    const markerStyle = getComputedStyle(el, '::marker');
    const markerContent = markerStyle.content;
    // marker textを取得（ブラウザによってはcontentが取れない場合もある）
    let markerText = '';
    if (markerContent && markerContent !== 'none' && markerContent !== 'normal') {
      markerText = markerContent.replace(/^["']|["']$/g, '');
    }
    if (!markerText) {
      // フォールバック: listStyleTypeから推測
      const parentList = el.closest('ol, ul');
      if (parentList && parentList.tagName === 'UL') {
        markerText = '•';
      } else if (parentList && parentList.tagName === 'OL') {
        const items = [...parentList.children].filter(c => c.tagName === 'LI');
        const idx = items.indexOf(el) + 1;
        markerText = idx + '.';
      }
    }
    if (markerText) {
      if (KOSUKUMA_RE.test(markerText)) { _pseudoHandled.add(el); return; }
      const r = el.getBoundingClientRect();
      const st = getCachedFullStyle(el);
      const rawSt = getComputedStyle(el);
      const paddingLeft = parseFloat(rawSt.paddingLeft) || 0;
      // マーカーは要素の左側、パディングの前に描画される
      const markerR = {
        left: r.left - paddingLeft - 20,
        top: r.top,
        width: 20,
        height: parseFloat(st.fontSize) || 16
      };
      mkPseudoBody(markerText, markerR, st);
      el.style.listStyle = 'none';
      el.setAttribute('data-bh-marker', '1');
    }
    _pseudoHandled.add(el);
  }

  // ::before / ::after
  for (const pseudo of ['::before', '::after']) {
    const key = `data-bh-${pseudo.replace('::', '')}`;
    if (el.getAttribute(key)) continue;
    try {
      const ps = getComputedStyle(el, pseudo);
      const content = ps.content;
      if (!content || content === 'none' || content === 'normal' || content === '""') continue;
      // contentからテキストを抽出
      let text = content.replace(/^["']|["']$/g, '');
      if (!text || text === 'counter' || text.startsWith('counter(')) continue;
      if (KOSUKUMA_RE.test(text)) continue;

      const elR = el.getBoundingClientRect();
      const pseudoR = pseudo === '::before'
        ? { left: elR.left, top: elR.top, width: 20, height: parseFloat(ps.fontSize) || 16 }
        : { left: elR.right - 20, top: elR.top, width: 20, height: parseFloat(ps.fontSize) || 16 };
      mkPseudoBody(text, pseudoR, ps);
      el.setAttribute(key, '1');
    } catch { /* ignore */ }
  }
  _pseudoHandled.add(el);
}

function mkPseudoBody(text, rc, rawSt) {
  // rawSt may be CSSStyleDeclaration (from pseudo) or cached entry; normalize
  const st = rawSt.gen !== undefined ? rawSt : {
    fontSize: rawSt.fontSize, fontFamily: rawSt.fontFamily,
    fontWeight: rawSt.fontWeight, color: rawSt.color
  };
  const p = document.createElement('span');
  p.className = 'bh-particle';
  p.textContent = text;
  p.style.cssText =
    `position:fixed;left:${rc.left}px;top:${rc.top}px;` +
    `font-size:${st.fontSize || '16px'};font-family:${st.fontFamily || 'inherit'};` +
    `font-weight:${st.fontWeight || 'normal'};color:${st.color || '#000'};` +
    `line-height:1;margin:0;padding:0;background:none;` +
    `pointer-events:none;z-index:2147483645;contain:layout style paint;border-radius:0;`;
  document.body.appendChild(p);

  const cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2;
  const dx = mx - cx, dy = my - cy;
  const d = Math.hypot(dx, dy) || 1;

  bodies.push({
    el: p, x: cx, y: cy, ox: cx, oy: cy,
    vx: (dx / d) * INIT_SPEED, vy: (dy / d) * INIT_SPEED, rot: 0
  });
}


function eraseChar(tn, offset, cpLen) {
  try {
    // ラストライン防御: どのパスから呼ばれてもこすくまは絶対に消さない
    if (isProtectedChar(tn, offset)) return null;

    const text = tn.textContent;
    const before = text.slice(0, offset);
    const ch = text.slice(offset, offset + cpLen);
    const after = text.slice(offset + cpLen);
    const parent = tn.parentNode;
    if (!parent) return null;

    // 消した文字を<span>でラップ
    const span = document.createElement('span');
    span.textContent = ch;
    span.style.setProperty('color', 'transparent', 'important');
    span.setAttribute('data-bh-erased', '1');

    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));
    frag.appendChild(span);
    if (after) frag.appendChild(document.createTextNode(after));
    parent.replaceChild(frag, tn);
    _dirtyParents.add(parent);

    return span;
  } catch { return null; }
}

/* ---- 1文字のテキストパーティクル生成 ---- */
function mkCharBody(span, rc, parentEl) {
  const pe = parentEl || span.parentElement;
  const st = pe ? getCachedFullStyle(pe) : null;
  const p = document.createElement('span');
  p.className = 'bh-particle';
  p.textContent = span.textContent;
  p.style.cssText =
    `position:fixed;left:${rc.left}px;top:${rc.top}px;` +
    `font-size:${st ? st.fontSize : '16px'};font-family:${st ? st.fontFamily : 'inherit'};` +
    `font-weight:${st ? st.fontWeight : 'normal'};color:${st ? st.color : '#000'};` +
    `line-height:1;margin:0;padding:0;background:none;` +
    `pointer-events:none;z-index:2147483645;contain:layout style paint;border-radius:0;`;
  document.body.appendChild(p);

  const cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2;
  const dx = mx - cx, dy = my - cy;
  const d = Math.hypot(dx, dy) || 1;

  bodies.push({
    el: p, x: cx, y: cy, ox: cx, oy: cy,
    vx: (dx / d) * INIT_SPEED, vy: (dy / d) * INIT_SPEED, rot: 0
  });
}

/* ---- 要素にこすくま保護テキストが含まれるか判定 ---- */
function containsProtectedText(el) {
  const text = el.textContent || el.value || '';
  if (!text) return false;
  return KOSUKUMA_RE.test(text);
}

/* ---- 要素の単体吸収 ---- */
function absorbEl(el, r) {
  // こすくま保護: 保護テキストを含む要素は吸収しない
  if (containsProtectedText(el)) return;
  el.setAttribute('data-bh', '1');
  el.style.visibility = 'hidden';
  el.style.pointerEvents = 'none';

  const clone = el.cloneNode(true);
  clone.removeAttribute('data-bh');
  clone.classList.add('bh-particle');
  clone.style.cssText =
    `position:fixed;left:${r.left}px;top:${r.top}px;` +
    `width:${r.width}px;height:${r.height}px;` +
    `margin:0;pointer-events:none;overflow:hidden;` +
    `z-index:2147483645;contain:layout style paint;`;
  document.body.appendChild(clone);

  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const dx = mx - cx, dy = my - cy;
  const d = Math.hypot(dx, dy) || 1;

  bodies.push({
    el: clone, x: cx, y: cy, ox: cx, oy: cy,
    vx: (dx / d) * INIT_SPEED, vy: (dy / d) * INIT_SPEED, rot: 0
  });
}

/* ---- 画像タイル分解 ---- */
function tileImg(img) {
  const r = img.getBoundingClientRect();
  const src = img.src || img.currentSrc;
  if (!src || r.width < 2 || r.height < 2) return [];
  if (containsProtectedText(img)) return [];
  img.setAttribute('data-bh', '1');

  let tw = TILE_PX, th = TILE_PX;
  let cols = Math.ceil(r.width / tw), rows = Math.ceil(r.height / th);
  while (cols * rows > MAX_TILES && tw < 80) { tw += 4; th += 4; cols = Math.ceil(r.width / tw); rows = Math.ceil(r.height / th); }

  const out = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const w = Math.min(tw, r.width - col * tw);
      const h = Math.min(th, r.height - row * th);
      const x = r.left + col * tw, y = r.top + row * th;

      const d = document.createElement('div');
      d.className = 'bh-particle';
      d.style.cssText =
        `position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;` +
        `pointer-events:none;z-index:2147483645;contain:layout style paint;border-radius:0;`;
      d.style.backgroundImage = `url("${src.replace(/["\\()]/g, '\\$&')}")`;
      d.style.backgroundPosition = `-${col * tw}px -${row * th}px`;
      d.style.backgroundSize = `${r.width}px ${r.height}px`;
      document.body.appendChild(d);

      const cx = x + w / 2, cy = y + h / 2;
      const dx = mx - cx, dy = my - cy;
      const dist = Math.hypot(dx, dy) || 1;

      out.push({
        el: d, x: cx, y: cy, ox: cx, oy: cy,
        vx: (dx / dist) * INIT_SPEED * 0.5, vy: (dy / dist) * INIT_SPEED * 0.5, rot: 0
      });
    }
  }

  img.style.visibility = 'hidden';
  img.style.pointerEvents = 'none';
  return out;
}

/* ---- 動画タイル分解 ---- */
function tileVideo(video) {
  const r = video.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return [];
  if (video.getAttribute('data-bh') === '1') return [];
  if (containsProtectedText(video)) return [];
  video.setAttribute('data-bh', '1');

  // 現在のフレームをcanvasにキャプチャ
  let dataUrl;
  try {
    const cvs = document.createElement('canvas');
    cvs.width = Math.min(r.width, 640);
    cvs.height = Math.min(r.height, 360);
    const ctx = cvs.getContext('2d');
    ctx.drawImage(video, 0, 0, cvs.width, cvs.height);
    dataUrl = cvs.toDataURL('image/jpeg', 0.7);
  } catch {
    // CORS制限でキャプチャ不可 → 黒タイルで代替
    dataUrl = null;
  }

  let tw = TILE_PX, th = TILE_PX;
  let cols = Math.ceil(r.width / tw), rows = Math.ceil(r.height / th);
  while (cols * rows > MAX_TILES && tw < 80) { tw += 4; th += 4; cols = Math.ceil(r.width / tw); rows = Math.ceil(r.height / th); }

  const out = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const w = Math.min(tw, r.width - col * tw);
      const h = Math.min(th, r.height - row * th);
      const x = r.left + col * tw, y = r.top + row * th;

      const d = document.createElement('div');
      d.className = 'bh-particle';
      d.style.cssText =
        `position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;` +
        `pointer-events:none;z-index:2147483645;contain:layout style paint;border-radius:0;`;
      if (dataUrl) {
        d.style.backgroundImage = `url("${dataUrl}")`;
        d.style.backgroundPosition = `-${col * tw}px -${row * th}px`;
        d.style.backgroundSize = `${r.width}px ${r.height}px`;
      } else {
        d.style.background = '#111';
      }
      document.body.appendChild(d);

      const cx = x + w / 2, cy = y + h / 2;
      const dx = mx - cx, dy = my - cy;
      const dist = Math.hypot(dx, dy) || 1;

      out.push({
        el: d, x: cx, y: cy, ox: cx, oy: cy,
        vx: (dx / dist) * INIT_SPEED * 0.5, vy: (dy / dist) * INIT_SPEED * 0.5, rot: 0
      });
    }
  }

  video.style.visibility = 'hidden';
  video.style.pointerEvents = 'none';
  video.pause();
  return out;
}

/* ---- Canvasタイル分解 ---- */
function tileCanvas(canvas) {
  const r = canvas.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return [];
  if (canvas.getAttribute('data-bh') === '1') return [];
  if (containsProtectedText(canvas)) return [];
  canvas.setAttribute('data-bh', '1');

  let dataUrl;
  try {
    // WebGL: preserveDrawingBuffer=falseの場合toDataURLが空になる対策
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (gl) {
      // WebGLの場合、現在のフレームバッファを強制読み取り
      const w = canvas.width, h = canvas.height;
      const tmpCvs = document.createElement('canvas');
      tmpCvs.width = w; tmpCvs.height = h;
      const ctx2d = tmpCvs.getContext('2d');
      ctx2d.drawImage(canvas, 0, 0);
      dataUrl = tmpCvs.toDataURL('image/jpeg', 0.7);
    } else {
      dataUrl = canvas.toDataURL('image/jpeg', 0.7);
    }
  } catch { dataUrl = null; }

  let tw = TILE_PX, th = TILE_PX;
  let cols = Math.ceil(r.width / tw), rows = Math.ceil(r.height / th);
  while (cols * rows > MAX_TILES && tw < 80) { tw += 4; th += 4; cols = Math.ceil(r.width / tw); rows = Math.ceil(r.height / th); }

  const out = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const w = Math.min(tw, r.width - col * tw);
      const h = Math.min(th, r.height - row * th);
      const x = r.left + col * tw, y = r.top + row * th;

      const d = document.createElement('div');
      d.className = 'bh-particle';
      d.style.cssText =
        `position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;` +
        `pointer-events:none;z-index:2147483645;contain:layout style paint;border-radius:0;`;
      if (dataUrl) {
        d.style.backgroundImage = `url("${dataUrl}")`;
        d.style.backgroundPosition = `-${col * tw}px -${row * th}px`;
        d.style.backgroundSize = `${r.width}px ${r.height}px`;
      } else {
        d.style.background = '#222';
      }
      document.body.appendChild(d);

      const cx = x + w / 2, cy = y + h / 2;
      const dx = mx - cx, dy = my - cy;
      const dist = Math.hypot(dx, dy) || 1;

      out.push({
        el: d, x: cx, y: cy, ox: cx, oy: cy,
        vx: (dx / dist) * INIT_SPEED * 0.5, vy: (dy / dist) * INIT_SPEED * 0.5, rot: 0
      });
    }
  }

  canvas.style.visibility = 'hidden';
  canvas.style.pointerEvents = 'none';
  return out;
}

/* ---- SVGラスタライズ+タイル分解 ---- */
function tileSVG(svg) {
  const r = svg.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return [];
  if (svg.getAttribute('data-bh') === '1') return [];
  if (containsProtectedText(svg)) return [];
  svg.setAttribute('data-bh', '1');

  let dataUrl;
  try {
    const serializer = new XMLSerializer();
    const svgStr = serializer.serializeToString(svg);
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    dataUrl = URL.createObjectURL(blob);
  } catch { dataUrl = null; }

  if (!dataUrl) {
    svg.style.visibility = 'hidden';
    svg.style.pointerEvents = 'none';
    return _tileFallback(svg, r, '#333');
  }

  // SVGをcanvasにレンダリング（非同期だがベストエフォート）
  const img = new Image();
  img.src = dataUrl;
  const out = _tileWithSrc(r, dataUrl);
  svg.style.visibility = 'hidden';
  svg.style.pointerEvents = 'none';
  return out;
}

/* ---- iframeタイル分解（同一オリジンのみ） ---- */
function tileIframe(iframe) {
  const r = iframe.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return [];
  if (iframe.getAttribute('data-bh') === '1') return [];
  if (containsProtectedText(iframe)) return [];

  // 同一オリジンチェック
  try {
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) return _tileFallback(iframe, r, '#1a1a2e');
  } catch {
    // クロスオリジン → フレーム全体をパーティクルとして吸収
    iframe.setAttribute('data-bh', '1');
    iframe.style.visibility = 'hidden';
    iframe.style.pointerEvents = 'none';
    return _tileFallback(iframe, r, '#1a1a2e');
  }

  iframe.setAttribute('data-bh', '1');
  iframe.style.visibility = 'hidden';
  iframe.style.pointerEvents = 'none';
  return _tileFallback(iframe, r, '#1a1a2e');
}

/* ---- CSS背景画像のタイル分解 ---- */
function tileBgImage(el, r, bgImg) {
  if (el.getAttribute('data-bh') === '1') return [];
  if (containsProtectedText(el)) return [];
  el.setAttribute('data-bh', '1');
  el.style.visibility = 'hidden';
  el.style.pointerEvents = 'none';

  // url("...") を抽出
  const urlMatch = bgImg.match(/url\(["']?([^"')]+)["']?\)/);
  if (urlMatch) {
    return _tileWithSrc(r, urlMatch[1]);
  }

  // gradient: CSSグラデーションはそのまま背景に設定
  let tw = TILE_PX, th = TILE_PX;
  let cols = Math.ceil(r.width / tw), rows = Math.ceil(r.height / th);
  while (cols * rows > MAX_TILES && tw < 80) { tw += 4; th += 4; cols = Math.ceil(r.width / tw); rows = Math.ceil(r.height / th); }

  const out = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const w = Math.min(tw, r.width - col * tw);
      const h = Math.min(th, r.height - row * th);
      const x = r.left + col * tw, y = r.top + row * th;

      const d = document.createElement('div');
      d.className = 'bh-particle';
      d.style.cssText =
        `position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;` +
        `pointer-events:none;z-index:2147483645;contain:layout style paint;border-radius:0;` +
        `background:${bgImg};background-size:${r.width}px ${r.height}px;` +
        `background-position:-${col * tw}px -${row * th}px;`;
      document.body.appendChild(d);

      const cx = x + w / 2, cy = y + h / 2;
      const dx = mx - cx, dy = my - cy;
      const dist = Math.hypot(dx, dy) || 1;
      out.push({
        el: d, x: cx, y: cy, ox: cx, oy: cy,
        vx: (dx / dist) * INIT_SPEED * 0.5, vy: (dy / dist) * INIT_SPEED * 0.5, rot: 0
      });
    }
  }
  return out;
}

/* ---- Shadow DOM再帰走査 ---- */
function peelShadow(root) {
  if (!root) return;
  // Shadow DOM内にもerased-styleを注入（CSSはshadow境界を超えない）
  if (!root.querySelector('#bh-erased-style-shadow')) {
    try {
      const st = document.createElement('style');
      st.id = 'bh-erased-style-shadow';
      st.textContent = '[data-bh-erased][data-bh-erased]{color:transparent!important;-webkit-text-fill-color:transparent!important}';
      root.appendChild(st);
    } catch {}
  }
  // Shadow DOM内のテキストノードを走査
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.textContent.trim()) continue;
    const parent = node.parentElement;
    if (!parent || parent.hasAttribute('data-bh-erased')) continue;
    // Shadow DOM内のテキストを通常のeraseChar処理
    const text = node.textContent;
    for (let i = 0; i < text.length && bodies.length < MAX_BODIES; i++) {
      const cpLen = cpLength(text, i);
      const ch = text.slice(i, i + cpLen);
      if (!ch.trim()) continue;
      // こすくま保護: この文字が保護ワードの一部ならスキップ
      if (isProtectedChar(node, i)) continue;
      const rc = charRect(node, i, cpLen);
      if (!rc || rc.width < 0.3 || rc.height < 0.3) continue;
      const span = eraseChar(node, i, cpLen);
      if (span) {
        mkCharBody(span, rc, parent);
        break; // TreeWalkerが無効になるので1文字ずつ
      }
    }
  }

  // Shadow DOM内の要素も吸収
  const els = root.querySelectorAll('img, video, canvas, svg, button');
  for (const el of els) {
    if (el.getAttribute('data-bh') === '1') continue;
    if (el.tagName === 'IMG') {
      const bs = tileImg(el);
      for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
    } else if (el.tagName === 'VIDEO') {
      const bs = tileVideo(el);
      for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
    } else if (el.tagName === 'CANVAS') {
      const bs = tileCanvas(el);
      for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
    } else if (el.tagName === 'svg' || el.tagName === 'SVG' || el instanceof SVGElement) {
      const bs = tileSVG(el);
      for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
    } else {
      const r = el.getBoundingClientRect();
      if (r.width > 2 && r.height > 2) absorbEl(el, r);
    }
  }
}

/* ---- 汎用タイルヘルパー ---- */
function _tileWithSrc(r, src) {
  let tw = TILE_PX, th = TILE_PX;
  let cols = Math.ceil(r.width / tw), rows = Math.ceil(r.height / th);
  while (cols * rows > MAX_TILES && tw < 80) { tw += 4; th += 4; cols = Math.ceil(r.width / tw); rows = Math.ceil(r.height / th); }

  const out = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const w = Math.min(tw, r.width - col * tw);
      const h = Math.min(th, r.height - row * th);
      const x = r.left + col * tw, y = r.top + row * th;

      const d = document.createElement('div');
      d.className = 'bh-particle';
      d.style.cssText =
        `position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;` +
        `pointer-events:none;z-index:2147483645;contain:layout style paint;border-radius:0;`;
      d.style.backgroundImage = `url("${src.replace(/["\\()]/g, '\\$&')}")`;
      d.style.backgroundPosition = `-${col * tw}px -${row * th}px`;
      d.style.backgroundSize = `${r.width}px ${r.height}px`;
      document.body.appendChild(d);

      const cx = x + w / 2, cy = y + h / 2;
      const dx = mx - cx, dy = my - cy;
      const dist = Math.hypot(dx, dy) || 1;
      out.push({
        el: d, x: cx, y: cy, ox: cx, oy: cy,
        vx: (dx / dist) * INIT_SPEED * 0.5, vy: (dy / dist) * INIT_SPEED * 0.5, rot: 0
      });
    }
  }
  return out;
}

function _tileFallback(el, r, color) {
  if (containsProtectedText(el)) return [];
  el.setAttribute('data-bh', '1');
  el.style.visibility = 'hidden';
  el.style.pointerEvents = 'none';

  let tw = TILE_PX * 2, th = TILE_PX * 2;
  let cols = Math.ceil(r.width / tw), rows = Math.ceil(r.height / th);
  while (cols * rows > MAX_TILES && tw < 80) { tw += 4; th += 4; cols = Math.ceil(r.width / tw); rows = Math.ceil(r.height / th); }

  const out = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const w = Math.min(tw, r.width - col * tw);
      const h = Math.min(th, r.height - row * th);
      const x = r.left + col * tw, y = r.top + row * th;

      const d = document.createElement('div');
      d.className = 'bh-particle';
      d.style.cssText =
        `position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;` +
        `background:${color};pointer-events:none;z-index:2147483645;contain:layout style paint;border-radius:0;`;
      document.body.appendChild(d);

      const cx = x + w / 2, cy = y + h / 2;
      const dx = mx - cx, dy = my - cy;
      const dist = Math.hypot(dx, dy) || 1;
      out.push({
        el: d, x: cx, y: cy, ox: cx, oy: cy,
        vx: (dx / dist) * INIT_SPEED * 0.5, vy: (dy / dist) * INIT_SPEED * 0.5, rot: 0
      });
    }
  }
  return out;
}

/* ================================================================
   物理
   ================================================================ */
const _removeQueue = [];

function physicsAndAbsorb(dt) {
  const field = sz * BH_FIELD;
  const fieldSq = field * field * 1.5;
  const damp = Math.pow(DAMPING, dt * 60);
  const coreSq = (sz * 0.6) * (sz * 0.6);
  const vw = window.innerWidth, vh = window.innerHeight;
  let write = 0;
  let absorbCount = 0;
  const MAX_ABSORB_PER_FRAME = sz > 200 ? 50 : 30;
  _removeQueue.length = 0;

  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    const dx = mx - b.x;
    const dy = my - b.y;
    const distSq = dx * dx + dy * dy;

    // 吸収判定（distSq再利用でsqrt不要）
    if (distSq < coreSq && absorbCount < MAX_ABSORB_PER_FRAME) {
      _removeQueue.push(b.el);
      absorbCount++;
      continue;
    }

    // 画面外 + 重力圏外のボディをカリング
    if (distSq > fieldSq && (b.x < -200 || b.x > vw + 200 || b.y < -200 || b.y > vh + 200)) {
      _removeQueue.push(b.el);
      continue;
    }

    // 重力圏外の遠方ボディ: sqrtスキップのfast path
    if (distSq > fieldSq) {
      b.vx *= damp; b.vy *= damp;
      b.x += b.vx * dt; b.y += b.vy * dt;
      const tx = (b.x - b.ox) | 0;
      const ty = (b.y - b.oy) | 0;
      if (tx !== b._ptx || ty !== b._pty) {
        b._ptx = tx; b._pty = ty;
        const s = b.el.style;
        s.transform = 'translate(' + tx + 'px,' + ty + 'px)rotate(' + (b.rot | 0) + 'deg)';
        s.opacity = 1;
      }
      bodies[write++] = b;
      continue;
    }

    const dist = Math.sqrt(distSq);
    if (dist < 0.5) { bodies[write++] = b; continue; }

    const nx = dx / dist;
    const ny = dy / dist;

    const t = Math.max(0, 1 - dist / field);
    const acc = GRAVITY * (0.3 + 0.7 * t);

    b.vx += (nx + ny * TANGENT) * acc * dt;
    b.vy += (ny - nx * TANGENT) * acc * dt;
    b.vx *= damp;
    b.vy *= damp;

    const spdSq = b.vx * b.vx + b.vy * b.vy;
    let spd;
    if (spdSq > MAX_SPEED_SQ) {
      spd = Math.sqrt(spdSq);
      const sc = MAX_SPEED / spd; b.vx *= sc; b.vy *= sc;
      spd = MAX_SPEED;
    } else {
      spd = Math.sqrt(spdSq);
    }

    b.x += b.vx * dt;
    b.y += b.vy * dt;

    b.rot += spd * dt * 0.3;

    const scaleR = sz * 1.2;
    const scale = dist < scaleR ? Math.max(0.05, dist / scaleR) : 1;
    const opacity = dist < sz ? Math.max(0.1, dist / sz) : 1;

    // ダーティチェック: 整数化して前回値と比較
    const tx = (b.x - b.ox) | 0;
    const ty = (b.y - b.oy) | 0;
    const rot = b.rot | 0;
    const scI = (scale * 100 + 0.5) | 0;
    const op = opacity < 0.99 ? ((opacity * 100 + 0.5) | 0) : 100;

    if (tx === b._ptx && ty === b._pty && rot === b._prot && scI === b._psc && op === b._pop) {
      bodies[write++] = b;
      continue;
    }
    b._ptx = tx; b._pty = ty; b._prot = rot; b._psc = scI; b._pop = op;
    const s = b.el.style;
    s.transform = 'translate(' + tx + 'px,' + ty + 'px)rotate(' + rot + 'deg)scale(' + (scI / 100) + ')';
    s.opacity = op / 100;
    bodies[write++] = b;
  }
  bodies.length = write;

  // バッチDOM除去（ループ外で1回 — レイアウトスラッシング防止）
  for (let i = 0; i < _removeQueue.length; i++) _removeQueue[i].remove();
  _removeQueue.length = 0;

  // バッチ適用（ループ外で1回だけ）
  growBatch(absorbCount);
}

function growBatch(count) {
  if (count === 0) return;
  totalAbsorbed += count;

  // 階段判定: totalAbsorbedが超えた最大のステップまで一気にジャンプ
  let stepped = false;
  for (const [threshold, jumpSz] of GROWTH_STEPS) {
    if (totalAbsorbed >= threshold && sz < jumpSz) {
      sz = jumpSz;
      stepped = true;
      // breakしない — 複数ステップ飛ぶ可能性
    }
  }

  if (!stepped) {
    sz += GROW_RATE * count;
  }

  if (stepped) {
    updSz();
    _skipPeelFrames = 1;
    // 既存の浮遊パーティクルを全キャンセル（古いsz/mx/myで焼き込み済みのため）
    for (const p of ambParts) {
      p.getAnimations().forEach(a => a.cancel());
      p.remove();
    }
    ambParts.clear();
    ambCnt = 0;
    lastAmbSpawn = 0;
    // Animate .bh-core child instead of ctr to avoid WAAPI conflict with updPos() transform
    const core = ctr && ctr.querySelector('.bh-core');
    if (core) {
      core.animate([
        { transform: 'translate(-50%,-50%) scale(1.15)' },
        { transform: 'translate(-50%,-50%) scale(1)' }
      ], { duration: 300, easing: 'ease-out' });
    }
  } else {
    szDirty = true;
  }
}

/* ==== 環境パーティクル ==== */
let lastAmbSpawn = 0;
function trySpawnAmb(ts) {
  const ambMax = sz >= 300 ? 12 : sz >= 220 ? 9 : sz >= PHASE2 ? 7 : sz >= 95 ? 3 : 0;
  if (!on || ambMax === 0 || ambCnt >= ambMax) return;
  const ambInterval = sz >= 300 ? 350 : sz >= 220 ? 500 : 600;
  if (ts - lastAmbSpawn < ambInterval) return;
  lastAmbSpawn = ts;
  spawnAmb();
}

function spawnAmb() {
  const p = document.createElement('div');
  p.className = 'bh-particle';
  const s = sz >= 300 ? 2 + Math.random() * 4 : 2 + Math.random() * 2;
  const cols = sz >= 300 ? COL3 : sz >= PHASE2 ? COL2 : COL1;
  const col = cols[Math.random() * cols.length | 0];
  const ang = Math.random() * Math.PI * 2;
  const dist = sz * 0.8 + Math.random() * 30;
  const sx = mx + Math.cos(ang) * dist, sy = my + Math.sin(ang) * dist;
  const dur = 2000 + Math.random() * 1500;

  Object.assign(p.style, {
    width: s+'px', height: s+'px', background: col,
    boxShadow: `0 0 ${s*2}px ${col}`,
    left: sx+'px', top: sy+'px', opacity: '0'
  });
  document.body.appendChild(p);
  ambCnt++;
  ambParts.add(p);

  const ma = ang + Math.PI * 0.7, md = dist * 0.5;
  const midX = mx + Math.cos(ma)*md - sx, midY = my + Math.sin(ma)*md - sy;
  const endX = mx - sx, endY = my - sy;

  p.animate([
    { transform: 'translate(0,0) scale(0.5)', opacity: 0 },
    { transform: `translate(${midX}px,${midY}px) scale(1)`, opacity: 0.7, offset: 0.5 },
    { transform: `translate(${endX}px,${endY}px) scale(0)`, opacity: 0 }
  ], { duration: dur, easing: 'ease-in', fill: 'forwards' }).onfinish = () => {
    if (!on) return;
    p.remove(); ambCnt = Math.max(0, ambCnt - 1);
    ambParts.delete(p);
  };
}

/* ==== ユーティリティ ==== */
const _segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

function cpLength(str, offset) {
  const code = str.charCodeAt(offset);
  // BMP文字（サロゲートペア以外）は即座に1を返す — 95%以上がこのパス
  if (code < 0xD800 || code > 0xDFFF) return 1;
  // サロゲートペア
  if (code <= 0xDBFF && offset + 1 < str.length) return 2;
  // 複合グラフェム（絵文字ZWJシーケンス等）のみSegmenter使用
  if (_segmenter) {
    const snippet = str.slice(offset, offset + 20);
    const iter = _segmenter.segment(snippet)[Symbol.iterator]();
    const first = iter.next();
    if (!first.done) return first.value.segment.length;
  }
  return 1;
}

const _charRange = document.createRange();
function charRect(tn, i, len) {
  try {
    _charRange.setStart(tn, i); _charRange.setEnd(tn, i + len);
    const rects = _charRange.getClientRects();
    return rects.length ? rects[0] : null;
  } catch { return null; }
}

function hasVisibleText(el) {
  if (el.tagName && LEAF_TAGS.has(el.tagName)) return false;
  const cached = _visTextCache.get(el);
  if (cached && cached.gen === _visTextGen) return cached.val;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node, val = false;
  while ((node = walker.nextNode())) {
    if (node.parentElement && node.parentElement.hasAttribute('data-bh-erased')) continue;
    if (node.textContent.trim()) { val = true; break; }
  }
  _visTextCache.set(el, { val, gen: _visTextGen });
  return val;
}
