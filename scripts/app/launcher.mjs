#!/usr/bin/env node
/**
 * 「谜案剧本杀」桌面 App 启动器
 * ==================================================================
 * 双击「谜案剧本杀.vbs」→ 本文件启动 → 它会：
 *   1. 找一个空闲端口（默认从 5274 开始试），把自带的房间服务器拉起来；
 *   2. 用 Edge / Chrome 的「应用窗口」模式（--app，没有地址栏和标签栏）打开游戏，
 *      并使用本文件夹里的独立浏览器配置目录 → 这份数据只属于这个 App；
 *   3. **窗口一关，服务器跟着退出** —— 不会在后台偷偷留着进程。
 *
 * 参数（一般用不到）：
 *   --browser=none     只起服务器、不开窗口（自检 / 只想让别人连进来时用）
 *   --port=5280        指定端口
 *   --print-url        打印地址后退出（脚本自检用）
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const NODE = process.execPath
const SERVER = path.join(ROOT, 'server.mjs')
const LOGS = path.join(ROOT, 'logs')
const LOG_FILE = path.join(LOGS, 'server.log')
const LOCK = path.join(ROOT, 'app.lock')
const BROWSER_PROFILE = path.join(ROOT, 'profile')
const HOST = '127.0.0.1'
const START_PORT = 5274
const PORT_TRIES = 24

const argOf = (name) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : ''
}
const flag = (name) => process.argv.slice(2).includes(`--${name}`)

fs.mkdirSync(LOGS, { recursive: true })

/** 日志：写文件（App 没有控制台，出问题只能看这个） */
function log(...parts) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${parts.join(' ')}`
  try {
    fs.appendFileSync(LOG_FILE, line + '\r\n', 'utf8')
  } catch {
    /* 忽略 */
  }
  if (process.stdout.isTTY) console.log(line)
}

function fail(message) {
  log('✗ ' + message)
  try {
    fs.writeFileSync(path.join(LOGS, 'last-error.txt'), message, 'utf8')
  } catch {
    /* 忽略 */
  }
  console.error(message)
  // App 没有控制台，错误要用系统消息框弹出来，否则用户只会看到「双击没反应」
  if (!flag('no-dialog')) showDialog('谜案剧本杀 · 启动失败', message)
  process.exit(1)
}

/**
 * 弹一个原生消息框。
 * 用 PowerShell 的 -EncodedCommand（UTF-16LE + base64）传参，
 * 这样中文不会像命令行参数那样被控制台编码搞乱。
 */
function showDialog(title, text) {
  const ps =
    'Add-Type -AssemblyName System.Windows.Forms;' +
    `[void][System.Windows.Forms.MessageBox]::Show(${psLiteral(text)}, ${psLiteral(title)}, 'OK', 'Error')`
  const encoded = Buffer.from(ps, 'utf16le').toString('base64')
  try {
    spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
    }).unref()
  } catch {
    /* 忽略 */
  }
}

/** PowerShell 单引号字符串字面量（内部单引号翻倍） */
function psLiteral(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

/* ------------------------------------------------------------------ *
 * 端口：先探再占（探到能 listen 再交给服务器，减少撞车）
 * ------------------------------------------------------------------ */
function tryListen(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, HOST)
  })
}

async function pickPort(want) {
  if (want) {
    if (await tryListen(want)) return want
    fail(
      `端口 ${want} 被占用了（可能是另一个「谜案剧本杀」还在运行，或别的程序占用）。\n` +
        `关掉它再试，或者用命令行参数换个端口：\n  runtime\\node.exe launcher.mjs --port=5290`,
    )
  }
  for (let i = 0; i < PORT_TRIES; i += 1) {
    const port = START_PORT + i
    if (await tryListen(port)) return port
  }
  fail(`从 ${START_PORT} 起的 ${PORT_TRIES} 个端口都被占用了，先关掉一些程序再打开。`)
}

/* ------------------------------------------------------------------ *
 * 服务器
 * ------------------------------------------------------------------ */
function startServer(port) {
  const out = fs.openSync(LOG_FILE, 'a')
  const child = spawn(NODE, [SERVER, '--port', String(port)], {
    cwd: ROOT,
    stdio: ['ignore', out, out],
    windowsHide: true,
  })
  log(`▶ 房间服务器启动：http://${HOST}:${port}（PID ${child.pid}）`)
  return child
}

