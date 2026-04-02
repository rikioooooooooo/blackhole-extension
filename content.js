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
const BH_MAX      = 500;
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
const PHASE_DARK  = 300;
const PHASE_PULL  = 400;
const PHASE_MAX   = 500;

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
let ctr = null, ovl = null;
let raf = null, ambId = null, ambCnt = 0;
let lastTs = 0, samplePhase = 0, prevMx = 0, prevMy = 0;
let totalAbsorbed = 0;

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
const ambParts  = [];

/* ==== メッセージ ==== */
chrome.runtime.onMessage.addListener((m) => {
  if (m.action === 'toggle') {
    if (toggling) return;
    on ? off() : activate();
  }
});

/* ==== SPA ==== */
const spaObs = new MutationObserver(() => {
  if (on && ctr && !document.body.contains(ctr)) mkBH();
});
spaObs.observe(document.body || document.documentElement, { childList: true });

/* ==== ON ==== */
function activate() {
  if (!document.body) { toggling = false; return; }
  toggling = true;
  on = true;
  sz = BH_INITIAL; ambCnt = 0; samplePhase = 0;
  bodies.length = 0; lastTs = 0; totalAbsorbed = 0;
  prevMx = mx; prevMy = my;

  mkBH();
  document.addEventListener('mousemove', onM);
  document.addEventListener('contextmenu', onRC);
  raf = requestAnimationFrame(loop);
  startAmb();
  requestAnimationFrame(() => { toggling = false; });
}

/* ==== OFF — 復元アニメーション ==== */
function off() {
  toggling = true; on = false;

  // ループ・入力を即停止
  if (raf) { cancelAnimationFrame(raf); raf = null; }
  if (ambId) { clearInterval(ambId); ambId = null; }
  document.removeEventListener('contextmenu', onRC);

  // 吸引中のパーティクル除去
  for (const b of bodies) b.el.remove();
  bodies.length = 0;

  // 環境パーティクル除去
  for (const p of ambParts) {
    p.getAnimations().forEach(a => a.cancel());
    p.remove();
  }
  ambParts.length = 0;
  ambCnt = 0;

  // オーバーレイ除去
  document.documentElement.classList.remove('bh-screen-shake');
  if (ovl) { ovl.style.opacity = '0'; const o = ovl; const t = setTimeout(() => { o.remove(); tids.delete(t); }, 600); tids.add(t); ovl = null; }

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
  const TOTAL_LAUNCH_MS = 1200;  // 全射出にかける時間
  const STAGGER = Math.max(5, Math.min(20, TOTAL_LAUNCH_MS / total));
  const startSz = sz;

  restoreJobs.forEach((job, i) => {
    const tid = setTimeout(() => {
      tids.delete(tid);

      // BHが縮む（吐き出すほど小さくなる）
      const progress = (i + 1) / total;
      const newSz = Math.max(BH_INITIAL, startSz * (1 - progress * 0.9));
      if (ctr) {
        ctr.style.setProperty('--bh-size', newSz + 'px');
        // 吐き出し時に微振動
        if (i % 5 === 0) {
          ctr.classList.remove('bh-gulp');
          void ctr.offsetHeight;
          ctr.classList.add('bh-gulp');
        }
      }

      launchRestore(job, bhX, bhY, () => {
        completed++;
        if (completed >= total) finishOff();
      });
    }, i * STAGGER);
    tids.add(tid);
  });

  document.removeEventListener('mousemove', onM);
}

