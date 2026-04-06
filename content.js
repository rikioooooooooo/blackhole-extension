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

const GRAVITY     = 3000;
const TANGENT     = 0.08;
const DAMPING     = 0.995;
const MAX_SPEED   = 1200;
const INIT_SPEED  = 300;

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

/* ==== バネ物理（ヌルっとした追従） ==== */
let bhx = 0, bhy = 0;         // BH描画位置（バネ出力）
let bhvx = 0, bhvy = 0;       // BH速度
const SPRING_K = 320;          // バネ定数（大きい＝速く追従）
const SPRING_DAMP = 22;        // 減衰（大きい＝オーバーシュート少ない）

/* ==== テール（影の尾） ==== */
let tailEl = null;
let tailX = 0, tailY = 0;     // テール位置（さらに遅れる）
const TAIL_LAG = 0.06;         // テールの追従係数（小さい＝遅い）

/* ==== こすくま保護（Ctrl+F方式 — 高速版） ==== */
const KOSUKUMA_WORDS = ['こすくま', 'こす.くま', 'こす．くま', 'こす・くま', 'こす｡くま', 'kosukuma', 'kosu.kuma'];

/* ==== こすくま保護エンジン（高速版） ====
 * 設計: 起動時1回のスキャンで全保護情報を事前計算し、
 *       ランタイムはWeakMapルックアップ(O(1))のみ。
 */
const _protectedRanges = new WeakMap();
const _protectedElements = new WeakSet();
const _KOSUKUMA_RE = /こすくま|こす[.．・｡]くま|kosukuma|kosu[.]kuma/gi;

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

/* ==== DOM断片化デフラグ ==== */
const _dirtyParents = new Set();
let _lastNormalize = 0;

function maybeNormalize(ts) {
  if (_dirtyParents.size === 0) return;
  if (ts - _lastNormalize < 3000) return; // 3秒に1回
  _lastNormalize = ts;
  let count = 0;
  for (const el of _dirtyParents) {
    if (count >= 20) break; // 1フレームあたり最大20件 — 大量吸い込み時のスパイク防止
    try { el.normalize(); } catch { /* removed from DOM */ }
    _dirtyParents.delete(el);
    count++;
  }
}

/* ==== getComputedStyle positionキャッシュ（毎フレームのstyle recalc回避） ==== */
const _posCache = new WeakMap();
let _posCacheGen = 0;
function getCachedPosition(el) {
  const cached = _posCache.get(el);
  if (cached && cached.gen === _posCacheGen) return cached.pos;
  const pos = getComputedStyle(el).position;
  _posCache.set(el, { pos, gen: _posCacheGen });
  return pos;
}

/* ==== Per-frame collection pools (GC圧力削減) ==== */
let _ptsFlat = new Float64Array(1024);  // flat [x0,y0,x1,y1,...] — 512点分で十分
let _ptsLen = 0;
const _textHits = [];   // reuse each frame
const _elemHits = [];
const _triedEls = new Set();
const _byNode = new Map();

/* textHit / elemHit オブジェクトプール（毎フレームnew回避） */
const _textHitPool = [];
let _textHitIdx = 0;
function _acquireTextHit(tn, offset, cpLen, rc, pe) {
  if (_textHitIdx < _textHitPool.length) {
    const h = _textHitPool[_textHitIdx];
    h.tn = tn; h.offset = offset; h.cpLen = cpLen; h.rc = rc; h.pe = pe;
    _textHitIdx++;
    return h;
  }
  const h = { tn, offset, cpLen, rc, pe };
  _textHitPool.push(h);
  _textHitIdx++;
  return h;
}
const _elemHitPool = [];
let _elemHitIdx = 0;
function _acquireElemHit(type, el, r, bgImg) {
  if (_elemHitIdx < _elemHitPool.length) {
    const h = _elemHitPool[_elemHitIdx];
    h.type = type; h.el = el; h.r = r; h.bgImg = bgImg;
    _elemHitIdx++;
    return h;
  }
  const h = { type, el, r, bgImg };
  _elemHitPool.push(h);
  _elemHitIdx++;
  return h;
}

/* ==== P4: CSS containment for particles ==== */
const _bhStyle = document.createElement('style');
_bhStyle.textContent = `.bh-particle{contain:layout style paint;}`;
(document.head || document.documentElement).appendChild(_bhStyle);

/* ==== メッセージ ==== */
chrome.runtime.onMessage.addListener((m) => {
  if (m.action === 'toggle') {
    if (toggling) return;
    on ? off() : activate();
  }
});

