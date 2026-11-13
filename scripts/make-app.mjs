#!/usr/bin/env node
/**
 * 把整个游戏打包成一个「双击就能玩」的桌面 App 文件夹。
 * ==================================================================
 * 产出（默认 `%USERPROFILE%\Desktop\谜案剧本杀`）：
 *
 *   谜案剧本杀/
 *   ├── 谜案剧本杀.vbs            ← 双击这个（无黑窗）
 *   ├── 谜案剧本杀.cmd            ← 同一件事，带控制台，出问题时用它看输出
 *   ├── launcher.mjs        # 选端口 / 起服务器 / 开独立窗口 / 关窗即退
 *   ├── server.mjs          # 房间服务器单文件（ws 已内联，零依赖）
 *   ├── package.json        # 只为让服务器把「本文件夹」认作根目录
 *   ├── dist/               # 前端（含 PWA 的 manifest / sw / 图标）
 *   ├── runtime/node.exe    # 自带 Node，目标机器不用装环境
 *   ├── 图标.ico
 *   └── 使用说明.txt
 *
 * 用法：
 *   node scripts/make-app.mjs                  # 打包到 桌面\谜案剧本杀
 *   node scripts/make-app.mjs --out=D:\ghost   # 换个位置
 *   node scripts/make-app.mjs --no-shortcut    # 不建桌面快捷方式
 *
 * 注意：重复打包**不会**动 `谜案剧本杀/server/data/`（玩家的档案与战绩）和 `谜案剧本杀/profile/`。
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argOf = (name) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : ''
}
const hasFlag = (name) => process.argv.slice(2).includes(`--${name}`)

const OUT = path.resolve(argOf('out') || path.join(os.homedir(), 'Desktop', '谜案剧本杀'))
const ICON_SRC = path.join(ROOT, 'scripts', 'app', 'icons')
const NODE_BIN = process.execPath

const say = (...a) => console.log(...a)
const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function copyTree(from, to) {
  ensureDir(to)
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dst)
    else fs.copyFileSync(src, dst)
  }
}

/* ------------------------------------------------------------------ *
 * 1. 前端构建（dist/）
 * ------------------------------------------------------------------ */
function buildFrontend() {
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  say('① 构建前端 …')
  const res = spawnSync(NODE_BIN, [vite, 'build', '--logLevel', 'warn'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  if (res.status !== 0) {
    say(res.stdout || '', res.stderr || '')
    throw new Error('前端构建失败')
  }
  const entry = fs.readdirSync(path.join(ROOT, 'dist', 'assets')).filter((f) => /^index-.*\.js$/.test(f))
  say(`   ✓ dist/ 就绪（入口 ${entry[0] || '?'}）`)
}

/* ------------------------------------------------------------------ *
 * 2. 服务器单文件（ws 内联，零依赖）
 * ------------------------------------------------------------------ */
async function buildServer() {
  say('② 打包服务器（ws 内联）…')
  const banner = [
    '#!/usr/bin/env node',
    "import { createRequire } from 'node:module';",
    'const require = createRequire(import.meta.url); // 内联的 ws 是 CJS，需要真的 require',
  ]
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'server', 'src', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: path.join(ROOT, 'server', 'dist', 'server.mjs'),
    alias: { '@': path.join(ROOT, 'src') },
    // ws 的两个可选原生加速模块，不存在也不影响
    external: ['bufferutil', 'utf-8-validate'],
    banner: { js: banner.join('\n') },
    logLevel: 'warning',
  })
  const size = fs.statSync(path.join(ROOT, 'server', 'dist', 'server.mjs')).size
  say(`   ✓ server.mjs ${kb(size)}`)
}

/* ------------------------------------------------------------------ *
 * 3. 图标 .ico（PNG 直接塞进 ICO 容器，Vista 以上都认）
 * ------------------------------------------------------------------ */
