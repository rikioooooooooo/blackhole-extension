'use strict';

const fs = require('fs');
const path = require('path');

const sizes = [16, 48, 128];
const outDir = path.join(__dirname, 'icons');

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

function generateSVG(size) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.45;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#8B5CF6" stop-opacity="0"/>
      <stop offset="50%" stop-color="#8B5CF6" stop-opacity="0.4"/>
      <stop offset="80%" stop-color="#8B5CF6" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#8B5CF6" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="ring" cx="50%" cy="50%" r="50%">
      <stop offset="40%" stop-color="#8B5CF6" stop-opacity="0"/>
      <stop offset="60%" stop-color="#8B5CF6"/>
      <stop offset="75%" stop-color="#3B82F6"/>
      <stop offset="100%" stop-color="#8B5CF6" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="core" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#1E1432"/>
      <stop offset="100%" stop-color="#000000"/>
    </radialGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="transparent"/>
  <circle cx="${cx}" cy="${cy}" r="${r * 1.1}" fill="url(#glow)"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#ring)"/>
  <circle cx="${cx}" cy="${cy}" r="${r * 0.5}" fill="url(#core)"/>
</svg>`;
}

// SVGをPNGに変換（sharp使用を試み、なければSVGファイルのみ出力）
async function main() {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    // sharpがなければ、SVGをそのまま使うためのHTMLコンバーターを生成
    for (const size of sizes) {
      const svg = generateSVG(size);
      const svgPath = path.join(outDir, `icon${size}.svg`);
      fs.writeFileSync(svgPath, svg);
    }
    // SVGからPNGへの変換HTMLを生成
    const html = `<!DOCTYPE html>
<html><head><title>Icon Generator</title></head>
<body>
<h2>アイコンを右クリック→「名前を付けて画像を保存」でPNG保存</h2>
${sizes.map(s => {
  const svg = generateSVG(s);
  const b64 = Buffer.from(svg).toString('base64');
  return `<div>
    <p>icon${s}.png (${s}x${s})</p>
    <canvas id="c${s}" width="${s}" height="${s}"></canvas>
    <script>
      const img = new Image();
      img.onload = () => {
        const c = document.getElementById('c${s}');
        c.getContext('2d').drawImage(img, 0, 0);
      };
      img.src = 'data:image/svg+xml;base64,${b64}';
    </script>
  </div>`;
}).join('\n')}
<script>
// 自動ダウンロード
window.onload = () => {
  ${sizes.map(s => {
    const svg = generateSVG(s);
    const b64 = Buffer.from(svg).toString('base64');
    return `setTimeout(() => {
      const c = document.getElementById('c${s}');
      const a = document.createElement('a');
      a.download = 'icon${s}.png';
      a.href = c.toDataURL('image/png');
      a.click();
    }, ${s === 16 ? 500 : s === 48 ? 1000 : 1500});`;
  }).join('\n  ')}
};
</script>
</body></html>`;
    fs.writeFileSync(path.join(__dirname, 'generate-icons.html'), html);

    // Node.jsのみでPNG生成（最低限の1x1透過PNG + SVGオーバーレイ）
    // 代わりにインラインPNG生成
    generateMinimalPNGs();
    return;
  }

  // sharpがある場合
  for (const size of sizes) {
    const svg = generateSVG(size);
    await sharp(Buffer.from(svg)).png().toFile(path.join(outDir, `icon${size}.png`));
  }
}

function generateMinimalPNGs() {
  // Node.js単体でSVGをPNGに変換はできないので、
  // 最小限のアイコンをプログラマティックに生成する（非圧縮PNG）
  for (const size of sizes) {
    const png = createSimplePNG(size);
    fs.writeFileSync(path.join(outDir, `icon${size}.png`), png);
  }
}

// 非圧縮PNGを手動生成
function createSimplePNG(size) {
  const zlib = require('zlib');

  // RGBA画像データを生成
  const pixels = Buffer.alloc(size * size * 4, 0);
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size * 0.45;
  const innerR = outerR * 0.5;
  const glowR = outerR * 1.1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;

      if (dist <= innerR) {
        // 中心の黒
        pixels[idx] = 15;
        pixels[idx + 1] = 10;
        pixels[idx + 2] = 25;
        pixels[idx + 3] = 255;
      } else if (dist <= outerR) {
        // 降着円盤（紫〜青グラデーション）
        const t = (dist - innerR) / (outerR - innerR);
        const angle = Math.atan2(dy, dx);
        const hue = ((angle / (Math.PI * 2)) + 1) % 1;
        // 紫→青→紫
        const r = Math.floor(139 * (1 - t * 0.3) * (0.7 + 0.3 * Math.sin(angle * 2)));
        const g = Math.floor(92 * (1 - t) + 130 * t * Math.max(0, Math.sin(angle)));
        const b = Math.floor(246 * (0.8 + 0.2 * Math.cos(angle)));
        const a = Math.floor(255 * (1 - t * 0.5));
        pixels[idx] = Math.min(255, r);
        pixels[idx + 1] = Math.min(255, g);
        pixels[idx + 2] = Math.min(255, b);
        pixels[idx + 3] = a;
      } else if (dist <= glowR) {
        // 外側のグロー
        const t = (dist - outerR) / (glowR - outerR);
        const a = Math.floor(100 * (1 - t));
        pixels[idx] = 139;
        pixels[idx + 1] = 92;
        pixels[idx + 2] = 246;
        pixels[idx + 3] = a;
      }
      // else: 透明（初期値0）
    }
  }

  // PNG構築
  // フィルタバイト（各行先頭に0 = None）を追加
  const rawData = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rawData[y * (size * 4 + 1)] = 0; // filter byte
    pixels.copy(rawData, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const compressed = zlib.deflateSync(rawData);

  // PNGファイル構築
  const chunks = [];

  // シグネチャ
  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  chunks.push(pngChunk('IHDR', ihdr));

  // IDAT
  chunks.push(pngChunk('IDAT', compressed));

  // IEND
  chunks.push(pngChunk('IEND', Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeB, data]);

  // CRC32
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < crcData.length; i++) {
    crc ^= crcData[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  crc ^= 0xFFFFFFFF;
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crc >>> 0, 0);

  return Buffer.concat([len, typeB, data, crcB]);
}

main().catch(console.error);
