/**
 * PWA：装到手机桌面 / 全屏启动（免 App 商店）
 * ------------------------------------------------------------------
 * 三件事：
 *   1. 注册 Service Worker（`public/sw.js`）——装了它浏览器才认为「可以安装」，
 *      顺便让已安装的 App 断网也能打开外壳；
 *   2. 抓住 `beforeinstallprompt`，把它存起来，等用户点我们自己的按钮再弹系统安装框
 *      （浏览器默认的弹窗时机很烦人，关掉过就再也不显示了）；
 *   3. 告诉界面「现在能不能装、该怎么装」：
 *      - ready      ：有系统安装框，点按钮就能装；
 *      - manual     ：没有弹窗（iOS / 部分安卓 / 已经装过别的入口），给手动步骤；
 *      - installed  ：已经在桌面独立窗口里跑；
 *      - insecure   ：这个地址不能装（浏览器只在 https 或 localhost 下允许）。
 *
 * ★ 关于 http 局域网地址：`http://10.x.x.x:5274` 不是安全上下文，
 *   浏览器**不会**注册 SW、也不会给安装入口。想装成 App 就用 https
 *   （隧道，或 `pnpm cert` + `pnpm server:tls` 的自签证书）；iOS 的
 *   「添加到主屏幕」不受此限，加了就以独立窗口打开。
 */

import { computed, ref } from 'vue'
import { STORAGE_KEYS, loadJSON, saveJSON } from './storage'

/** Chromium 的安装事件（TS 标准库里没有） */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms?: string[]
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform?: string }>
}

/** 界面要区分的情况 */
export type InstallState = 'installed' | 'ready' | 'manual' | 'insecure' | 'unsupported'

const deferred = ref<BeforeInstallPromptEvent | null>(null)
const installed = ref(false)
const swReady = ref(false)
const hintHidden = ref(loadJSON<boolean>(STORAGE_KEYS.installHintHidden, false))

/** 是否已经以「独立窗口」运行（装了桌面图标、或 PWA 启动） */
export function isStandalone(): boolean {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true
  } catch {
    /* ignore */
  }
  // iOS 的老属性：加到主屏幕后启动时是 true
  return (navigator as unknown as { standalone?: boolean }).standalone === true
}

export function isIos(): boolean {
  const ua = navigator.userAgent || ''
  if (/iPad|iPhone|iPod/.test(ua)) return true
  // iPadOS 13+ 的 UA 假装是 Mac，用触摸点数认出来
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
}

export function isAndroid(): boolean {
  return /Android/i.test(navigator.userAgent || '')
}

/** 当前这个地址能不能装（安全上下文 + 有 SW） */
export function canInstallHere(): boolean {
  return window.isSecureContext === true && 'serviceWorker' in navigator
}

const state = computed<InstallState>(() => {
  if (installed.value || isStandalone()) return 'installed'
  if (deferred.value) return 'ready'
  if (!canInstallHere()) return 'insecure'
  if (isIos() || isAndroid()) return 'manual'
  return 'unsupported'
})

/** 注册 SW + 监听安装事件；在 main.ts 启动时调用一次 */
export function initPwa(): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    // 拦下来自己控制时机
    event.preventDefault()
    deferred.value = event as BeforeInstallPromptEvent
  })

  window.addEventListener('appinstalled', () => {
    installed.value = true
    deferred.value = null
    hintHidden.value = true
    saveJSON(STORAGE_KEYS.installHintHidden, true)
  })

  // 已经装了（独立窗口）就别再提示
  if (isStandalone()) installed.value = true

  if (!import.meta.env.PROD) return // 开发服务器没有 sw.js，注册只会刷错误
  if (!canInstallHere()) return

  const register = () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        swReady.value = true
        // 有更新就立刻拿下来，下次打开就是新版本
        reg.update().catch(() => {})
      })
      .catch(() => {
        /* 地址不可信 / 服务器没托管 dist 时会失败，单机玩法不受影响 */
      })
  }
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}

/** 点「添加到桌面」时调用 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferred.value
  if (!event) return 'unavailable'
  try {
    await event.prompt()
    const choice = await event.userChoice
    deferred.value = null
    if (choice.outcome === 'accepted') {
      installed.value = true
      return 'accepted'
    }
    return 'dismissed'
  } catch {
    deferred.value = null
    return 'unavailable'
  }
}

/** 「以后再说」：首页横幅不再出现 */
export function hideInstallHint(): void {
  hintHidden.value = true
  saveJSON(STORAGE_KEYS.installHintHidden, true)
}

export function usePwa() {
  return {
    state,
    /** 首页横幅：能装 / 需要手动装，且用户没说过「以后再说」 */
    showHint: computed(
      () => !hintHidden.value && (state.value === 'ready' || state.value === 'manual'),
    ),
    installed,
    swReady,
    hintHidden,
    isIos,
    isAndroid,
    isStandalone,
    canInstallHere,
    promptInstall,
    hideInstallHint,
  }
}