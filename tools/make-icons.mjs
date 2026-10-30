/**
 * Generates the PNG icons used by the browser extension.
 * Pure Node — no image libraries required.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'extension', 'icons');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolor + alpha
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a + (b - a) * t;

function roundedRectInside(x, y, inset, radius) {
  const min = inset;
  const max = 1 - inset;
  if (x < min || x > max || y < min || y > max) return false;
  const r = radius;
  const cx = x < min + r ? min + r : x > max - r ? max - r : x;
  const cy = y < min + r ? min + r : y > max - r ? max - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function sample(nx, ny) {
  // Background plate
  if (!roundedRectInside(nx, ny, 0.045, 0.24)) return [0, 0, 0, 0];
  const t = Math.min(1, Math.max(0, (nx * 0.35 + ny * 0.65 - 0.1) / 0.8));
  const r = mix(255, 255, t);
  const g = mix(206, 106, t);
  const b = mix(74, 0, t);

  const ink = [26, 18, 4, 255];
  // Arrow shaft
  if (nx >= 0.452 && nx <= 0.548 && ny >= 0.22 && ny <= 0.575) return ink;
  // Arrow head
  if (ny >= 0.5 && ny <= 0.7) {
    const progress = (ny - 0.5) / 0.2;
    const half = 0.17 * (1 - progress);
    if (Math.abs(nx - 0.5) <= half) return ink;
  }
  // Tray
  if (ny >= 0.765 && ny <= 0.815 && nx >= 0.27 && nx <= 0.73) return ink;
  return [r, g, b, 255];
}

async function makeIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const ss = 3;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const nx = (x + (sx + 0.5) / ss) / size;
          const ny = (y + (sy + 0.5) / ss) / size;
          const [sr, sg, sb, sa] = sample(nx, ny);
          r += sr * sa;
          g += sg * sa;
          b += sb * sa;
          a += sa;
        }
      }
      const count = ss * ss;
      const alpha = a / count / 255;
      const offset = (y * size + x) * 4;
      if (alpha <= 0.003) continue;
      rgba[offset] = Math.round(r / (a / 255 || 1));
      rgba[offset + 1] = Math.round(g / (a / 255 || 1));
      rgba[offset + 2] = Math.round(b / (a / 255 || 1));
      rgba[offset + 3] = Math.round(alpha * 255);
    }
  }
  const png = encodePng(size, size, rgba);
  await fs.writeFile(path.join(OUT, `icon-${size}.png`), png);
  return png.length;
}

await fs.mkdir(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const bytes = await makeIcon(size);
  console.log(`icon-${size}.png  ${bytes} bytes`);
}
