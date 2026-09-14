#!/usr/bin/env node
/**
 * 生成 images/icon.png —— 不依赖任何图形库，直接用 zlib 手写 PNG。
 *
 *   node scripts/make-icon.mjs
 *
 * 产出 256×256（Marketplace 要求 ≥128×128，256 兼顾 HiDPI），
 * 形状是「圆角蓝底 + 白色银行卡」，在 128px 下依然清晰。
 * 用 4 倍超采样做抗锯齿后降采样。
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 256;
const SS = 4; // 超采样倍数
const BIG = SIZE * SS;

const BRAND = [0x4d, 0x6b, 0xfe]; // DeepSeek 蓝
const WHITE = [0xff, 0xff, 0xff];

/** 圆角矩形命中测试。 */
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 返回该超采样点的颜色，未命中任何形状则返回 null（透明）。 */
function sample(x, y) {
  const s = (v) => v * SS;

  // 底色：整块圆角方形
  if (inRoundedRect(x, y, s(8), s(8), s(248), s(248), s(56))) {
    // 卡片
    if (inRoundedRect(x, y, s(46), s(82), s(210), s(174), s(18))) {
      // 磁条
      if (y >= s(100) && y <= s(118) && x >= s(46) && x <= s(210)) return BRAND;
      // 芯片
      if (inRoundedRect(x, y, s(66), s(132), s(96), s(152), s(5))) return BRAND;
      return WHITE;
    }
    return BRAND;
  }
  return null;
}

// 超采样渲染后降采样
const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let hits = 0;

    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const color = sample(px * SS + sx, py * SS + sy);
        if (color === null) continue;
        r += color[0];
        g += color[1];
        b += color[2];
        hits++;
      }
    }

    const offset = (py * SIZE + px) * 4;
    if (hits === 0) continue; // 全透明

    const total = SS * SS;
    pixels[offset] = Math.round(r / hits);
    pixels[offset + 1] = Math.round(g / hits);
    pixels[offset + 2] = Math.round(b / hits);
    // 覆盖率决定 alpha，边缘因此获得平滑过渡
    pixels[offset + 3] = Math.round((hits / total) * 255);
  }
}

// ---- 最小 PNG 编码器 ----
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

// 每条扫描线前置一个 filter 字节（0 = None）
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  const from = y * SIZE * 4;
  const to = y * (SIZE * 4 + 1);
  raw[to] = 0;
  pixels.copy(raw, to + 1, from, from + SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "images", "icon.png");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`已生成 ${out}（${SIZE}×${SIZE}，${png.length} 字节）`);