/* ---- 1つの復元パーティクルを射出 ---- */
function launchRestore(job, bhX, bhY, onDone) {
  const p = document.createElement('span');
  p.className = 'bh-particle';

  if (job.type === 'text' || job.type === 'marker') {
    p.textContent = job.text;
    p.style.cssText =
      `position:fixed;left:${bhX}px;top:${bhY}px;` +
      `font-size:${job.fontSize};font-family:${job.fontFamily};` +
      `font-weight:${job.fontWeight};color:${job.color};` +
      `line-height:1;margin:0;padding:0;background:none;` +
      `pointer-events:none;z-index:2147483645;will-change:transform;border-radius:0;` +
      `transform:scale(0);opacity:0;`;
  } else {
    p.textContent = '';
    p.style.cssText =
      `position:fixed;left:${bhX}px;top:${bhY}px;width:8px;height:8px;` +
      `background:#888;border-radius:50%;` +
      `pointer-events:none;z-index:2147483645;will-change:transform;` +
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

  const dur = 600 + Math.random() * 400;

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

function updPos() {
  if (!ctr) return;
  ctr.style.setProperty('--bh-x', mx + 'px');
  ctr.style.setProperty('--bh-y', my + 'px');
  ctr.style.transform = `translate(${mx}px,${my}px)`;
}

function updSz() {
  if (!ctr) return;
  ctr.style.setProperty('--bh-size', sz + 'px');
  if (sz >= PHASE_DARK) { ensureOvl(); ovl.style.opacity = sz >= PHASE_PULL ? '0.5' : '0.3'; }
  if (sz >= PHASE_MAX) document.documentElement.classList.add('bh-screen-shake');
}

function ensureOvl() {
  if (ovl && document.body.contains(ovl)) return;
  ovl = document.createElement('div');
  ovl.id = 'bh-overlay';
  document.body.appendChild(ovl);
  requestAnimationFrame(() => { if (ovl) ovl.style.opacity = '0.3'; });
}

/* ================================================================
   メインループ
   ================================================================ */
function loop(ts) {
  if (!on) return;
  const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.05) : 0.016;
  lastTs = ts;

  updPos();
  peel();
  physics(dt);
  absorb();

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

  const rate = Math.min(20, 3 + Math.floor(sz / 20));
  const touchR = sz / 2 + 3;

  /* サンプル数をBHサイズに比例 — 大きいBHほど密にカバー */
  const nAngles = Math.min(16, 4 + Math.floor(sz / 20));
  const nRings  = Math.min(5, 2 + Math.floor(sz / 60));

  const pts = [[mx, my]];

  /* 高速移動対策: 前フレーム→現在フレームの移動パスに沿ってサンプリング */
  const moveDist = Math.hypot(mx - prevMx, my - prevMy);
  if (moveDist > touchR * 0.5) {
    const steps = Math.min(8, Math.ceil(moveDist / (touchR * 0.5)));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const ix = prevMx + (mx - prevMx) * t;
      const iy = prevMy + (my - prevMy) * t;
      pts.push([ix, iy]);
      /* 移動パスの各点にも少し周囲サンプル */
      for (let a = 0; a < 4; a++) {
        const ang = (a / 4) * Math.PI * 2;
        pts.push([ix + Math.cos(ang) * touchR * 0.5, iy + Math.sin(ang) * touchR * 0.5]);
      }
    }
  }

  /* 現在位置の周囲サンプリング */
  for (let i = 0; i < nAngles; i++) {
    const a = ((samplePhase + i) % (nAngles * 2));
    const ang = (a / (nAngles * 2)) * Math.PI * 2;
    for (let r = 1; r <= nRings; r++) {
      const frac = r / (nRings + 1);
      pts.push([mx + Math.cos(ang) * touchR * frac, my + Math.sin(ang) * touchR * frac]);
    }
  }
  samplePhase = (samplePhase + nAngles) % (nAngles * 2);

  prevMx = mx; prevMy = my;

  let n = 0;
  const triedEls = new Set();

  for (const [px, py] of pts) {
    if (n >= rate) break;

    // ① テキスト文字を検出
    const range = document.caretRangeFromPoint(px, py);
    if (range && range.startContainer.nodeType === 3) {
      const tn = range.startContainer;
      const offset = range.startOffset;

      // 既に消した文字のspan内ならスキップ
      if (tn.parentElement && tn.parentElement.hasAttribute('data-bh-erased')) continue;

      if (offset < tn.textContent.length) {
        const cpLen = cpLength(tn.textContent, offset);
        const ch = tn.textContent.slice(offset, offset + cpLen);
        if (ch && ch !== '\n' && ch !== '\r' && ch !== '\t' && ch.trim()) {
          const rc = charRect(tn, offset, cpLen);
          if (rc && rc.width > 0.3 && rc.height > 0.3) {
            const pe = tn.parentElement;
            if (pe && sz < PHASE_FIXED) {
              const pos = getComputedStyle(pe).position;
              if (pos === 'fixed' || pos === 'sticky') continue;
            }

            // ★ 文字をDOM上で透明化し、パーティクルを生成
            const span = eraseChar(tn, offset, cpLen);
            if (span) {
              mkCharBody(span, rc, pe);
              n++;
            }
            continue;
          }
        }
      }
    }

    // ② 非テキスト要素を検出
    const el = document.elementFromPoint(px, py);
    if (!el || triedEls.has(el)) continue;
    triedEls.add(el);
    if (SKIP.has(el.tagName)) continue;
    if (el.id === 'bh-container' || el.id === 'bh-overlay') continue;
    if (ctr && ctr.contains(el)) continue;
    if (el.classList && el.classList.contains('bh-particle')) continue;
    if (el.getAttribute('data-bh') === '1') continue;
    if (el.hasAttribute('data-bh-erased')) continue;

    if (sz < PHASE_FIXED) {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') continue;
    }

    if (hasVisibleText(el)) {
      // テキストがまだ残っている要素でも、リストマーカーや疑似要素は吸収可能
      peelPseudo(el);
      continue;
    }

    if (el.tagName === 'IMG' || el.tagName === 'PICTURE') {
      const img = el.tagName === 'PICTURE' ? el.querySelector('img') : el;
      if (img) {
        const bs = tileImg(img);
        for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
        n += bs.length;
      }
      continue;
    }

    // VIDEO: 現在フレームをキャプチャしてタイル分解
    if (el.tagName === 'VIDEO') {
      const bs = tileVideo(el);
      for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
      n += bs.length;
      continue;
    }

    // CANVAS (2D / WebGL): タイル分解
    if (el.tagName === 'CANVAS') {
      const bs = tileCanvas(el);
      for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
      n += bs.length;
      continue;
    }

    // SVG: canvas経由でラスタライズしてタイル分解
    if (el.tagName === 'svg' || el.tagName === 'SVG' || el instanceof SVGElement) {
      const bs = tileSVG(el);
      for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
      n += bs.length;
      continue;
    }

    // IFRAME: 同一オリジンのみ吸収
    if (el.tagName === 'IFRAME') {
      const bs = tileIframe(el);
      for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
      n += bs.length;
      continue;
    }

    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;

    // Shadow DOM: openなshadowRootの中身を再帰的にチェック
    if (el.shadowRoot) {
      peelShadow(el.shadowRoot);
    }

    // CSS背景画像: backgroundImageがある要素はタイル化
    const bgImg = getComputedStyle(el).backgroundImage;
    if (bgImg && bgImg !== 'none' && !hasVisibleText(el)) {
      const bs = tileBgImage(el, r, bgImg);
      for (const b of bs) { if (bodies.length < MAX_BODIES) bodies.push(b); }
      n += bs.length;
      continue;
    }

    // 大きい要素でも子が少なければ吸収OK（動画オーバーレイ等）
    if (r.width * r.height > 40000 && el.children.length > 5) continue;

    // フォームコントロール
    if (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      if (!hasVisibleText(el) || el.tagName === 'INPUT') {
        absorbEl(el, r);
        n++;
        continue;
      }
    }

    // リストマーカー・疑似要素もパーティクル化
    peelPseudo(el);
    absorbEl(el, r);
    n++;
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
    `pointer-events:none;z-index:2147483645;will-change:transform;border-radius:0;`;
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
    `pointer-events:none;z-index:2147483645;will-change:transform;border-radius:0;`;
  document.body.appendChild(p);

  const cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2;
  const dx = mx - cx, dy = my - cy;
  const d = Math.hypot(dx, dy) || 1;

  bodies.push({
    el: p, x: cx, y: cy, ox: cx, oy: cy,
    vx: (dx / d) * INIT_SPEED, vy: (dy / d) * INIT_SPEED, rot: 0
  });
}

/* ---- 要素の単体吸収 ---- */
function absorbEl(el, r) {
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
    `z-index:2147483645;will-change:transform;`;
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
        `pointer-events:none;z-index:2147483645;will-change:transform;border-radius:0;`;
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
        `pointer-events:none;z-index:2147483645;will-change:transform;border-radius:0;`;
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
        `pointer-events:none;z-index:2147483645;will-change:transform;border-radius:0;`;
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
        `pointer-events:none;z-index:2147483645;will-change:transform;border-radius:0;` +
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
        `pointer-events:none;z-index:2147483645;will-change:transform;border-radius:0;`;
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
        `background:${color};pointer-events:none;z-index:2147483645;will-change:transform;border-radius:0;`;
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
function physics(dt) {
  const field = sz * BH_FIELD;
  const damp = Math.pow(DAMPING, dt * 60);

  for (const b of bodies) {
    const dx = mx - b.x;
    const dy = my - b.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.5) continue;

    const nx = dx / dist;
    const ny = dy / dist;

    const t = Math.max(0, 1 - dist / field);
    const acc = GRAVITY * (0.5 + 0.5 * t);

    b.vx += (nx + ny * TANGENT) * acc * dt;
    b.vy += (ny - nx * TANGENT) * acc * dt;
    b.vx *= damp;
    b.vy *= damp;

    const spd = Math.hypot(b.vx, b.vy);
    if (spd > MAX_SPEED) { const s = MAX_SPEED / spd; b.vx *= s; b.vy *= s; }

    b.x += b.vx * dt;
    b.y += b.vy * dt;

    const cSpd = Math.min(spd, MAX_SPEED);
    b.rot += cSpd * dt * 0.3;

    const scaleR = sz * 1.2;
    const scale = dist < scaleR ? Math.max(0.05, dist / scaleR) : 1;
    const opacity = dist < sz ? Math.max(0.1, dist / sz) : 1;

    b.el.style.transform =
      `translate(${b.x - b.ox}px,${b.y - b.oy}px) rotate(${b.rot | 0}deg) scale(${scale.toFixed(3)})`;
    b.el.style.opacity = opacity.toFixed(2);
  }
}

/* ==== 吸収 ==== */
function absorb() {
  const core = sz / 2;
  let write = 0;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    if (Math.hypot(b.x - mx, b.y - my) < core) {
      b.el.remove();
      grow();
    } else {
      bodies[write++] = b;
    }
  }
  bodies.length = write;
}

