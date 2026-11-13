/**
 * 模型返回容错解析
 * ------------------------------------------------------------------
 * 现实里的模型输出远不止「标准 JSON」这一种：
 *   - 外面包一层 ```json 围栏
 *   - 前后带「好的，这是您的剧本：」之类的寒暄
 *   - 尾随逗号、全角引号、控制字符
 *   - 输出被 max_tokens 截断，最后半个括号没了
 *   - 干脆就不返回 JSON，直接写正文
 *
 * 这里只做一件事：从任意文本里尽量捞出一个可用的对象。
 * 拿不到就抛 `ModelJsonError`，由调用方决定是重写还是按纯文本处理。
 *
 * 注意：本模块**不依赖** `response_format`。之所以不用 OpenAI 的
 * `json_object` 模式，是因为部分兼容端点会在 prompt 里找不到 "json"
 * 时直接回 400（`Prompt must contain the word 'json' ...`），
 * 而我们要允许主题、正文是任意文本。
 */

export class ModelJsonError extends Error {
  /** 原始返回，便于在界面上排查 */
  readonly raw: string
  constructor(message: string, raw = '') {
    super(message)
    this.name = 'ModelJsonError'
    this.raw = raw
  }
}

/** 零宽字符与控制字符，模型偶尔会吐出来，JSON.parse 会直接报错 */
function cleanInvisible(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

/** 剥掉 ```json ... ``` 围栏（围栏可能在开头、也可能在中间） */
export function stripCodeFence(text: string): string {
  const source = cleanInvisible(String(text ?? '')).trim()
  if (!source) return ''
  const whole = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```\s*$/.exec(source)
  if (whole) return whole[1].trim()
  const any = /```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)```/.exec(source)
  if (any && /[{[][\s\S]*[}\]]/.test(any[1])) return any[1].trim()
  return source
}

/** 找第一个 { 或 [，然后按括号配平截出完整片段（字符串内的括号不算） */
export function findBalancedJson(text: string): string | null {
  const source = cleanInvisible(text)
  const brace = source.indexOf('{')
  const bracket = source.indexOf('[')
  const start =
    brace < 0 ? bracket : bracket < 0 ? brace : Math.min(brace, bracket)
  if (start < 0) return null

  const open = source[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  // 没闭合：先把剩下的交出去，让 repair 补括号
  return source.slice(start)
}

/** 抢救式修补：尾逗号、未闭合字符串、缺失的右括号 */
export function repairJson(text: string): string {
  let value = cleanInvisible(text).trim()
  // 中文逗号当前后是括号时，基本可以确定是尾逗号
  value = value.replace(/[，,]\s*([}\]])/g, '$1')

  const stack: string[] = []
  let inString = false
  let escaped = false

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') stack.pop()
  }

  let output = value
  if (inString) output += '"'
  while (stack.length > 0) output += stack.pop()
  return output
}

/** 把全角引号当 JSON 分隔符用的模型也不少 */
function swapSmartQuotes(text: string): string {
  return text.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'")
}

/**
 * 从任意文本里解析出对象。失败抛 `ModelJsonError`。
 * 依次尝试：原文 → 去围栏 → 截取配平片段 → 修补 → 全角引号替换。
 */
export function parseModelJson<T = unknown>(text: string): T {
  const source = cleanInvisible(String(text ?? '')).trim()
  if (!source) throw new ModelJsonError('模型返回内容为空', '')

  const candidates: string[] = []
  const push = (value: string | null) => {
    if (value && !candidates.includes(value)) candidates.push(value)
  }

  const unfenced = stripCodeFence(source)
  push(source)
  push(unfenced)
  push(findBalancedJson(unfenced))
  push(findBalancedJson(source))

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T
    } catch {
      /* 继续试下一种 */
    }
  }

  for (const candidate of [...candidates]) {
    const repaired = repairJson(candidate)
    try {
      return JSON.parse(repaired) as T
    } catch {
      /* 继续 */
    }
    try {
      return JSON.parse(swapSmartQuotes(repaired)) as T
    } catch {
      /* 继续 */
    }
  }

  throw new ModelJsonError('模型返回里找不到可解析的 JSON', source)
}
