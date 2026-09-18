/**
 * Generate JARVIS app icons as real PNGs (no image libraries) — a glowing teal
 * orb on near-black, plus a maskable variant with safe padding. Pure per-pixel
 * math encoded with Node's zlib. Run: node test/make-icons.mjs
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'public', 'icons');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function png(size, { padding = 0 } = {}) {
  const cx = size / 2;
  const cy = size / 2;
  const R = (size / 2) * (1 - padding);
  const raw = Buffer.alloc(size * (size * 4 + 1));

  const mix = (a, b, t) => a + (b - a) * t;
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter type 0
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy) / R;

      // Background: near-black with a faint teal vignette.
      let r = 5, g = 9, b = 14;
      const vign = Math.max(0, 1 - d * 0.7);
      r += 8 * vign; g += 20 * vign; b += 28 * vign;

      // Glow halo.
      if (d < 1.15) {
        const glow = Math.max(0, 1 - Math.abs(d - 0.55) / 0.9);
        r = mix(r, 52, glow * 0.5);
        g = mix(g, 231, glow * 0.5);
        b = mix(b, 228, glow * 0.5);
      }
      // Ring.
      const ring = Math.exp(-((d - 0.82) ** 2) / 0.002);
      r = mix(r, 120, ring); g = mix(g, 245, ring); b = mix(b, 240, ring);
      // Core sphere with a highlight.
      if (d < 0.62) {
        const core = 1 - d / 0.62;
        r = mix(r, 90, core); g = mix(g, 240, core); b = mix(b, 235, core);
        const hx = x - (cx - R * 0.16);
        const hy = y - (cy - R * 0.18);
        const hd = Math.sqrt(hx * hx + hy * hy) / (R * 0.4);
        if (hd < 1) {
          const hl = (1 - hd) ** 2;
          r = mix(r, 240, hl); g = mix(g, 255, hl); b = mix(b, 255, hl);
        }
      }

      const o = rowStart + 1 + x * 4;
      raw[o] = Math.min(255, Math.round(r));
      raw[o + 1] = Math.min(255, Math.round(g));
      raw[o + 2] = Math.min(255, Math.round(b));
      raw[o + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon-192.png'), png(192));
fs.writeFileSync(path.join(OUT, 'icon-512.png'), png(512));
fs.writeFileSync(path.join(OUT, 'icon-maskable-512.png'), png(512, { padding: 0.14 }));
console.log('wrote icon-192.png, icon-512.png, icon-maskable-512.png');
