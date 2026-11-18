/**
 * Generates the VegaAM 3.1 application, installer, taskbar, and tray icons.
 *
 * Uses analytic signed-distance-field (SDF) rendering of the researched V-star
 * geometry (`research/branding/vegaam-mark.svg` and `make-brand-assets.py`):
 *   - Rounded square field (`rx = 230/1024`, navy gradient `#090D1A -> #121A33`, inner rim)
 *   - Rounded V stroke `(292,292) -> (517,752) -> (732,292)` width `138/1024` (`#6D9BFF -> #4C7DFF`)
 *   - Four-point Vega star at `(773,240)` (`#C4A7FF -> #A371F7`) with bright core (`#E8EEFF`)
 *   - Monochrome tray mark (`16, 32, 64`) with high-contrast white glyph + dark outline
 *   - Multi-size Windows `.ico` (`16, 20, 24, 32, 40, 48, 64, 128, 256`)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

export function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Signed distance from point (px, py) to segment (ax, ay)-(bx, by). */
function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(px - ax, py - ay);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(px - bx, py - by);
  const b = c1 / c2;
  const pbx = ax + b * vx;
  const pby = ay + b * vy;
  return Math.hypot(px - pbx, py - pby);
}

/** Signed distance to a rounded box centered at (0.5, 0.5) with half-size (hx, hy) and corner radius r. */
function sdRoundedBox(px, py, hx, hy, r) {
  const qx = Math.abs(px - 0.5) - (hx - r);
  const qy = Math.abs(py - 0.5) - (hy - r);
  const outDist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inDist = Math.min(Math.max(qx, qy), 0);
  return outDist + inDist - r;
}

/**
 * Signed distance to the 4-point Vega star centered at (cx, cy) with outer arm `longR`
 * and inner waist `shortR` (8-vertex symmetric star polygon).
 */
function sdFourPointStar(px, py, cx, cy, longR, shortR) {
  // Fold into the first octant (dx >= dy >= 0) using 8-fold symmetry.
  let dx = Math.abs(px - cx);
  let dy = Math.abs(py - cy);
  if (dy > dx) {
    const tmp = dx;
    dx = dy;
    dy = tmp;
  }
  // In the first octant, the boundary segment runs from A=(longR, 0) to B=(shortR, shortR).
  const ax = longR;
  const ay = 0;
  const bx = shortR;
  const by = shortR;
  const ex = bx - ax;
  const ey = by - ay;
  const wx = dx - ax;
  const wy = dy - ay;
  const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
  const dist = Math.hypot(wx - ex * t, wy - ey * t);
  // Outward normal of A->B in first octant is (+ey, -ex) = (shortR, longR - shortR)
  const cross = wx * ey - wy * ex;
  return cross > 0 ? dist : -dist;
}

/** Alpha-blend foreground [r,g,b,a] (0..255) over dst [r,g,b,a] (0..255). */
function blendOver(dst, src, cov) {
  const sa = (src[3] / 255) * cov;
  if (sa <= 0) return dst;
  const da = dst[3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) return [0, 0, 0, 0];
  const r = (src[0] * sa + dst[0] * da * (1 - sa)) / outA;
  const g = (src[1] * sa + dst[1] * da * (1 - sa)) / outA;
  const b = (src[2] * sa + dst[2] * da * (1 - sa)) / outA;
  return [Math.round(r), Math.round(g), Math.round(b), Math.round(outA * 255)];
}

/**
 * Draw the full-colour VegaAM 3.1 V-star mark at `size x size`.
 */
