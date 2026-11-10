/**
 * 可选 HTTPS / WSS 支持（证书装配）
 * ==========================================================================
 * 为什么需要它：实时语音要用 `getUserMedia`，而浏览器**只在安全上下文**
 * （https / localhost）下才给麦克风权限。手机用 `http://10.x.x.x:5274` 打开时，
 * 页面根本拿不到麦 —— 所以想让手机开麦，服务器必须以 https/wss 对外服务。
 *
 * 设计原则：
 *   1. **默认行为不变**：不传任何证书参数就还是 http，老用法完全不受影响。
 *   2. **失败一律软着陆**：文件不存在 / 口令错 / 证书损坏 → 只打中文警告，
 *      然后照常以 http 启动。宁可"能玩但没语音"，也不要服务器起不来。
 *   3. 这一层只做「解析参数 → 读文件 → 变成 createServer 能吃的选项」，
 *      不碰监听、不碰房间逻辑，方便单测。
 *
 * Windows 上不需要 openssl，用 PowerShell 就能生成自签证书：
 *   $c = New-SelfSignedCertificate -DnsName 192.168.1.5,localhost -CertStoreLocation Cert:\CurrentUser\My
 *   $pw = ConvertTo-SecureString -String 'mmai1234' -Force -AsPlainText
 *   Export-PfxCertificate -Cert $c -FilePath .\mmai.pfx -Password $pw
 *   node server/dist/server.mjs --tls-pfx .\mmai.pfx --tls-pass mmai1234
 */

import fs from 'node:fs'
import type { ServerOptions } from 'node:https'

/** 证书来源（命令行 / 环境变量 / 直接传给 startServer 都长这样） */
export interface TlsArgs {
  /** PFX（PKCS#12）文件路径，Windows 生成最省事 */
  pfx?: string
  /** PFX 口令 */
  pass?: string
  /** PEM 证书链路径（与 key 成对） */
  cert?: string
  /** PEM 私钥路径（与 cert 成对） */
  key?: string
}

/** 读进内存的证书材料 */
export interface TlsMaterial {
  kind: 'cert' | 'pfx'
  cert?: Buffer
  key?: Buffer
  pfx?: Buffer
  passphrase?: string
}

export type TlsLoad = { ok: true; material: TlsMaterial } | { ok: false; reason: string }

function clean(value: string | undefined | null): string | undefined {
  const text = String(value ?? '').trim()
  return text ? text : undefined
}

/**
 * 解析 `--tls-*` 参数与环境变量兜底（`MMAI_TLS_*`）。
 * 命令行优先于环境变量；两边都空 → 视为「没配证书」。
 */
export function parseTlsArgs(
  argv: string[],
  env: Record<string, string | undefined> = {},
): TlsArgs {
  const read = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1]
    const prefixed = argv.find((a) => a.startsWith(`${name}=`))
    return prefixed ? prefixed.slice(name.length + 1) : undefined
  }
  return {
    pfx: clean(read('--tls-pfx')) ?? clean(env.MMAI_TLS_PFX),
    pass: clean(read('--tls-pass')) ?? clean(env.MMAI_TLS_PASS),
    cert: clean(read('--tls-cert')) ?? clean(env.MMAI_TLS_CERT),
    key: clean(read('--tls-key')) ?? clean(env.MMAI_TLS_KEY),
  }
}

/** 有没有要求启用 TLS（只要给了 pfx 或 cert/key 就算） */
export function tlsRequested(args: TlsArgs | null | undefined): boolean {
  if (!args) return false
  return !!(clean(args.pfx) || clean(args.cert) || clean(args.key))
}

function readPem(file: string, label: string): { ok: true; data: Buffer } | { ok: false; reason: string } {
  try {
    const data = fs.readFileSync(file)
    if (data.length === 0) return { ok: false, reason: `${label}文件是空的：${file}` }
    return { ok: true, data }
  } catch (e) {
    return { ok: false, reason: `读不到${label}文件「${file}」：${String((e as Error).message ?? e)}` }
  }
}

/**
 * 读取证书文件。**cert/key 优先，其次 pfx**（与需求一致）。
 * 任何一步失败都返回中文原因，由调用方软着陆回 http，绝不抛异常。
 */
export function loadTlsMaterial(args: TlsArgs): TlsLoad {
  const cert = clean(args.cert)
  const key = clean(args.key)
  const pfx = clean(args.pfx)

  if (cert || key) {
    if (!cert || !key) {
      return { ok: false, reason: '--tls-cert 与 --tls-key（MMAI_TLS_CERT / MMAI_TLS_KEY）必须成对提供' }
    }
    const c = readPem(cert, '证书')
    if (!c.ok) return c
    const k = readPem(key, '私钥')
    if (!k.ok) return k
    return { ok: true, material: { kind: 'cert', cert: c.data, key: k.data } }
  }

  if (pfx) {
    const p = readPem(pfx, 'PFX 证书')
    if (!p.ok) return p
    return { ok: true, material: { kind: 'pfx', pfx: p.data, passphrase: clean(args.pass) } }
  }

  return { ok: false, reason: '没有配置证书（--tls-pfx 或 --tls-cert/--tls-key）' }
}

/** 材料 → https.createServer / tls.createSecureContext 的选项 */
export function materialToServerOptions(material: TlsMaterial): ServerOptions {
  if (material.kind === 'cert') return { cert: material.cert, key: material.key }
  return { pfx: material.pfx, passphrase: material.passphrase }
}

/** TLS 启用失败时的醒目中文警告（不含证书内容，可以安全打印） */
export function tlsFallbackWarning(reason: string): string[] {
  return [
    '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
    `⚠️  无法启用 HTTPS / WSS：${reason}`,
    '    已退回 http 继续启动（房间服务照常可用）。',
    '    但手机浏览器只在安全上下文（https / localhost）下放行麦克风：',
    '    手机将无法开麦，只能打字。要开麦请配证书或走隧道（见 README）。',
    '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
  ]
}