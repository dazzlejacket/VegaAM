import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

// @ts-expect-error mjs build script import
import { draw, drawMonochrome, generateAllIcons, WINDOWS_ICO_SIZES } from '../scripts/make-icons.mjs';
// @ts-expect-error mjs build script import
import { parseIcoDirectory, parsePngHeader, REQUIRED_ICO_SIZES, verifyAllIcons } from '../scripts/verify-icons.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function decodeRawPngPixels(pngBuf: Buffer): { width: number; height: number; rgba: Buffer } {
  const hdr = parsePngHeader(pngBuf);
  let offset = 8;
  const idatChunks: Buffer[] = [];
  while (offset < pngBuf.length) {
    const len = pngBuf.readUInt32BE(offset);
    const type = pngBuf.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') {
      idatChunks.push(pngBuf.subarray(offset + 8, offset + 8 + len));
    }
    offset += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idatChunks));
  const rgba = Buffer.alloc(hdr.width * hdr.height * 4);
  for (let y = 0; y < hdr.height; y += 1) {
    const rowStart = y * (hdr.width * 4 + 1);
    raw.copy(rgba, y * hdr.width * 4, rowStart + 1, rowStart + 1 + hdr.width * 4);
  }
  return { width: hdr.width, height: hdr.height, rgba };
}

function getPixel(
  img: { width: number; height: number; rgba: Buffer },
  nx: number,
  ny: number,
): [number, number, number, number] {
  const x = Math.min(img.width - 1, Math.max(0, Math.floor(nx * img.width)));
  const y = Math.min(img.height - 1, Math.max(0, Math.floor(ny * img.height)));
  const idx = (y * img.width + x) * 4;
  return [img.rgba[idx]!, img.rgba[idx + 1]!, img.rgba[idx + 2]!, img.rgba[idx + 3]!];
}

describe('VegaAM 3.1 V-star icon pipeline & Windows identity', () => {
  it('generates and verifies all required icon assets across Windows, macOS, and Linux', () => {
    generateAllIcons();
    const res = verifyAllIcons(root);
    expect(res.ok).toBe(true);
    expect(res.icoSizes).toEqual(REQUIRED_ICO_SIZES);
    expect(WINDOWS_ICO_SIZES).toEqual([16, 20, 24, 32, 40, 48, 64, 128, 256]);
  });

  it('embeds all 9 Windows ICO sizes (16, 20, 24, 32, 40, 48, 64, 128, 256) in build/icon.ico', () => {
    const icoBuf = readFileSync(join(root, 'build', 'icon.ico'));
    const parsed = parseIcoDirectory(icoBuf);
    expect(parsed.count).toBe(9);
    const widths = parsed.frames.map((f: { width: number }) => f.width);
    expect(widths).toEqual([16, 20, 24, 32, 40, 48, 64, 128, 256]);
    for (const frame of parsed.frames) {
      expect(frame.bpp).toBe(32);
      expect(frame.pngWidth).toBe(frame.width);
      expect(frame.pngHeight).toBe(frame.height);
    }
  });

  it('draws the V-star mark with transparent rounded corners, navy field, blue V stroke, and violet star', () => {
    const png256 = draw(256) as Buffer;
    const decoded = decodeRawPngPixels(png256);
    expect(decoded.width).toBe(256);
    expect(decoded.height).toBe(256);

    // Extreme corner (1%, 1%) must be transparent outside the rounded square
    const corner = getPixel(decoded, 0.01, 0.01);
    expect(corner[3]).toBe(0);

    // Deep navy background field at (18%, 50%)
    const bg = getPixel(decoded, 0.18, 0.5);
    expect(bg[3]).toBe(255);
    expect(bg[2]).toBeGreaterThan(bg[0]); // blue channel > red channel
    expect(bg[2]).toBeLessThan(80); // dark navy

    // Electric-blue V apex at (517/1024, 740/1024)
    const vApex = getPixel(decoded, 517 / 1024, 740 / 1024);
    expect(vApex[3]).toBe(255);
    expect(vApex[2]).toBeGreaterThan(220); // bright blue

    // Violet 4-point star arm at (773/1024, 195/1024)
    const starArm = getPixel(decoded, 773 / 1024, 195 / 1024);
    expect(starArm[3]).toBe(255);
    expect(starArm[0]).toBeGreaterThan(140); // violet has strong R + B
    expect(starArm[2]).toBeGreaterThan(220);
  });

  it('draws the monochrome tray icon with transparent field and high-contrast white V-star', () => {
    const tray32 = drawMonochrome(32) as Buffer;
    const decoded = decodeRawPngPixels(tray32);
    expect(decoded.width).toBe(32);
    expect(decoded.height).toBe(32);

    // Top-left corner is transparent
    const corner = getPixel(decoded, 0.05, 0.05);
    expect(corner[3]).toBe(0);

    // V bottom vertex at (495/1024, 760/1024) is bright white
    const vBottom = getPixel(decoded, 495 / 1024, 760 / 1024);
    expect(vBottom[0]).toBeGreaterThan(230);
    expect(vBottom[1]).toBeGreaterThan(230);
    expect(vBottom[2]).toBeGreaterThan(230);
    expect(vBottom[3]).toBeGreaterThan(230);
  });

  it('configures electron-builder.yml and build/installer.nsh with app.vegaam.desktop and shortcut cleanup', () => {
    const eb = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
    expect(eb).toContain('appId: app.vegaam.desktop');
    expect(eb).toContain('productName: VegaAM');
    expect(eb).toContain('installerIcon: build/icon.ico');
    expect(eb).toContain('uninstallerIcon: build/icon.ico');
    expect(eb).toContain('include: build/installer.nsh');

    const nshPath = join(root, 'build', 'installer.nsh');
    expect(existsSync(nshPath)).toBe(true);
    const nsh = readFileSync(nshPath, 'utf8');
    expect(nsh).toContain('!macro customInstall');
    expect(nsh).toContain('SiriusXM Desktop.lnk');
    expect(nsh).toContain('app.vegaam.desktop');
    expect(nsh).toContain('SHChangeNotify');
    expect(nsh).toContain('ie4uinit.exe');
    // The development shortcut that squats the VegaAM AUMID with the stock
    // Electron nucleus must be removed by the installer as well.
    expect(nsh).toContain('Electron.lnk');
  });
});
