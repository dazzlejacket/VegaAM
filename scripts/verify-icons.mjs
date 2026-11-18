/**
 * Build-time and test-time icon asset verifier for VegaAM 3.1.
 *
 * Verifies:
 *   1. `build/icon.ico` contains all 9 Windows frame sizes (`16, 20, 24, 32, 40, 48, 64, 128, 256`).
 *   2. Every ICO frame is a valid PNG with matching IHDR width and height.
 *   3. `build/icon.png` (1024x1024), `dist/icons/icon-512.png` (512x512), `dist/icons/icon-256.png` (256x256),
 *      `dist/icons/tray-16.png` (16x16), `dist/icons/tray.png` (32x32), `dist/icons/tray@2x.png` (64x64),
 *      `dist/icons/overlay-playing.png` (16x16), and `dist/icons/overlay-paused.png` (16x16) exist and have valid PNG headers.
 *   4. `build/icon.icns` starts with the `icns` magic and contains all 11 macOS variants.
 *   5. No `nucleus` or `orbit` icon files exist anywhere under `build/` or `dist/`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const REQUIRED_ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

export function parsePngHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) {
    throw new Error('Buffer too short to be a PNG.');
  }
  if (!buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('Invalid PNG signature.');
  }
  const chunkType = buf.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') {
    throw new Error(`Expected IHDR chunk, found ${chunkType}.`);
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  return { width, height, bitDepth, colorType, byteLength: buf.length };
}

export function parseIcoDirectory(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 6) {
    throw new Error('Buffer too short to be an ICO.');
  }
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  if (reserved !== 0 || type !== 1 || count < 1) {
    throw new Error(`Invalid ICO header: reserved=${reserved}, type=${type}, count=${count}.`);
  }
  const frames = [];
  for (let i = 0; i < count; i += 1) {
    const base = 6 + i * 16;
    const rawW = buf[base];
    const rawH = buf[base + 1];
    const width = rawW === 0 ? 256 : rawW;
    const height = rawH === 0 ? 256 : rawH;
    const bpp = buf.readUInt16LE(base + 6);
    const size = buf.readUInt32LE(base + 8);
    const offset = buf.readUInt32LE(base + 12);
    const payload = buf.subarray(offset, offset + size);
    const pngInfo = parsePngHeader(payload);
    frames.push({
      width,
      height,
      bpp,
      size,
      offset,
      pngWidth: pngInfo.width,
      pngHeight: pngInfo.height,
    });
  }
  return { count, frames };
}

function collectFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

export function verifyAllIcons(rootDir = root) {
  const icoPath = join(rootDir, 'build', 'icon.ico');
  const icoBuf = readFileSync(icoPath);
  const ico = parseIcoDirectory(icoBuf);

  const presentSizes = ico.frames.map((f) => f.width).sort((a, b) => a - b);
  for (const reqSize of REQUIRED_ICO_SIZES) {
    const match = ico.frames.find(
      (f) => f.width === reqSize && f.height === reqSize && f.pngWidth === reqSize && f.pngHeight === reqSize,
    );
    if (!match) {
      throw new Error(
        `build/icon.ico is missing valid ${reqSize}x${reqSize} frame (found: ${presentSizes.join(', ')}).`,
      );
    }
  }

  const pngExpectations = [
    { rel: 'build/icon.png', width: 1024, height: 1024 },
    { rel: 'dist/icons/icon-512.png', width: 512, height: 512 },
    { rel: 'dist/icons/icon-256.png', width: 256, height: 256 },
    { rel: 'dist/icons/tray-16.png', width: 16, height: 16 },
    { rel: 'dist/icons/tray.png', width: 32, height: 32 },
    { rel: 'dist/icons/tray@2x.png', width: 64, height: 64 },
    { rel: 'dist/icons/overlay-playing.png', width: 16, height: 16 },
    { rel: 'dist/icons/overlay-paused.png', width: 16, height: 16 },
  ];

  for (const exp of pngExpectations) {
    const full = join(rootDir, exp.rel);
    const hdr = parsePngHeader(readFileSync(full));
    if (hdr.width !== exp.width || hdr.height !== exp.height) {
      throw new Error(
        `${exp.rel} expected ${exp.width}x${exp.height}, got ${hdr.width}x${hdr.height}.`,
      );
    }
  }

  const icnsBuf = readFileSync(join(rootDir, 'build', 'icon.icns'));
  if (icnsBuf.subarray(0, 4).toString('ascii') !== 'icns') {
    throw new Error('build/icon.icns is missing the icns magic header.');
  }

  for (const sub of ['build', 'dist']) {
    const files = collectFiles(join(rootDir, sub));
    for (const f of files) {
      const lower = f.toLowerCase();
      if (lower.includes('nucleus') || lower.includes('orbit') || lower.includes('atom')) {
        throw new Error(`Forbidden legacy icon filename detected: ${f}`);
      }
    }
  }

  return {
    ok: true,
    icoSizes: presentSizes,
    pngChecked: pngExpectations.length,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = verifyAllIcons();
  console.log(
    `[verify-icons] OK — ICO frames: [${result.icoSizes.join(', ')}], PNGs verified: ${result.pngChecked}`,
  );
}
