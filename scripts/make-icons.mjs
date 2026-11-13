#!/usr/bin/env node
/**
 * 从一张设计稿生成全套图标（PWA + 桌面 App 的 .ico 素材）。
 * ==================================================================
 * 素材：`scripts/app/icon-source.png`（1080×1080，乌鸦 + 卷宗 + 「谜案剧本杀」）。
 * 换成新美术只要替换这张图，然后 `pnpm icons`。
 *
 * 为什么不用 sharp / jimp：项目一直是零图像依赖，而这里只需要
 * 「读 PNG → 裁剪 → 面积平均缩放 → 写 PNG」这一件事，node:zlib 就够。
 * 所以本脚本自带一个最小 PNG 编解码（8 位、非隔行，够用且好读）。
 *
 * 产出：
 *   public/icons/icon-512.png          桌面 / Android 主图标（含文字）
 *   public/icons/icon-192.png          同上小尺寸
 *   public/icons/icon-any-512.png      manifest 的 purpose=any
 *   public/icons/apple-touch-icon.png  iOS 主屏（不透明，圆角由系统加）
 *   public/icons/icon-maskable-512.png Android 自适应图标（只放图形，缩进安全圆）
 *   public/icons/favicon-64.png        标签页 / 书签
 *   public/favicon.png                 16-32px 的兜底
 *   scripts/app/icons/ico-*.png        打包桌面 App 时合成 .ico 用
 *
 * 用法：node scripts/make-icons.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'scripts', 'app', 'icon-source.png')

/* ------------------------------------------------------------------ *
 * 构图参数（对着设计稿量的，换图时要重新估）
 * ------------------------------------------------------------------ */
/** 主图标：居中裁 700×700 —— 圆角方块（乌鸦 + 卷宗 + 文字）几乎填满 */
const MAIN_CROP = { x: 190, y: 190, w: 700, h: 700 }
/**
 * 纯图形：把白色卷宗（含乌鸦）裁出来，给 maskable 和 16/32px 的小图标用 ——
 * 那两个地方放不下「谜案剧本杀」这行字，塞进方块背景反而像图中图。
 * 参数是照源图量的：白纸 x∈[415,700]、y∈[280,625]（竖长的一张），
 * 但乌鸦翅膀往左伸出去一截，所以左边多留 35px：355×355，中心 557/452。
 */
const ART_CROP = { x: 352, y: 247, w: 410, h: 410 }
/** 深墨底：和 index.html 的 theme-color / body 背景同色（备用底色） */
const INK = [11, 13, 20]

/* ------------------------------------------------------------------ *
 * 最小 PNG 解码（8 位、非隔行；浏览器导出的都是这种）
 * ------------------------------------------------------------------ */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件')
  let pos = 8
  let width = 0
  let height = 0
  let depth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += len + 12
  }
  if (depth !== 8) throw new Error(`只支持 8 位色深（当前 ${depth}）`)
  if (interlace !== 0) throw new Error('不支持隔行 PNG，请另存为普通 PNG')
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(stride * height)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = out.subarray(y * stride, (y + 1) * stride)
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[i] = v & 0xff
    }
    prev = cur
  }
  return { width, height, channels, data: out }
}