export function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const aa = 1 / size;

  // Normalized geometry from `research/branding/vegaam-mark.svg` (1024 canvas):
  const leftX = 292 / 1024;
  const leftY = 292 / 1024;
  const midX = 517 / 1024;
  const midY = 752 / 1024;
  const rightX = 732 / 1024;
  const rightY = 292 / 1024;
  const vHalfWidth = (138 / 1024) * 0.5;

  const starCx = 773 / 1024;
  const starCy = 240 / 1024;
  const starLong = 108 / 1024;
  const starShort = 31 / 1024;
  const coreRadius = Math.max(12 / 1024, 0.9 / size);

  for (let y = 0; y < size; y += 1) {
    const ny = (y + 0.5) / size;
    for (let x = 0; x < size; x += 1) {
      const nx = (x + 0.5) / size;
      let pixel = [0, 0, 0, 0];

      // 1. Rounded square background (#090D1A -> #121A33)
      const bgDist = sdRoundedBox(nx, ny, 0.5, 0.5, 230 / 1024);
      const bgCov = clamp(0.5 - bgDist / aa, 0, 1);
      if (bgCov > 0) {
        const gt = clamp((nx * 0.25 + ny * 0.85), 0, 1);
        const bgColor = [
          Math.round(lerp(9, 18, gt)),
          Math.round(lerp(13, 26, gt)),
          Math.round(lerp(26, 51, gt)),
          255,
        ];
        pixel = blendOver(pixel, bgColor, bgCov);

        // Subtle inner rim
        const rimDist = Math.abs(sdRoundedBox(nx, ny, 0.5 - 12 / 1024, 0.5 - 12 / 1024, 218 / 1024)) - 3 / 1024;
        const rimCov = clamp(0.5 - rimDist / aa, 0, 1) * bgCov;
        if (rimCov > 0) {
          pixel = blendOver(pixel, [255, 255, 255, 28], rimCov);
        }
      }

      // 2. V monogram stroke (#6D9BFF -> #4C7DFF)
      const dLeft = distToSegment(nx, ny, leftX, leftY, midX, midY);
      const dRight = distToSegment(nx, ny, midX, midY, rightX, rightY);
      const vDist = Math.min(dLeft, dRight) - vHalfWidth;
      const vCov = clamp(0.5 - vDist / aa, 0, 1);
      if (vCov > 0) {
        const vt = clamp((ny - leftY) / (midY - leftY), 0, 1);
        const vColor = [
          Math.round(lerp(109, 76, vt)),
          Math.round(lerp(155, 125, vt)),
          255,
          255,
        ];
        pixel = blendOver(pixel, vColor, vCov);
      }

      // 3. Four-point Vega star (#C4A7FF -> #A371F7) + bright core (#E8EEFF)
      const sDist = sdFourPointStar(nx, ny, starCx, starCy, starLong, starShort);
      const sCov = clamp(0.5 - sDist / aa, 0, 1);
      if (sCov > 0) {
        const st = clamp((ny - (starCy - starLong)) / (2 * starLong), 0, 1);
        const starColor = [
          Math.round(lerp(196, 163, st)),
          Math.round(lerp(167, 113, st)),
          Math.round(lerp(255, 247, st)),
          255,
        ];
        pixel = blendOver(pixel, starColor, sCov);
      }

      const cDist = Math.hypot(nx - starCx, ny - starCy) - coreRadius;
      const cCov = clamp(0.5 - cDist / aa, 0, 1);
      if (cCov > 0) {
        pixel = blendOver(pixel, [232, 238, 255, 255], cCov);
      }

      const idx = (y * size + x) * 4;
      rgba[idx] = pixel[0];
      rgba[idx + 1] = pixel[1];
      rgba[idx + 2] = pixel[2];
      rgba[idx + 3] = pixel[3];
    }
  }

  return encodePng(size, size, rgba);
}

/**
 * Draw the monochrome tray V-star mark (`transparent` background, crisp white
 * V-star with a dark halo outline so it is legible on both light and dark taskbars).
 */
export function drawMonochrome(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const aa = 1 / size;

  const leftX = 250 / 1024;
  const leftY = 250 / 1024;
  const midX = 495 / 1024;
  const midY = 775 / 1024;
  const rightX = 720 / 1024;
  const rightY = 250 / 1024;
  const vHalfWidth = (150 / 1024) * 0.5;
  const outlinePad = Math.max(24 / 1024, 1.1 / size);

  const starCx = 775 / 1024;
  const starCy = 235 / 1024;
  const starLong = 125 / 1024;
  const starShort = 38 / 1024;

  const outlineColor = [8, 12, 24, 232];
  const fgColor = [255, 255, 255, 255];

  for (let y = 0; y < size; y += 1) {
    const ny = (y + 0.5) / size;
    for (let x = 0; x < size; x += 1) {
      const nx = (x + 0.5) / size;
      let pixel = [0, 0, 0, 0];

      const dLeft = distToSegment(nx, ny, leftX, leftY, midX, midY);
      const dRight = distToSegment(nx, ny, midX, midY, rightX, rightY);
      const vDist = Math.min(dLeft, dRight) - vHalfWidth;
      const sDist = sdFourPointStar(nx, ny, starCx, starCy, starLong, starShort);
      const shapeDist = Math.min(vDist, sDist);

      const outCov = clamp(0.5 - (shapeDist - outlinePad) / aa, 0, 1);
      if (outCov > 0) {
        pixel = blendOver(pixel, outlineColor, outCov);
      }

      const fgCov = clamp(0.5 - shapeDist / aa, 0, 1);
      if (fgCov > 0) {
        pixel = blendOver(pixel, fgColor, fgCov);
      }

      const idx = (y * size + x) * 4;
      rgba[idx] = pixel[0];
      rgba[idx + 1] = pixel[1];
      rgba[idx + 2] = pixel[2];
      rgba[idx + 3] = pixel[3];
    }
  }

  return encodePng(size, size, rgba);
}

/**
 * Draw a small monochrome taskbar overlay (playing / paused).
 */