function buildIco(target) {
  const sizes = [16, 32, 48, 128, 256]
  const pngs = []
  for (const s of sizes) {
    const p = path.join(ICON_SRC, `ico-${s}.png`)
    if (!fs.existsSync(p)) throw new Error(`缺少图标 ${p}，先跑：pnpm icons（scripts/make-icons.mjs）`)
    pngs.push({ size: s, data: fs.readFileSync(p) })
  }

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(pngs.length, 4)

  const entries = []
  let offset = 6 + pngs.length * 16
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0) // 0 表示 256
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2) // palette
    e.writeUInt8(0, 3) // reserved
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(e)
  }

  fs.writeFileSync(target, Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]))
  say(`   ✓ 图标.ico（${sizes.join('/')}）`)
}

/* ------------------------------------------------------------------ *
 * 4. 应用目录里的那些小文件
 * ------------------------------------------------------------------ */

/**
 * ★ 这个 .vbs 必须是**纯 ASCII**：Windows 的 wscript 读 UTF-8 无 BOM 的脚本时
 *   按 ANSI 解码，中文注释会把后面几行搞坏，表现是「双击没反应」。
 *   所以提示文字全部交给 launcher（它用 PowerShell 弹消息框，能正常显示中文）。
 */
const VBS = `' Mian - AI Murder Mystery. Double-click to launch (no console window).
Option Explicit
Dim fso, sh, root
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
' 0 = hidden window, False = do not wait (closing the game window stops the server)
sh.Run """" & root & "\\runtime\\node.exe"" """ & root & "\\launcher.mjs""", 0, False
`

const CMD = `@echo off
rem 谜案剧本杀 —— 带控制台的启动方式（排查问题用这个）
chcp 65001 >nul
cd /d "%~dp0"
title 谜案剧本杀
echo 正在启动，游戏窗口马上打开……
echo （关掉游戏窗口 = 退出；这里的窗口可以最小化，别关）
echo.
"%~dp0runtime\\node.exe" "%~dp0launcher.mjs"
if errorlevel 1 (
  echo.
  echo 启动失败，详情见 logs\\server.log
  pause
)
`

const README_TXT = `谜案剧本杀 —— 桌面版
=====================================

【怎么玩】
  双击「谜案剧本杀.vbs」。
  会弹出一个没有地址栏的独立窗口，那就是游戏。
  想和朋友连同一局：在游戏里点「创建联机房间」，把 5 位房号念给他们。
  朋友跟你在同一个 Wi-Fi 下，让他们用浏览器打开：
      http://<这台电脑的局域网IP>:5274/
  （IP 可以在 logs\\server.log 里看到「手机同 Wi-Fi 打开」那一行；
    也可以在命令行里敲 ipconfig 查 IPv4 地址。）

【怎么退出】
  直接关掉游戏窗口。服务器会跟着一起退出，不会留在后台。

【窗口标题为什么显示 127.0.0.1_/】
  正常现象。Edge 的「独立窗口」在没被正式安装成 PWA 之前，用地址当窗口标题。
  功能与全屏体验不受影响（没有地址栏、没有标签栏）。

【数据放在哪】
  谜案剧本杀\\server\\data\\players.db      玩家档案、昵称头像、战绩、对局历史
  谜案剧本杀\\profile\\                       这个 App 专属的浏览器配置（登录态、本地缓存）
  谜案剧本杀\\logs\\server.log                服务器日志（连不上、起不来时看这个）
  删掉整个文件夹 = 全部清空，没有任何残留（不写注册表、不装服务）。

【打不开怎么办】
  1. 先双击「谜案剧本杀.cmd」，它会留下日志并停住，把报错内容发出来；
  2. 报「端口被占用」：说明已经有一份在跑，或者别的程序占了 5274。
     关掉旧窗口，或用命令行换端口：
         runtime\\node.exe launcher.mjs --port=5290
  3. 报「找不到 Edge / Chrome」：装一个 Edge（大多数 Windows 自带）即可。
  4. 双击后什么都没看见：看任务栏是不是已经多了一个窗口（点一下就会出来）；
     偶尔系统会把它启动在后台，等两三秒再点任务栏那个图标。

【这个文件夹能拷给别人吗】
  能。整个文件夹拷过去（包括 runtime\\node.exe），对方的电脑不用装 Node、
  不用装任何东西，双击「谜案剧本杀.vbs」就能玩。
  想分享战绩：连 server\\data\\players.db 一起拷。

【想装到手机桌面】
  手机浏览器打开同一个地址，按「添加到主屏幕」，从图标进就是全屏。
  注意手机要能访问到这台电脑（同一个 Wi-Fi），且要开麦的话需要 https，
  见项目 README 的「装到手机桌面」一节。
`

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