/** 统一成 RGBA */
function toRgba(img) {
  const { width, height, channels, data } = img
  if (channels === 4) return data
  const out = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    const j = i * channels
    const o = i * 4
    if (channels === 1) {
      out[o] = out[o + 1] = out[o + 2] = data[j]
      out[o + 3] = 255
    } else if (channels === 2) {
      out[o] = out[o + 1] = out[o + 2] = data[j]
      out[o + 3] = data[j + 1]
    } else {
      out[o] = data[j]
      out[o + 1] = data[j + 1]
      out[o + 2] = data[j + 2]
      out[o + 3] = 255
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 面积平均缩放（缩小不会出现锯齿/摩尔纹）
 * ------------------------------------------------------------------ */
function resize(rgba, sw, sh, crop, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4)
  const scaleX = crop.w / dw
  const scaleY = crop.h / dh
  for (let dy = 0; dy < dh; dy += 1) {
    const sy0 = crop.y + dy * scaleY
    const sy1 = sy0 + scaleY
    const y0 = Math.max(crop.y, Math.floor(sy0))
    const y1 = Math.min(crop.y + crop.h, Math.ceil(sy1))
    for (let dx = 0; dx < dw; dx += 1) {
      const sx0 = crop.x + dx * scaleX
      const sx1 = sx0 + scaleX
      const x0 = Math.max(crop.x, Math.floor(sx0))
      const x1 = Math.min(crop.x + crop.w, Math.ceil(sx1))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let total = 0
      for (let y = y0; y < y1; y += 1) {
        const wy = Math.min(y + 1, sy1) - Math.max(y, sy0)
        if (wy <= 0) continue
        for (let x = x0; x < x1; x += 1) {
          const wx = Math.min(x + 1, sx1) - Math.max(x, sx0)
          if (wx <= 0) continue
          const wgt = wx * wy
          const i = (y * sw + x) * 4
          r += rgba[i] * wgt
          g += rgba[i + 1] * wgt
          b += rgba[i + 2] * wgt
          a += rgba[i + 3] * wgt
          total += wgt
        }
      }
      const o = (dy * dw + dx) * 4
      out[o] = Math.round(r / total)
      out[o + 1] = Math.round(g / total)
      out[o + 2] = Math.round(b / total)
      out[o + 3] = Math.round(a / total)
    }
  }
  return out
}

/**
 * 取裁剪区四条边的平均色。
 * maskable 要把图形缩到一个方块里、再补满四周；补底用「内容边缘的颜色」，
 * 而不是另配一个纯色，否则圆形遮罩里会出现一圈明显的方框接缝。
 */
function edgeColor(rgba, sw, crop) {
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  const add = (x, y) => {
    const i = (y * sw + x) * 4
    r += rgba[i]
    g += rgba[i + 1]
    b += rgba[i + 2]
    n += 1
  }
  const inset = 2
  for (let x = crop.x + inset; x < crop.x + crop.w - inset; x += 3) {
    add(x, crop.y + inset)
    add(x, crop.y + crop.h - 1 - inset)
  }
  for (let y = crop.y + inset; y < crop.y + crop.h - inset; y += 3) {
    add(crop.x + inset, y)
    add(crop.x + crop.w - 1 - inset, y)
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
}

/** 把一块 RGBA 贴到画布中央（不透明背景 + 简单 alpha 混合）；feather > 0 时边缘渐隐 */
function paste(sw, sh, dst, src, size, offsetX, offsetY, feather = 0) {
  for (let y = 0; y < size; y += 1) {
    const ty = y + offsetY
    if (ty < 0 || ty >= sh) continue
    for (let x = 0; x < size; x += 1) {
      const tx = x + offsetX
      if (tx < 0 || tx >= sw) continue
      const si = (y * size + x) * 4
      const ti = (ty * sw + tx) * 4
      let alpha = src[si + 3] / 255
      if (feather > 0) {
        const edge = Math.min(x, y, size - 1 - x, size - 1 - y)
        alpha *= Math.min(1, edge / feather)
      }
      if (alpha <= 0) continue
      dst[ti] = Math.round(src[si] * alpha + dst[ti] * (1 - alpha))
      dst[ti + 1] = Math.round(src[si + 1] * alpha + dst[ti + 1] * (1 - alpha))
      dst[ti + 2] = Math.round(src[si + 2] * alpha + dst[ti + 2] * (1 - alpha))
      dst[ti + 3] = 255
    }
  }
}

/* ------------------------------------------------------------------ *
 * 最小 PNG 编码（RGBA8 / filter 0）
 * ------------------------------------------------------------------ */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(w, h, rgba) {
  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
if (!existsSync(SRC)) {
  console.error(`找不到素材：${SRC}`)
  console.error('把设计稿存成 1080×1080 的 PNG 放到这个位置，再重跑。')
  process.exit(1)
}

const src = decodePng(readFileSync(SRC))
const rgba = toRgba(src)
if (src.width !== 1080 || src.height !== 1080) {
  console.warn(`⚠️  素材是 ${src.width}×${src.height}，下面按 1080×1080 量的构图参数可能需要重调`)
}

const written = []
function out(relPath, w, h, data) {
  const full = path.join(ROOT, relPath)
  mkdirSync(path.dirname(full), { recursive: true })
  const png = encodePng(w, h, data)
  writeFileSync(full, png)
  written.push([relPath, w, h, png.length])
}

/** 主图标：直接裁方块那一块 */
function mainIcon(size) {
  return resize(rgba, src.width, src.height, MAIN_CROP, size, size)
}

/**
 * 纯图形：乌鸦 + 卷宗，缩进安全区。
 * 四周先铺「内容边缘的平均色」，再把内容的边缘做一小段羽化 ——
 * 否则圆形遮罩里会出现一圈方方正正的接缝。
 */
function artIcon(size, contentRatio = 1) {
  const bg = edgeColor(rgba, src.width, ART_CROP)
  const canvas = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i += 1) {
    canvas[i * 4] = bg[0]
    canvas[i * 4 + 1] = bg[1]
    canvas[i * 4 + 2] = bg[2]
    canvas[i * 4 + 3] = 255
  }
  const inner = Math.round(size * contentRatio)
  const art = resize(rgba, src.width, src.height, ART_CROP, inner, inner)
  const off = Math.round((size - inner) / 2)
  const feather = Math.max(2, Math.round(inner * 0.06))
  paste(size, size, canvas, art, inner, off, off, feather)
  return canvas
}

out('public/icons/icon-512.png', 512, 512, mainIcon(512))
out('public/icons/icon-192.png', 192, 192, mainIcon(192))
out('public/icons/icon-any-512.png', 512, 512, mainIcon(512))
out('public/icons/apple-touch-icon.png', 180, 180, mainIcon(180))
// Android 自适应图标只显示中心圆形区域（直径约 80% = 409px）：
// 内容缩到 73%（374px），白纸的四个角落在圆内；四周铺内容边缘色 + 边缘羽化，
// 圆形遮罩里既看不到方框接缝，也切不到纸角
out('public/icons/icon-maskable-512.png', 512, 512, artIcon(512, 0.73))
out('public/icons/favicon-64.png', 64, 64, artIcon(64, 0.94))
out('public/favicon.png', 32, 32, artIcon(32, 0.94))

for (const size of [256, 128, 48, 32, 16]) {
  out(`scripts/app/icons/ico-${size}.png`, size, size, mainIcon(size))
}

console.log('生成图标：')
for (const [p, w, h, bytes] of written) {
  console.log(`  ${p.padEnd(38)} ${String(w).padStart(3)}×${String(h).padEnd(4)} ${(bytes / 1024).toFixed(1)} KB`)
}
console.log(`共 ${written.length} 个文件。`)