/** 等服务器真的能应答（最多 20 秒） */
async function waitHealthy(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${HOST}:${port}/api/health`, {
        signal: AbortSignal.timeout(1200),
      })
      if (res.ok) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

function killTree(child) {
  if (!child || child.killed) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } else {
      child.kill('SIGTERM')
    }
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------------------------------------------ *
 * 浏览器（应用窗口模式）
 * ------------------------------------------------------------------ */
function findBrowser() {
  const forced = process.env.MMAI_BROWSER || argOf('browser')
  if (forced === 'none') return null
  if (forced) return fs.existsSync(forced) ? forced : null

  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ]
  return candidates.find((p) => p && fs.existsSync(p)) || null
}

/**
 * 打开游戏窗口。
 *
 * ★ 这里有三个真踩过的坑，都是「双击后窗口出来了，但里面白屏/黑屏，玩不了」的原因：
 *
 *   ① 全新的 Edge 配置第一次启动会弹「我们在你的所有设备上同步浏览数据」
 *      （`edge://sync-confirmation-dialog`），把窗口占住 → 必须带 `--disable-sync`。
 *
 *   ② **不能用 spawn 直接拉浏览器**：`谜案剧本杀.vbs` 是用隐藏方式启动本进程的，
 *      Windows 把 `SW_HIDE` 一路继承给子进程，Chromium 会把「首次导航」推迟到
 *      窗口真正显示之后 —— 窗口建出来了，标题却一直是空的，页面永远白屏。
 *      改成：写一份临时 .vbs，让 wscript 用 `Run(..., 1, False)` 显式请求
 *      `SW_SHOWNORMAL` 去启动浏览器，就绕开了继承（见 openWindow 里的 helper）。
 *
 *   ③ 别试图预置 Local State / Preferences 去绕开首次运行：Edge 会认为配置是坏的，
 *      反而退回「新建标签页」，连 `--app` 都被忽略。
 */
function openWindow(browser, url) {
  const args = [
    `--app=${url}`,
    `--user-data-dir=${BROWSER_PROFILE}`,
    '--window-size=440,940',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--no-service-autorun',
    '--disable-features=Translate,msEdgeSidebarV2,msEdgeSyncPromo,EdgeSyncConsent,msEdgeIdentitySso,ImplicitSignIn',
  ]
  // 调试用：MMAI_DEBUG_PORT=9333 时开 CDP 端口，方便看这个窗口里到底渲染了什么
  if (process.env.MMAI_DEBUG_PORT) args.push(`--remote-debugging-port=${process.env.MMAI_DEBUG_PORT}`)

  const cmdline = [`"${browser}"`, ...args.map((a) => (a.includes(' ') ? `"${a}"` : a))].join(' ')
  const helper = path.join(LOGS, 'open-window.vbs')
  try {
    // ★ 必须写成 UTF-16LE + BOM：App 的路径里带中文（桌面\谜案剧本杀），
    //   用 ASCII/UTF-8 写会把中文写坏，Edge 会拿着一条坏路径去开配置目录。
    //   wscript 认得带 BOM 的 Unicode 脚本。
    const vbs = `Set sh = CreateObject("WScript.Shell")\r\nsh.Run "${cmdline.replace(/"/g, '""')}", 1, False\r\n`
    fs.writeFileSync(helper, '\ufeff' + vbs, 'utf16le')
  } catch (e) {
    log('写开窗脚本失败：' + e.message)
  }

  log('🪟 打开应用窗口：' + path.basename(browser))
  try {
    spawn('wscript.exe', [helper], { cwd: ROOT, stdio: 'ignore', windowsHide: true })
  } catch (e) {
    log('窗口打开失败：' + e.message)
    return 0
  }
  const pid = findBrowserPid(url, 20000)
  if (pid) focusWindowWhenReady(pid) // 窗口可能在别的窗口后面，拉到前面来
  return pid
}

/** 顺着命令行里唯一的 `--app=<url>` 找到浏览器进程号（找不到就是窗口没起来） */
function findBrowserPid(url, timeoutMs) {
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const ps =
        `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--app=${url}*' })[0].ProcessId`
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8',
        windowsHide: true,
      })
      const pid = parseInt((r.stdout || '').trim(), 10)
      if (Number.isFinite(pid) && pid > 0) return pid
    } catch {
      /* 下一轮再试 */
    }
    sleepSync(600)
  }
  log('没等到浏览器窗口进程（窗口可能没弹出来）')
  return 0
}

/** 等窗口关掉：只要那个进程还活着就一直等 */
async function waitWindowClosed(pid) {
  if (!pid) return
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  while (alive()) await new Promise((r) => setTimeout(r, 1200))
}

/**
 * 等窗口出现后把它「显示出来 + 置前」。
 *
 * ★ 为什么非要做这一步：`.vbs` 用 `Run(cmd, 0, False)`（隐藏窗口）启动，
 *   Windows 会把 STARTUPINFO 的 SW_HIDE 一路传给子进程，Edge 开出来的应用窗口
 *   就是**隐藏**状态（任务栏有、屏幕上看不见，进程里 MainWindowHandle 还是 0）。
 *   所以这里用 EnumWindows 按 PID 把它的顶层窗口找出来，ShowWindow(SW_SHOWNORMAL)。
 */