/* ==== SPA + YouTube サムネ復活防止 ==== */
let _suppressMutationHandler = false;
const spaObs = new MutationObserver((mutations) => {
  if (_suppressMutationHandler) return;
  if (on && ctr && !document.body.contains(ctr)) mkBH();

  // 吸収済み要素の中に新しく追加されたIMG/VIDEO等も自動で隠す
  if (!on) return;
  for (const m of mutations) {
    if (m.type !== 'childList') continue;
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      // 親が吸収済みなら新しい子も隠す
      const parent = node.parentElement;
      if (parent && parent.getAttribute('data-bh') === '1') {
        node.style.visibility = 'hidden';
        node.style.pointerEvents = 'none';
        continue;
      }
      // YouTube: 新しく挿入されたIMGがマウス付近にあれば即吸収
      if ((node.tagName === 'IMG' || node.tagName === 'VIDEO') && node.getAttribute('data-bh') !== '1') {
        if (isElementProtected(node)) continue;
        const nr = node.getBoundingClientRect();
        if (nr.width > 2 && nr.height > 2) {
          const dist = Math.hypot(bhx - (nr.left + nr.width / 2), bhy - (nr.top + nr.height / 2));
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
});
spaObs.observe(document.body || document.documentElement, { childList: true, subtree: true });

/* ==== ON ==== */
function activate() {
  if (!document.body) { toggling = false; return; }
  toggling = true;
  on = true;
  sz = BH_INITIAL; ambCnt = 0; samplePhase = 0;
  bodies.length = 0; lastTs = 0; totalAbsorbed = 0;
  prevMx = mx; prevMy = my;
  bhx = mx; bhy = my; bhvx = 0; bhvy = 0;
  tailX = mx; tailY = my;

  mkBH();
  scanAndMarkProtected();  // こすくま保護: Ctrl+F方式スキャン
  document.addEventListener('mousemove', onM);
  document.addEventListener('contextmenu', onRC);
  // YouTube等のhoverトリガーを無効化
  for (const ev of HOVER_EVENTS) document.addEventListener(ev, blockHover, true);
  raf = requestAnimationFrame(loop);
  startAmb();
  requestAnimationFrame(() => { toggling = false; });
}

/* ==== OFF — 復元アニメーション ==== */
function off() {
  toggling = true; on = false;


  // ループ・入力を即停止
  if (raf) { cancelAnimationFrame(raf); raf = null; }
  ambId = null; // rAFベースなのでclearInterval不要
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
  const bhX = bhx, bhY = bhy;

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
  let launched = 0;
  const total = restoreJobs.length;
  const startSz = sz;
  // 10秒以内に全復元完了するように動的計算
  const MAX_RESTORE_MS = 10000;
  const AVAILABLE_FRAMES = (MAX_RESTORE_MS / 16.67) * 0.7; // 60fps基準、余裕30%
  const BATCH = Math.max(4, Math.ceil(total / AVAILABLE_FRAMES));
  const MAX_CONCURRENT_RESTORE = Math.max(60, Math.ceil(total / 20));
  let activeRestoreCount = 0;

  document.removeEventListener('mousemove', onM);

  function restoreTick() {
    if (launched >= total) return;
    const budget = Math.min(BATCH, MAX_CONCURRENT_RESTORE - activeRestoreCount);
    if (budget <= 0) {
      requestAnimationFrame(restoreTick);
      return;
    }
    const end = Math.min(launched + budget, total);
    for (let i = launched; i < end; i++) {
      const progress = (i + 1) / total;
      const newSz = Math.max(BH_INITIAL, startSz * (1 - progress * 0.9));
      if (ctr) {
        ctr.style.setProperty('--bh-size', newSz + 'px');
        if (i % 10 === 0 && ctr) {
          ctr.animate([
            { transform: `translate(${bhX}px,${bhY}px) scale(1.08)` },
            { transform: `translate(${bhX}px,${bhY}px) scale(1)` }
          ], { duration: 200, easing: 'ease-out' });
        }
      }
      activeRestoreCount++;
      launchRestore(restoreJobs[i], bhX, bhY, total, () => {
        activeRestoreCount--;
        completed++;
        if (completed >= total) finishOff();
      });
    }
    launched = end;
    if (launched < total) requestAnimationFrame(restoreTick);
  }
  requestAnimationFrame(restoreTick);
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
      `pointer-events:none;z-index:2147483645;border-radius:0;` +
      `transform:scale(0);opacity:0;`;
  } else {
    p.textContent = '';
    p.style.cssText =
      `position:fixed;left:${bhX}px;top:${bhY}px;width:8px;height:8px;` +
      `background:#888;border-radius:50%;` +
      `pointer-events:none;z-index:2147483645;` +
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

  // 10秒以内に完了するよう、総数に応じてdurationを動的調整
  const baseDur = Math.max(120, Math.min(600, 8000 / Math.max(total, 1) * 20));
  const dur = baseDur + Math.random() * (baseDur * 0.4);

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
  const protMarks = document.querySelectorAll('[data-bh-protected]');
  for (const el of protMarks) el.removeAttribute('data-bh-protected');

  for (const t of tids) clearTimeout(t);
  tids.clear();

  // BHフェードアウト
  if (ctr) {
    ctr.classList.add('bh-fadeout');
    const fin = () => { if (ctr) { ctr.remove(); ctr = null; tailEl = null; } toggling = false; };
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
  tailEl = document.createElement('div');
  tailEl.className = 'bh-tail';
  ctr.appendChild(tailEl);
  const c = document.createElement('div');
  c.className = 'bh-core';
  ctr.appendChild(c);
  document.body.appendChild(ctr);
  /* バネ初期位置をマウス位置に合わせる */
  bhx = mx; bhy = my; bhvx = 0; bhvy = 0;
  tailX = mx; tailY = my;
  updSz(); updPos(0);
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

function updPos(dt) {
  if (!ctr) return;

  /* バネ物理: F = -k*(pos-target) - damp*vel */
  if (dt > 0) {
    const fx = -SPRING_K * (bhx - mx) - SPRING_DAMP * bhvx;
    const fy = -SPRING_K * (bhy - my) - SPRING_DAMP * bhvy;
    bhvx += fx * dt;
    bhvy += fy * dt;
    bhx += bhvx * dt;
    bhy += bhvy * dt;

    /* テール: BH位置をさらに遅れて追従 */
    tailX += (bhx - tailX) * TAIL_LAG;
    tailY += (bhy - tailY) * TAIL_LAG;
  }

  const rx = Math.round(bhx * 10) / 10;
  const ry = Math.round(bhy * 10) / 10;
  if (rx === lastPosMx && ry === lastPosMy) return;
  lastPosMx = rx; lastPosMy = ry;
  ctr.style.setProperty('--bh-x', rx + 'px');
  ctr.style.setProperty('--bh-y', ry + 'px');
  ctr.style.transform = `translate(${rx}px,${ry}px)`;

  /* テール描画 — BHからのオフセットで配置 + 速度に応じて伸びる */
  if (tailEl) {
    const dx = tailX - bhx, dy = tailY - bhy;
    const speed = Math.hypot(bhvx, bhvy);
    const stretch = Math.min(2.5, 1 + speed / 400);
    const tailOp = Math.min(0.6, speed / 600);
    if (tailOp > 0.02) {
      const angle = Math.atan2(dy, dx) * 180 / Math.PI;
      tailEl.style.transform =
        `translate(calc(-50% + ${dx * 0.5}px), calc(-50% + ${dy * 0.5}px)) ` +
        `rotate(${angle}deg) scaleX(${stretch})`;
      tailEl.style.opacity = tailOp;
    } else {
      tailEl.style.opacity = '0';
    }
  }
}

function updSz() {
  if (!ctr) return;
  ctr.style.setProperty('--bh-size', sz + 'px');
}

/* ================================================================
   モード — フィルタリング関数
   ================================================================ */

/** textContent に保護ワードを含むか */
function _containsKosukuma(text) {
  if (!text) return false;
  _KOSUKUMA_RE.lastIndex = 0;
  return _KOSUKUMA_RE.test(text);
}

/** テキストノードの保護範囲を計算してWeakMapに格納 */
function _computeRanges(textNode) {
  const text = textNode.textContent;
  if (!text) return;
  _KOSUKUMA_RE.lastIndex = 0;
  const ranges = [];
  let m;
  while ((m = _KOSUKUMA_RE.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  if (ranges.length > 0) _protectedRanges.set(textNode, ranges);
}

/** 分割テキスト対応: 祖先要素内のテキストノードを結合して保護範囲を計算 */
function _computeSplitRanges(ancestorEl) {
  const walker = document.createTreeWalker(ancestorEl, NodeFilter.SHOW_TEXT, null);
  let n, fullText = '';
  const nodes = [];
  while ((n = walker.nextNode())) {
    nodes.push({ node: n, start: fullText.length });
    fullText += n.textContent;
  }
  if (!fullText) return;
  _KOSUKUMA_RE.lastIndex = 0;
  let m;
  const matches = [];
  while ((m = _KOSUKUMA_RE.exec(fullText)) !== null) {
    matches.push([m.index, m.index + m[0].length]);
  }
  if (matches.length === 0) return;
  for (const { node, start } of nodes) {
    const nodeEnd = start + node.textContent.length;
    const ranges = [];
    for (const [mStart, mEnd] of matches) {
      if (mStart < nodeEnd && mEnd > start) {
        const localStart = Math.max(0, mStart - start);
        const localEnd = Math.min(node.textContent.length, mEnd - start);
        ranges.push([localStart, localEnd]);
      }
    }
    if (ranges.length > 0) {
      const existing = _protectedRanges.get(node) || [];
      _protectedRanges.set(node, existing.concat(ranges));
    }
  }
}

/** ページ全体をスキャンして保護情報を事前計算 */
function scanAndMarkProtected() {
  if (!document.body) return;
  let markCount = 0;

  // Step 1: テキストノード走査 — 直接マッチの範囲計算
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent;
    if (_containsKosukuma(text)) {
      _computeRanges(node);
      if (node.parentElement) node.parentElement.setAttribute('data-bh-protected', '1');
      markCount++;
      continue;
    }
    if (text && text.length <= 20) {
      let el = node.parentElement;
      for (let i = 0; i < 10 && el; i++) {
        if (el.hasAttribute('data-bh-protected')) break;
        const tc = el.textContent;
        if (tc && tc.length <= 200 && _containsKosukuma(tc)) {
          el.setAttribute('data-bh-protected', '1');
          _computeSplitRanges(el);
          markCount++;
          break;
        }
        el = el.parentElement;
      }
    }
  }

  // Step 2: 属性チェック → 要素レベル保護
  const attrSels = '[data-name],[title],[alt],[aria-label],[email]';
  try {
    for (const el of document.querySelectorAll(attrSels)) {
      for (const attr of ['data-name', 'title', 'alt', 'aria-label', 'email']) {
        if (_containsKosukuma(el.getAttribute(attr))) {
          el.setAttribute('data-bh-protected', '1');
          _protectedElements.add(el);
          markCount++;
          break;
        }
      }
    }
  } catch {}
  if (markCount > 0) console.log(`[BH] こすくま保護: ${markCount}箇所`);
}

/** テキスト文字が保護対象か — WeakMapルックアップ + フォールバック */
function isProtectedChar(tn, offset) {
  let ranges = _protectedRanges.get(tn);
  if (!ranges) {
    const text = tn.textContent;
    if (!text) return false;
    if (_containsKosukuma(text)) {
      _computeRanges(tn);
      ranges = _protectedRanges.get(tn);
    } else {
      let el = tn.parentElement;
      for (let i = 0; i < 10 && el; i++) {
        if (el.hasAttribute && el.hasAttribute('data-bh-protected')) {
          _computeSplitRanges(el);
          ranges = _protectedRanges.get(tn);
          break;
        }
        el = el.parentElement;
      }
    }
    if (!ranges) return false;
  }
  for (let i = 0; i < ranges.length; i++) {
    if (offset >= ranges[i][0] && offset < ranges[i][1]) return true;
  }
  return false;
}

/** ノードが保護対象か（祖先チェック — 要素吸収用） */
function isProtected(node) {
  let el = node && node.nodeType === 3 ? node.parentElement : node;
  while (el) {
    if (el.hasAttribute && el.hasAttribute('data-bh-protected')) return true;
    el = el.parentElement;
  }
  return false;
}

/** 要素が保護対象か（画像・動画用） */
const isElementProtected = (el) => _protectedElements.has(el) || isProtected(el);

/* ================================================================
   メインループ
   ================================================================ */
let skipPeel = false;

function loop(ts) {
  if (!on) return;
  const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.05) : 0.016;
  lastTs = ts;
  const frameStart = performance.now();

  // フレーム全体でMutationObserverを抑制（physicsAndAbsorb/spawnAmbのstyle書き込みも含む）
  _suppressMutationHandler = true;

  updPos(dt);
  if (szDirty) { updSz(); szDirty = false; }

  const moved = Math.hypot(mx - prevMx, my - prevMy) > 2;
  if (!skipPeel || moved) peel();

  physicsAndAbsorb(dt);
  trySpawnAmb(ts);
  maybeNormalize(ts);

  // フレーム終了: 溜まったmutationを破棄してからobserver再開
  spaObs.takeRecords();
  _suppressMutationHandler = false;

  const elapsed = performance.now() - frameStart;
  skipPeel = elapsed > 12 && bodies.length > 200;

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

  const baseRate = Math.min(20, 3 + Math.floor(sz / 20));
  const pressure = bodies.length / MAX_BODIES;
  const rate = pressure > 0.7 ? Math.max(3, Math.floor(baseRate * (1 - pressure))) : baseRate;
  const touchR = sz / 2 + 3;

  /* サンプル数はv1.1.0と同じ（軽量） */
  const nAngles = Math.min(16, 4 + Math.floor(sz / 20));
  const nRings  = Math.min(5, 2 + Math.floor(sz / 60));

  /* pts flat array: [x0,y0,x1,y1,...] — GCゼロ */
  _ptsLen = 0;
  function pushPt(x, y) {
    if (_ptsLen + 2 > _ptsFlat.length) {
      const next = new Float64Array(_ptsFlat.length * 2);
      next.set(_ptsFlat);
      _ptsFlat = next;
    }
    _ptsFlat[_ptsLen++] = x;
    _ptsFlat[_ptsLen++] = y;
  }
  /* BHの描画位置（バネ出力）を吸い込み中心とする */
  const cx0 = bhx, cy0 = bhy;
  pushPt(cx0, cy0);

  /* 高速移動対策: 前フレーム→現在フレームの移動パスに沿ってサンプリング */
  const moveDist = Math.hypot(cx0 - prevMx, cy0 - prevMy);
  if (moveDist > touchR * 0.5) {
    const steps = Math.min(8, Math.ceil(moveDist / (touchR * 0.5)));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const ix = prevMx + (cx0 - prevMx) * t;
      const iy = prevMy + (cy0 - prevMy) * t;
      pushPt(ix, iy);
      /* 移動パスの各点にも少し周囲サンプル */
      for (let a = 0; a < 4; a++) {
        const ang = (a / 4) * Math.PI * 2;
        pushPt(ix + Math.cos(ang) * touchR * 0.5, iy + Math.sin(ang) * touchR * 0.5);
      }
    }
  }

  /* 現在位置の周囲サンプリング
   * BH内部（不透明）にサンプルしても何も検出できないので、
   * 視覚端(35%)〜外縁(100%)の範囲でのみ検出する */
  const innerFrac = 0.35;
  /* インターリーブ: 全角度の1/2だけスキャン、2フレームでフルカバレッジ */
  for (let i = samplePhase % 2; i < nAngles; i += 2) {
    const a = ((samplePhase + i) % (nAngles * 2));
    const ang = (a / (nAngles * 2)) * Math.PI * 2;
    for (let r = 1; r <= nRings; r++) {
      const frac = innerFrac + (r / (nRings + 1)) * (1 - innerFrac);
      pushPt(cx0 + Math.cos(ang) * touchR * frac, cy0 + Math.sin(ang) * touchR * frac);
    }
  }
  samplePhase++;

  prevMx = cx0; prevMy = cy0;

  /* ========== Phase 1: Read-only — collect hits without DOM mutation ========== */
  _textHits.length = 0;
  _elemHits.length = 0;
  _triedEls.clear();
  _textHitIdx = 0;
  _elemHitIdx = 0;
  _posCacheGen++; // positionキャッシュ世代更新
  let n = 0;
  let caretCalls = 0;
  const MAX_CARET_PER_FRAME = 12; // caretRangeFromPoint は同期レイアウト強制 — フレーム上限

  for (let pi = 0; pi < _ptsLen; pi += 2) {
    if (n >= rate) break;
    const px = _ptsFlat[pi], py = _ptsFlat[pi + 1];

    // ① テキスト文字を検出（read-only: caretRangeFromPoint + charRect）
    let range = null;
    if (caretCalls < MAX_CARET_PER_FRAME) {
      range = document.caretRangeFromPoint(px, py);
      caretCalls++;
    }
    if (range && range.startContainer.nodeType === 3) {
      const tn = range.startContainer;
      const offset = range.startOffset;

      // 既に消した文字のspan内ならスキップ
      if (tn.parentElement && tn.parentElement.hasAttribute('data-bh-erased')) continue;

      if (offset < tn.textContent.length) {
        const cpLen = cpLength(tn.textContent, offset);
        const ch = tn.textContent.slice(offset, offset + cpLen);
        if (ch && ch !== '\n' && ch !== '\r' && ch !== '\t' && ch.trim()) {
          // こすくま保護: この文字がこすくまワードの一部ならスキップ
          if (isProtectedChar(tn, offset)) continue;

          const rc = charRect(tn, offset, cpLen);
          if (rc && rc.width > 0.3 && rc.height > 0.3) {
            const pe = tn.parentElement;
            if (pe && sz < PHASE_FIXED) {
              const pos = getCachedPosition(pe);
              if (pos === 'fixed' || pos === 'sticky') continue;
            }

            _textHits.push(_acquireTextHit(tn, offset, cpLen, rc, pe));
            n++;
            continue;
          }
        }
      }
    }

    // ② 非テキスト要素を検出（read-only: elementFromPoint + checks）
    const el = document.elementFromPoint(px, py);
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
      _elemHits.push(_acquireElemHit('pseudo', el, null, null));
      continue;
    }

    if (el.tagName === 'IMG' || el.tagName === 'PICTURE') {
      const img = el.tagName === 'PICTURE' ? el.querySelector('img') : el;
      if (img) {
        if (isElementProtected(img)) continue;
        _elemHits.push(_acquireElemHit('img', img, null, null));
        n++;
      }
      continue;
    }

    if (el.tagName === 'VIDEO') {
      if (isElementProtected(el)) continue;
      _elemHits.push(_acquireElemHit('video', el, null, null));
      n++;
      continue;
    }

    if (el.tagName === 'CANVAS') {
      if (isElementProtected(el)) continue;
      _elemHits.push(_acquireElemHit('canvas', el, null, null));
      n++;
      continue;
    }

    if (el.tagName === 'svg' || el.tagName === 'SVG' || el instanceof SVGElement) {
      if (isElementProtected(el)) continue;
      _elemHits.push(_acquireElemHit('svg', el, null, null));
      n++;
      continue;
    }

    if (el.tagName === 'IFRAME') {
      if (isElementProtected(el)) continue;
      _elemHits.push(_acquireElemHit('iframe', el, null, null));
      n++;
      continue;
    }

    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;

    if (el.shadowRoot) {
      _elemHits.push(_acquireElemHit('shadow', el, null, null));
    }

    const bgImg = getComputedStyle(el).backgroundImage;
    if (bgImg && bgImg !== 'none' && !hasVisibleText(el)) {
      if (isElementProtected(el)) continue;
      _elemHits.push(_acquireElemHit('bgImage', el, r, bgImg));
      n++;
      continue;
    }

    if (r.width * r.height > 40000 && el.children.length > 5) continue;

    if (isElementProtected(el)) continue;

    if (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      if (!hasVisibleText(el) || el.tagName === 'INPUT') {
        _elemHits.push(_acquireElemHit('absorb', el, r, null));
        n++;
        continue;
      }
    }

    _elemHits.push(_acquireElemHit('absorbPseudo', el, r, null));
    n++;
  }

  /* ========== Phase 2: Write — DOM mutations ========== */
  // (MutationObserverはloop()がフレーム全体で抑制中)

  // Text hits: group by text node, sort offsets descending, process 1 per node
  _byNode.clear();
  for (const hit of _textHits) {
    if (!_byNode.has(hit.tn)) _byNode.set(hit.tn, hit);
    else if (hit.offset > _byNode.get(hit.tn).offset) _byNode.set(hit.tn, hit);
  }
  for (const hit of _byNode.values()) {
    const span = eraseChar(hit.tn, hit.offset, hit.cpLen);
    if (span) { mkCharBody(span, hit.rc, hit.pe); }
  }

  // Element hits: process in order
  for (const hit of _elemHits) {
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
        peelShadow(hit.el.shadowRoot);
        break;
      case 'bgImage': {
        const bs = tileBgImage(hit.el, hit.r, hit.bgImg);
        for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
        break;
      }
      case 'absorb':
        absorbEl(hit.el, hit.r);
        break;
      case 'absorbPseudo':
        peelPseudo(hit.el);
        absorbEl(hit.el, hit.r);
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
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      const paddingLeft = parseFloat(st.paddingLeft) || 0;
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

function mkPseudoBody(text, rc, st) {
  const p = document.createElement('span');
  p.className = 'bh-particle';
  p.textContent = text;
  p.style.cssText =
    `position:fixed;left:${rc.left}px;top:${rc.top}px;` +
    `font-size:${st.fontSize || '16px'};font-family:${st.fontFamily || 'inherit'};` +
    `font-weight:${st.fontWeight || 'normal'};color:${st.color || '#000'};` +
    `line-height:1;margin:0;padding:0;background:none;` +
    `pointer-events:none;z-index:2147483645;border-radius:0;`;
  document.body.appendChild(p);

  const cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2;
  const dx = bhx - cx, dy = bhy - cy;
  const d = Math.hypot(dx, dy) || 1;

  bodies.push({
    el: p, x: cx, y: cy, ox: cx, oy: cy,
    vx: (dx / d) * INIT_SPEED, vy: (dy / d) * INIT_SPEED, rot: 0
  });
}


function eraseChar(tn, offset, cpLen) {
  try {
    const text = tn.textContent;
    const before = text.slice(0, offset);
    const ch = text.slice(offset, offset + cpLen);
    const after = text.slice(offset + cpLen);
    const parent = tn.parentNode;
    if (!parent) return null;

    // 消した文字を<span>でラップ
    const span = document.createElement('span');
    span.textContent = ch;
    span.style.color = 'transparent';
    span.setAttribute('data-bh-erased', '1');

    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));
    frag.appendChild(span);
    if (after) frag.appendChild(document.createTextNode(after));
    parent.replaceChild(frag, tn);

    // DOM断片化トラッキング: 親をdirtyとして記録 → 定期normalize()で結合
    _dirtyParents.add(parent);

    return span;
  } catch { return null; }
}

/* ---- 1文字のテキストパーティクル生成 ---- */
function mkCharBody(span, rc, parentEl) {
  const pe = parentEl || span.parentElement;
  const st = pe ? getComputedStyle(pe) : null;
  const p = document.createElement('span');
  p.className = 'bh-particle';
  p.textContent = span.textContent;
  p.style.cssText =
    `position:fixed;left:${rc.left}px;top:${rc.top}px;` +
    `font-size:${st ? st.fontSize : '16px'};font-family:${st ? st.fontFamily : 'inherit'};` +
    `font-weight:${st ? st.fontWeight : 'normal'};color:${st ? st.color : '#000'};` +
    `line-height:1;margin:0;padding:0;background:none;` +
    `pointer-events:none;z-index:2147483645;border-radius:0;`;
  document.body.appendChild(p);

  const cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2;
  const dx = bhx - cx, dy = bhy - cy;
  const d = Math.hypot(dx, dy) || 1;

  bodies.push({
    el: p, x: cx, y: cy, ox: cx, oy: cy,
    vx: (dx / d) * INIT_SPEED, vy: (dy / d) * INIT_SPEED, rot: 0
  });
}

/* ---- 要素の単体吸収 ---- */
function absorbEl(el, r) {
  if (isElementProtected(el)) return;
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
    `z-index:2147483645;`;
  document.body.appendChild(clone);

  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const dx = bhx - cx, dy = bhy - cy;
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
        `pointer-events:none;z-index:2147483645;border-radius:0;`;
      d.style.backgroundImage = `url("${src.replace(/["\\()]/g, '\\$&')}")`;
      d.style.backgroundPosition = `-${col * tw}px -${row * th}px`;
      d.style.backgroundSize = `${r.width}px ${r.height}px`;
      document.body.appendChild(d);

      const cx = x + w / 2, cy = y + h / 2;
      const dx = bhx - cx, dy = bhy - cy;
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
        `pointer-events:none;z-index:2147483645;border-radius:0;`;
      if (dataUrl) {
        d.style.backgroundImage = `url("${dataUrl}")`;
        d.style.backgroundPosition = `-${col * tw}px -${row * th}px`;
        d.style.backgroundSize = `${r.width}px ${r.height}px`;
      } else {
        d.style.background = '#111';
      }
      document.body.appendChild(d);

      const cx = x + w / 2, cy = y + h / 2;
      const dx = bhx - cx, dy = bhy - cy;
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
        `pointer-events:none;z-index:2147483645;border-radius:0;`;
      if (dataUrl) {
        d.style.backgroundImage = `url("${dataUrl}")`;
        d.style.backgroundPosition = `-${col * tw}px -${row * th}px`;
        d.style.backgroundSize = `${r.width}px ${r.height}px`;
      } else {
        d.style.background = '#222';
      }
      document.body.appendChild(d);

      const cx = x + w / 2, cy = y + h / 2;
      const dx = bhx - cx, dy = bhy - cy;
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
        `pointer-events:none;z-index:2147483645;border-radius:0;` +
        `background:${bgImg};background-size:${r.width}px ${r.height}px;` +
        `background-position:-${col * tw}px -${row * th}px;`;
      document.body.appendChild(d);

      const cx = x + w / 2, cy = y + h / 2;
      const dx = bhx - cx, dy = bhy - cy;
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
      // こすくま保護: WeakMapになければオンデマンド計算
      if (!_protectedRanges.has(node) && _containsKosukuma(text)) _computeRanges(node);
      if (isProtectedChar(node, i)) continue;
      const rc = charRect(node, i, cpLen);
      if (!rc || rc.width < 0.3 || rc.height < 0.3) continue;
      const span = eraseChar(node, i, cpLen);
      if (span) {
        mkCharBody(span, rc, parent);
        return; // eraseCharがDOMを変更するのでTreeWalkerが無効 — 次フレームで再入
      }
    }
  }

  // Shadow DOM内の要素も吸収
  const els = root.querySelectorAll('img, video, canvas, svg, button');
  for (const el of els) {
    if (el.getAttribute('data-bh') === '1') continue;
    if (el.tagName === 'IMG') {
      if (isElementProtected(el)) continue;
      const bs = tileImg(el);
      for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
    } else if (el.tagName === 'VIDEO') {
      if (isElementProtected(el)) continue;
      const bs = tileVideo(el);
      for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
    } else if (el.tagName === 'CANVAS') {
      if (isElementProtected(el)) continue;
      const bs = tileCanvas(el);
      for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
    } else if (el.tagName === 'svg' || el.tagName === 'SVG' || el instanceof SVGElement) {
      if (isElementProtected(el)) continue;
      const bs = tileSVG(el);
      for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
    } else {
      if (isElementProtected(el)) continue;
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
        `pointer-events:none;z-index:2147483645;border-radius:0;`;
      d.style.backgroundImage = `url("${src.replace(/["\\()]/g, '\\$&')}")`;
      d.style.backgroundPosition = `-${col * tw}px -${row * th}px`;
      d.style.backgroundSize = `${r.width}px ${r.height}px`;
      document.body.appendChild(d);

      const cx = x + w / 2, cy = y + h / 2;
      const dx = bhx - cx, dy = bhy - cy;
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
        `background:${color};pointer-events:none;z-index:2147483645;border-radius:0;`;
      document.body.appendChild(d);

      const cx = x + w / 2, cy = y + h / 2;
      const dx = bhx - cx, dy = bhy - cy;
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
function physicsAndAbsorb(dt) {
  const field = sz * BH_FIELD;
  const damp = Math.pow(DAMPING, dt * 60);
  const vw = window.innerWidth, vh = window.innerHeight;
  const coreSq = (sz * 0.6) * (sz * 0.6);
  let write = 0;

  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    const dx = bhx - b.x;
    const dy = bhy - b.y;
    const distSq = dx * dx + dy * dy;

    // 吸収判定（distSq再利用でsqrt不要）
    if (distSq < coreSq) {
      b.el.remove();
      grow();
      continue;
    }

    const dist = Math.sqrt(distSq);
    if (dist < 0.5) { bodies[write++] = b; continue; }

    const nx = dx / dist;
    const ny = dy / dist;

    const t = Math.max(0, 1 - dist / field);
    const acc = GRAVITY * (0.5 + 0.5 * t);

    b.vx += (nx + ny * TANGENT) * acc * dt;
    b.vy += (ny - nx * TANGENT) * acc * dt;
    b.vx *= damp;
    b.vy *= damp;

    // 速度クランプ — spdSqで比較してsqrt回避
    const spdSq = b.vx * b.vx + b.vy * b.vy;
    const maxSpdSq = MAX_SPEED * MAX_SPEED;
    if (spdSq > maxSpdSq) { const s = MAX_SPEED / Math.sqrt(spdSq); b.vx *= s; b.vy *= s; }

    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // rot — |vx|+|vy|近似でsqrt不要（回転角度に精度は不要）
    b.rot += (Math.abs(b.vx) + Math.abs(b.vy)) * dt * 0.15;

    // BHコア付近は次フレームで吸収されるのでDOM更新をスキップ
    if (dist < sz * 0.25) { bodies[write++] = b; continue; }

    // P3: Viewport culling
    if (b.x < -100 || b.x > vw + 100 || b.y < -100 || b.y > vh + 100) { bodies[write++] = b; continue; }

    const scaleR = sz * 1.2;
    const scale = dist < scaleR ? Math.max(0.05, dist / scaleR) : 1;
    const opacity = dist < sz ? Math.max(0.1, dist / sz) : 1;

    // dirtyチェック + 整数化
    const tx = (b.x - b.ox + 0.5) | 0;
    const ty = (b.y - b.oy + 0.5) | 0;
    const rot = b.rot | 0;
    const sc = ((scale * 1000 + 0.5) | 0);
    const op = opacity < 0.99 ? ((opacity * 100 + 0.5) | 0) : 100;
    if (tx === b._ptx && ty === b._pty && rot === b._prot && sc === b._psc && op === b._pop) { bodies[write++] = b; continue; }
    b._ptx = tx; b._pty = ty; b._prot = rot; b._psc = sc; b._pop = op;

    // opacity込みのtransform一括書き込み — style.opacity個別変更によるレイヤー昇格/降格を回避
    b.el.style.transform = 'translate(' + tx + 'px,' + ty + 'px)rotate(' + rot + 'deg)scale(' + (sc / 1000) + ')';
    b.el.style.opacity = op / 100;

    bodies[write++] = b;
  }
  bodies.length = write;
}

function grow() {
  totalAbsorbed++;
  let stepped = false;
  for (const [threshold, jumpSz] of GROWTH_STEPS) {
    if (totalAbsorbed === threshold && sz < jumpSz) {
      sz = jumpSz;
      stepped = true;
      break;
    }
  }
  if (!stepped) {
    sz += GROW_RATE;
  }

  // 漸進成長はダーティフラグ（1フレーム1回だけ更新）
  // 階段ジャンプ時は即座に更新（視覚的に重要）
  if (stepped) {
    updSz();
    if (ctr) {
      ctr.animate([
        { transform: `translate(${bhx}px,${bhy}px) scale(1.15)` },
        { transform: `translate(${bhx}px,${bhy}px) scale(1)` }
      ], { duration: 300, easing: 'ease-out' });
    }
  } else {
    szDirty = true;
  }
}

/* ==== 環境パーティクル ==== */
let lastAmbSpawn = performance.now();
function startAmb() {
  // rAFループ内でタイムスタンプベースで制御（setInterval廃止）
  lastAmbSpawn = performance.now();
}

function trySpawnAmb(ts) {
  if (!on || sz < PHASE2 || ambCnt >= 5) return;
  if (ts - lastAmbSpawn < 800) return;
  lastAmbSpawn = ts;
  spawnAmb();
}

function spawnAmb() {
  const p = document.createElement('div');
  p.className = 'bh-particle';
  const s = 2 + Math.random() * 2;
  const cols = sz >= 300 ? COL3 : sz >= PHASE2 ? COL2 : COL1;
  const col = cols[Math.random() * cols.length | 0];
  const ang = Math.random() * Math.PI * 2;
  const dist = sz * 0.8 + Math.random() * 30;
  const sx = bhx + Math.cos(ang) * dist, sy = bhy + Math.sin(ang) * dist;
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
  const midX = bhx + Math.cos(ma)*md - sx, midY = bhy + Math.sin(ma)*md - sy;
  const endX = bhx - sx, endY = bhy - sy;

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
    const snippet = str.slice(offset, offset + 20);  // 最大20文字でZWJ最長をカバー
    const iter = _segmenter.segment(snippet)[Symbol.iterator]();
    const first = iter.next();
    if (!first.done) return first.value.segment.length;
  }
  return 1;
}

function charRect(tn, i, len) {
  try {
    const r = document.createRange();
    r.setStart(tn, i); r.setEnd(tn, i + len);
    const rects = r.getClientRects();
    return rects.length ? rects[0] : null;
  } catch { return null; }
}

function hasVisibleText(el) {
  if (el.tagName && LEAF_TAGS.has(el.tagName)) return false;
  const tc = el.textContent;
  if (!tc || !tc.trim()) return false;
  // 高速パス: textContentが十分長ければテキストあり（erasedスパンのtextは空なので影響小）
  if (tc.trim().length > 1) return true;
  // 1文字のみの場合: erasedかどうかTreeWalkerで確認
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement && node.parentElement.hasAttribute('data-bh-erased')) continue;
    if (node.textContent.trim()) return true;
  }
  return false;
}