export function drawOverlay(size, kind) {
  const rgba = Buffer.alloc(size * size * 4);
  const color = [255, 255, 255, 255];

  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const index = (y * size + x) * 4;
    rgba[index] = color[0];
    rgba[index + 1] = color[1];
    rgba[index + 2] = color[2];
    rgba[index + 3] = color[3];
  };

  if (kind === 'playing') {
    const left = size * 0.24;
    const right = size * 0.78;
    const mid = size * 0.5;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const t = (x - left) / (right - left);
        const halfHeight = size * 0.34 * (1 - Math.abs(t - 0.5) * 1.4);
        if (t < 0 || t > 1) continue;
        if (Math.abs(y - mid) <= halfHeight) put(x, y);
      }
    }
  } else {
    const barWidth = Math.max(1, Math.round(size * 0.16));
    const barHeight = Math.round(size * 0.5);
    const top = Math.round((size - barHeight) / 2);
    for (let y = top; y < top + barHeight; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const inFirst = x >= Math.round(size * 0.26) && x < Math.round(size * 0.26) + barWidth;
        const inSecond = x >= Math.round(size * 0.58) && x < Math.round(size * 0.58) + barWidth;
        if (inFirst || inSecond) put(x, y);
      }
    }
  }

  return encodePng(size, size, rgba);
}

/** Wrap PNG payloads in a Windows icon container. */
export function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

/** Wrap PNG payloads in a macOS icon container (`.icns`). */
export function encodeIcns(entries) {
  const chunks = [];
  for (const { type, data } of entries) {
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(data.length + 8, 4);
    chunks.push(header, data);
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

export const WINDOWS_ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

export function generateAllIcons() {
  const outDir = join(root, 'dist', 'icons');
  mkdirSync(outDir, { recursive: true });

  const buildDir = join(root, 'build');
  mkdirSync(buildDir, { recursive: true });

  // Cache rendered colour PNGs by size
  const allColourSizes = new Set([1024, 512, 256, 128, 64, 48, 40, 32, 24, 20, 16]);
  const generated = new Map();
  for (const size of allColourSizes) {
    generated.set(size, draw(size));
  }

  // Write runtime app icons
  writeFileSync(join(outDir, 'icon-512.png'), generated.get(512));
  console.log('[icons] wrote icon-512.png (512x512)');
  writeFileSync(join(outDir, 'icon-256.png'), generated.get(256));
  console.log('[icons] wrote icon-256.png (256x256)');

  // Write monochrome tray icons (16, 32, 64)
  const tray16 = drawMonochrome(16);
  const tray32 = drawMonochrome(32);
  const tray64 = drawMonochrome(64);
  writeFileSync(join(outDir, 'tray-16.png'), tray16);
  writeFileSync(join(outDir, 'tray.png'), tray32);
  writeFileSync(join(outDir, 'tray@2x.png'), tray64);
  console.log('[icons] wrote monochrome tray-16.png (16x16), tray.png (32x32), tray@2x.png (64x64)');

  // Write taskbar overlays (Windows)
  for (const kind of ['playing', 'paused']) {
    const file = `overlay-${kind}.png`;
    writeFileSync(join(outDir, file), drawOverlay(16, kind));
    console.log(`[icons] wrote ${file} (16x16)`);
  }

  // Write electron-builder installer icons (`build/icon.png` 1024x1024 & `build/icon.ico` with all 9 Windows sizes)
  writeFileSync(join(buildDir, 'icon.png'), generated.get(1024));
  const icoFrames = WINDOWS_ICO_SIZES.map((size) => ({
    size,
    data: generated.get(size),
  }));
  writeFileSync(join(buildDir, 'icon.ico'), encodeIco(icoFrames));
  console.log(
    `[icons] wrote build/icon.png (1024x1024) and build/icon.ico (${WINDOWS_ICO_SIZES.join(', ')} px)`,
  );

  // Write macOS `.icns` container
  const icnsVariants = [
    { type: 'icp4', size: 16 },
    { type: 'icp5', size: 32 },
    { type: 'icp6', size: 64 },
    { type: 'ic07', size: 128 },
    { type: 'ic08', size: 256 },
    { type: 'ic09', size: 512 },
    { type: 'ic10', size: 1024 },
    { type: 'ic11', size: 32 },
    { type: 'ic12', size: 64 },
    { type: 'ic13', size: 256 },
    { type: 'ic14', size: 512 },
  ];
  const icnsEntries = icnsVariants.map((variant) => ({
    type: variant.type,
    data: generated.get(variant.size),
  }));
  writeFileSync(join(buildDir, 'icon.icns'), encodeIcns(icnsEntries));
  console.log(`[icons] wrote build/icon.icns (${icnsEntries.length} variants)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  generateAllIcons();
}