function focusWindowWhenReady(pid) {
  if (!pid) return
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MianFocus {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  public static bool Run(uint pid, int timeoutMs) {
    var end = DateTime.UtcNow.AddMilliseconds(timeoutMs);
    while (DateTime.UtcNow < end) {
      IntPtr best = IntPtr.Zero;
      EnumWindows((h, l) => {
        uint p; GetWindowThreadProcessId(h, out p);
        if (p != pid) return true;
        ShowWindow(h, 1); // SW_SHOWNORMAL：隐藏/最小化都能拉起来
        if (GetWindowTextLength(h) > 0) best = h;
        return true;
      }, IntPtr.Zero);
      if (best != IntPtr.Zero) { SetForegroundWindow(best); return true; }
      System.Threading.Thread.Sleep(300);
    }
    return false;
  }
}
"@
[void][MianFocus]::Run(${Number(pid)}, 25000)`
  const encoded = Buffer.from(ps, 'utf16le').toString('base64')
  try {
    spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
  } catch {
    /* 恢复失败也不影响使用：窗口在任务栏里，点一下就能出来 */
  }
}

/** 没有 Chromium 时的兜底：交给系统默认浏览器（会有地址栏，但至少能玩） */
function openDefaultBrowser(url) {
  log('没找到 Edge / Chrome，改用系统默认浏览器（会有地址栏）')
  const child = spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true })
  return child
}

/* ------------------------------------------------------------------ *
 * 单实例：已经有一份在跑，就只再开一个窗口
 * ------------------------------------------------------------------ */
function readLock() {
  try {
    const data = JSON.parse(fs.readFileSync(LOCK, 'utf8'))
    return typeof data?.port === 'number' ? data : null
  } catch {
    return null
  }
}

function writeLock(port, pid) {
  try {
    fs.writeFileSync(LOCK, JSON.stringify({ port, pid, at: Date.now() }), 'utf8')
  } catch {
    /* 忽略 */
  }
}

function clearLock() {
  try {
    fs.rmSync(LOCK, { force: true })
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function main() {
  log('—'.repeat(24) + ' 启动 ' + '—'.repeat(24))

  if (!fs.existsSync(SERVER)) fail('找不到 server.mjs，这个 App 包不完整，请重新解压。')

  // 已经在跑了？只补一个窗口，不重复起服务器
  const existing = readLock()
  if (existing && (await waitHealthy(existing.port, 2500))) {
    log(`已有一份在 ${existing.port} 端口运行，直接开窗口`)
    const browser = findBrowser()
    if (!browser) {
      log(`浏览器没找到，请手动打开：http://${HOST}:${existing.port}/`)
      return
    }
    const winPid = await openWindow(browser, `http://${HOST}:${existing.port}/`)
    await waitWindowClosed(winPid)
    return
  }
  clearLock()

  const port = await pickPort(Number(argOf('port')) || 0)
  const url = `http://${HOST}:${port}/`
  if (flag('print-url')) {
    console.log(url)
    return
  }

  const server = startServer(port)
  let exiting = false
  const shutdown = (code) => {
    if (exiting) return
    exiting = true
    killTree(server)
    clearLock()
    log('⏹ 服务器已关闭，App 退出')
    process.exit(code)
  }
  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
  process.on('exit', () => {
    killTree(server)
    clearLock()
  })

  server.on('exit', (code) => {
    if (exiting) return
    log(`服务器意外退出（代码 ${code}），详情见 logs/server.log`)
    try {
      fs.writeFileSync(
        path.join(LOGS, 'last-error.txt'),
        `房间服务器启动失败（代码 ${code}）。\n\n最可能的原因：端口 ${port} 被占用，或 runtime\\node.exe 无法运行。\n\n详情见 logs\\server.log`,
        'utf8',
      )
    } catch {
      /* 忽略 */
    }
    process.exit(1)
  })

  if (!(await waitHealthy(port))) {
    killTree(server)
    fail(`服务器没能在 20 秒内启动（端口 ${port}）。\n\n详情见 logs\\server.log`)
  }
  writeLock(port, server.pid)
  log(`✓ 已就绪：${url}`)

  const browser = findBrowser()
  if (!browser) {
    log(argOf('browser') === 'none' ? '（--browser=none：只服务，不开窗口）' : '没找到 Edge / Chrome')
    log(`请手动打开：${url}`)
    log('（这个窗口会一直服务，直到你关掉它或按 Ctrl+C）')
    return
  }

  const winPid = await openWindow(browser, url)
  if (!winPid) {
    killTree(server)
    clearLock()
    fail(`没能打开游戏窗口。\n\n你可以手动在浏览器里打开：${url}\n\n或者双击「谜案剧本杀.cmd」，它会把详细日志留在屏幕上。`)
  }
  await waitWindowClosed(winPid)
  shutdown(0)
}

main().catch((e) => fail('启动异常：' + (e?.stack || e?.message || String(e))))