/** 用 PowerShell 建桌面快捷方式（-EncodedCommand 传中文不会乱码） */
function makeShortcut(appDir) {
  const linkPath = path.join(os.homedir(), 'Desktop', '谜案剧本杀.lnk')
  if (fs.existsSync(linkPath) && hasFlag('no-shortcut')) return null
  const ps = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$lnk = $ws.CreateShortcut(${psQuote(linkPath)})`,
    `$lnk.TargetPath = ${psQuote(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'))}`,
    `$lnk.Arguments = ${psQuote('"' + path.join(appDir, '谜案剧本杀.vbs') + '"')}`,
    `$lnk.WorkingDirectory = ${psQuote(appDir)}`,
    `$lnk.IconLocation = ${psQuote(path.join(appDir, '图标.ico') + ',0')}`,
    `$lnk.Description = '谜案剧本杀'`,
    '$lnk.Save()',
  ].join('\n')
  const encoded = Buffer.from(ps, 'utf16le').toString('base64')
  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
  })
  if (res.status !== 0) return { ok: false, err: (res.stderr || '').trim() }
  return { ok: true, path: linkPath }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function main() {
  say(`打包目标：${OUT}\n`)

  buildFrontend()
  await buildServer()

  say('③ 组装 App 目录 …')
  ensureDir(OUT)
  ensureDir(path.join(OUT, 'dist'))
  ensureDir(path.join(OUT, 'runtime'))

  // 前端：先清掉旧的 assets，避免几个月前的 chunk 越堆越多
  fs.rmSync(path.join(OUT, 'dist'), { recursive: true, force: true })
  copyTree(path.join(ROOT, 'dist'), path.join(OUT, 'dist'))

  // 服务器 + 启动器
  fs.copyFileSync(path.join(ROOT, 'server', 'dist', 'server.mjs'), path.join(OUT, 'server.mjs'))
  fs.copyFileSync(path.join(ROOT, 'scripts', 'app', 'launcher.mjs'), path.join(OUT, 'launcher.mjs'))
  fs.writeFileSync(
    path.join(OUT, 'package.json'),
    JSON.stringify({ name: 'mian-app', private: true, version: '1.0.0', type: 'module' }, null, 2) + '\n',
    'utf8',
  )

  // 自带 Node 运行时（目标机器不用装环境）
  const nodeDst = path.join(OUT, 'runtime', 'node.exe')
  const nodeSize = fs.statSync(NODE_BIN).size
  fs.copyFileSync(NODE_BIN, nodeDst)
  say(`   ✓ runtime/node.exe ${mb(nodeSize)}`)

  say('④ 图标与启动脚本 …')
  buildIco(path.join(OUT, '图标.ico'))
  fs.writeFileSync(path.join(OUT, '谜案剧本杀.vbs'), VBS, 'utf8')
  fs.writeFileSync(path.join(OUT, '谜案剧本杀.cmd'), CMD.replace(/\n/g, '\r\n'), 'utf8')
  fs.writeFileSync(path.join(OUT, '使用说明.txt'), '\ufeff' + README_TXT.replace(/\n/g, '\r\n'), 'utf8')

  // 桌面快捷方式
  let sc = null
  if (!hasFlag('no-shortcut')) {
    sc = makeShortcut(OUT)
    say(sc.ok ? `   ✓ 桌面快捷方式：${sc.path}` : `   ! 快捷方式创建失败：${sc.err}`)
  }

  // 磁盘占用（不算运行后生成的 logs/profile/data）
  let bytes = 0
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (['logs', 'profile', 'data'].includes(e.name)) continue
        walk(p)
      } else bytes += fs.statSync(p).size
    }
  }
  walk(OUT)

  say(`\n✅ 完成：${OUT}`)
  say(`   体积 ${mb(bytes)}（其中 runtime/node.exe ${mb(nodeSize)}）`)
  say('   双击「谜案剧本杀.vbs」即可；或点桌面上的「谜案」图标。')
}

main().catch((e) => {
  console.error('\n✗ 打包失败：', e?.message || e)
  process.exit(1)
})