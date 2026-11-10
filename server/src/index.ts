/**
 * 房间服务器入口
 * ------------------------------------------------------------------
 * 用法：
 *   node server/dist/server.mjs                          # 监听 0.0.0.0:5274（http）
 *   node server/dist/server.mjs --port 6000              # 自定义端口
 *   node server/dist/server.mjs --data-dir ./my-data     # 玩家档案放哪（默认 server/data）
 *   node server/dist/server.mjs --tls-pfx mmai.pfx --tls-pass 口令
 *   node server/dist/server.mjs --tls-cert cert.pem --tls-key key.pem
 *
 * 启动后同一个端口既提供前端网页（dist/），也提供 WebSocket 房间服务，
 * 手机只要一个地址 `http://<电脑局域网 IP>:5274/` 就能开局。
 *
 * 想让**手机开麦**就必须走 HTTPS/WSS（浏览器只在安全上下文放行麦克风）：
 * 配证书的参数见 tls.ts 顶部注释（Windows 用 PowerShell 就能生成 PFX）。
 * 证书配坏不会导致起不来 —— 只会打一条警告并退回 http。
 */

import { NET_PORT } from '@/services/net/protocol'
import { startServer } from './app'
import { parseTlsArgs, tlsRequested } from './tls'

function readArg(name: string): string | undefined {
  const args = process.argv.slice(2)
  const i = args.indexOf(name)
  if (i >= 0 && i + 1 < args.length) return args[i + 1]
  const prefixed = args.find((a) => a.startsWith(`${name}=`))
  if (prefixed) return prefixed.slice(name.length + 1)
  return undefined
}

async function main(): Promise<void> {
  const rawPort = readArg('--port') ?? process.env.PORT ?? String(NET_PORT)
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`端口不合法：${rawPort}（请传 --port 1-65535）`)
    process.exit(1)
  }
  // 证书参数：命令行优先，环境变量（MMAI_TLS_*）兜底；都没配就还是 http
  const tls = parseTlsArgs(process.argv.slice(2), process.env)
  if (tlsRequested(tls)) {
    const source = tls.cert || tls.key ? 'PEM 证书/私钥' : 'PFX 证书'
    console.log(`检测到 TLS 配置（${source}），尝试以 https/wss 启动……`)
  }
  // 玩家档案目录：命令行优先，其次环境变量，最后交给 startServer 用默认值
  const dataDir = readArg('--data-dir') ?? process.env.MMAI_DATA_DIR ?? process.env.DATA_DIR
  const handle = await startServer(dataDir ? { port, tls, dataDir } : { port, tls })
  const shutdown = async (signal: string) => {
    console.log(`收到 ${signal}，正在关闭房间服务器……`)
    await handle.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((e) => {
  console.error('房间服务器启动失败：', e)
  process.exit(1)
})