function grow() {
  if (sz >= BH_MAX) return;
  totalAbsorbed++;

  // 階段式成長チェック
  let stepped = false;
  for (const [threshold, jumpSz] of GROWTH_STEPS) {
    if (totalAbsorbed === threshold && sz < jumpSz) {
      sz = Math.min(jumpSz, BH_MAX);
      stepped = true;
      break;
    }
  }

  // 通常の漸進成長
  if (!stepped) {
    sz = Math.min(sz + GROW_RATE, BH_MAX);
  }

  updSz();

  // 階段ジャンプ時は強いバウンス
  if (stepped && ctr) {
    ctr.classList.remove('bh-gulp');
    void ctr.offsetHeight;
    ctr.classList.add('bh-gulp');
    ctr.addEventListener('animationend', () => { if (ctr) ctr.classList.remove('bh-gulp'); }, { once: true });
  }
}

/* ==== 環境パーティクル ==== */
function startAmb() {
  ambId = setInterval(() => { if (!on || sz < PHASE2 || ambCnt >= 5) return; spawnAmb(); }, 800);
}

function spawnAmb() {
  const p = document.createElement('div');
  p.className = 'bh-particle';
  const s = 2 + Math.random() * 2;
  const cols = sz >= PHASE_DARK ? COL3 : sz >= PHASE2 ? COL2 : COL1;
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
  ambParts.push(p);

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
    const idx = ambParts.indexOf(p);
    if (idx >= 0) ambParts.splice(idx, 1);
  };
}

/* ==== ユーティリティ ==== */
const _segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

function cpLength(str, offset) {
  if (_segmenter) {
    // Intl.Segmenter で正確なグラフェムクラスター長を取得
    const iter = _segmenter.segment(str.slice(offset))[Symbol.iterator]();
    const first = iter.next();
    if (!first.done) return first.value.segment.length;
  }
  const code = str.charCodeAt(offset);
  return (code >= 0xD800 && code <= 0xDBFF && offset + 1 < str.length) ? 2 : 1;
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
  // テキストノードを再帰走査し、可視テキストが残っているかチェック
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    // data-bh-erased span内のテキストは無視（既に透明化済み）
    if (node.parentElement && node.parentElement.hasAttribute('data-bh-erased')) continue;
    if (node.textContent.trim()) return true;
  }
  return false;
}
