import type { Gender, ScriptPackage } from '@/types/script'

/**
 * 角色姓名轮换
 * ------------------------------------------------------------------
 * 内置离线模板只有两套，角色姓名原本写死在模板里，导致每局都是
 * 同一批人。这里在剧本下发前给所有角色换上一套全新的姓名：
 *   1. 同局内绝不重名；
 *   2. 近期（默认最近 30 次分配）用过的姓名不再出现，避免连着几局撞脸；
 *   3. 姓名替换作用于**整份剧本包**（正文、时间线、私有线索、真相、
 *      公共线索、搜证地点），避免出现「角色叫新名字、证词里还是旧名字」。
 *
 * 本模块同时被浏览器与房间服务器使用，所以不依赖 DOM；localStorage
 * 可用时顺手持久化，服务端则在进程内存里轮换。
 */

/**
 * 姓名池：**按性别分开**。
 * ------------------------------------------------------------------
 * 角色自带性别（见 types/script.ts 的 Gender），头像也按性别渲染；
 * 若从混排池里随机取名，很容易出现「须发壮汉叫沈知雪」这种割裂感。
 * 所以分成两个池，换名时按角色性别各取各的，同局仍然绝不重名。
 *
 * 两池各约 50 个名字，足以支撑连续几十局不重复；
 * 都不含模板里的 NPC（死者、旧案当事人）姓名。
 */
const FEMALE_NAMES = [
  '苏见月', '陆知微', '宋听澜', '江照雪', '温以宁', '许南枝', '唐听雨', '程未晞',
  '秦望舒', '罗青梧', '宋微凉', '冯知意', '于归雁', '董疏影', '袁清溪', '邓秋水',
  '吕晚照', '苏幕遮', '蔡雨眠', '丁雪辞', '薛照微', '阎若水', '潘听雪', '杜若蘅',
  '夏木槿', '钟晚晴', '田澄心', '范微星', '方知夏', '谭月影', '廖云舒', '金素秋',
  '孔青禾', '崔烟岚', '邱云岫', '江晚照', '侯月白', '孟听澜', '钱青芜', '汤映雪',
  '尹素心', '黎微雨', '常静姝', '乔晚意', '龚月见', '祝青鸾', '舒雁南',
] as const

const MALE_NAMES = [
  '林晚舟', '沈砚秋', '顾长风', '白清野', '陈停云', '谢临川', '裴照夜', '周雪鸿',
  '叶归舟', '傅明烛', '韩栖迟', '梁思远', '崔砚白', '郑云舟', '萧景行', '曹月白',
  '曾慕言', '彭星野', '卢雁声', '蒋南浦', '魏云深', '章怀瑾', '鲁青衫', '尹望山',
  '戴星河', '汪砚舟', '任长歌', '姜白石', '石清越', '姚听风', '邹北辰', '熊晚枫',
  '陆雪鸿', '郝明镜', '白雁行', '康既明', '毛清樾', '秦子夜', '史砚知', '顾星阑',
  '邵清川', '龙栖鹤', '段拂衣', '雷惊蛰', '易寒舟', '武凌川', '赖清风', '文若谷',
  '宁远舟',
] as const

/** 全池（角色没标性别时的兜底） */
const NAME_POOL: readonly string[] = [...FEMALE_NAMES, ...MALE_NAMES]

/**
 * 模板里的 NPC（死者、旧案当事人）姓名。它们不是角色，但会与角色名
 * 出现在一起；先保护起来，避免「白露」把「白露笙」改成半截名字。
 */
const PROTECTED_NAMES = [
  '沈伯棠', '白露笙', '裴雪峰', '沈知野', '裴氏文旅',
] as const

const HISTORY_KEY = 'mmai:recent-role-names'
const HISTORY_LIMIT = 30
const RECENT_AVOID = 24

type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function storage(): StorageLike | null {
  try {
    const s = (globalThis as { localStorage?: StorageLike }).localStorage
    return s ?? null
  } catch {
    return null
  }
}

function loadRecent(): string[] {
  try {
    const raw = storage()?.getItem(HISTORY_KEY)
    const value = raw ? JSON.parse(raw) : []
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

let recentCache: string[] | null = null

function recentNames(): string[] {
  if (recentCache === null) recentCache = loadRecent()
  return recentCache
}

function remember(names: string[]): void {
  recentCache = [...recentNames(), ...names].slice(-HISTORY_LIMIT)
  try {
    storage()?.setItem(HISTORY_KEY, JSON.stringify(recentCache))
  } catch {
    /* 隐私模式 / 服务端：只保留在内存里 */
  }
}

function randomIndex(max: number): number {
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto
  if (cryptoObj?.getRandomValues) {
    const buf = new Uint32Array(1)
    cryptoObj.getRandomValues(buf)
    return buf[0] % max
  }
  return Math.floor(Math.random() * max)
}

/** 洗牌（Fisher–Yates），返回新数组，不改原池 */
function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * 取一批同局互不相同、且近期没用过的姓名。
 * ------------------------------------------------------------------
 * `genders[i]` 表示第 i 个角色要的性别；缺省时从全池取。
 * 某个性别的池子被「近期已用」筛到不够时，先放宽近期限制，
 * 再不行才从全池兜底 —— 无论如何同局内绝不重名。
 */
export function pickDistinctNames(
  count: number,
  genders?: (Gender | undefined)[],
): string[] {
  const n = Math.max(0, Math.floor(count))
  if (n === 0) return []

  const avoid = new Set(recentNames().slice(-RECENT_AVOID))
  const used = new Set<string>()
  const picked: string[] = []

  const take = (pool: readonly string[]): string | null => {
    const fresh = pool.filter((name) => !used.has(name) && !avoid.has(name))
    const fallback = pool.filter((name) => !used.has(name))
    const candidates = fresh.length > 0 ? fresh : fallback
    if (candidates.length === 0) return null
    return shuffled(candidates)[0]
  }

  for (let i = 0; i < n; i += 1) {
    const gender = genders?.[i]
    const preferred = gender === 'female' ? FEMALE_NAMES : gender === 'male' ? MALE_NAMES : NAME_POOL
    let name = take(preferred)
    // 该性别的池子被挤干（极端情况）→ 退回全池，宁可名字气质不搭也不能重名
    if (!name) name = take(NAME_POOL)
    if (!name) break
    used.add(name)
    picked.push(name)
  }

  remember(picked)
  return picked
}

/**
 * 整包改名。返回新对象，不修改入参。
 * 用占位符两阶段替换，避免 A→B、B→A 的连环覆盖。
 *
 * `allRoleGenders` 与 `allRoleNames` 一一对应：换名时按角色性别从对应池里取，
 * 保证「叫沈知雪的角色」拿到的是女性名字，头像与名字不会互相打脸。
 */
export function renameRoles(
  pkg: ScriptPackage,
  /** 模板稳定标识，写入 game_config.case_id 供防重复指纹使用 */
  caseId?: string,
  /**
   * 模板的**全部**角色姓名（含被人数裁剪掉的角色）。
   * 4/5 人局裁掉的角色仍会在线索里被提到，这些名字也必须一起换掉。
   */
  allRoleNames?: string[],
  /** 与 allRoleNames 一一对应的性别；缺省时按全池随机 */
  allRoleGenders?: (Gender | undefined)[],
): ScriptPackage {
  // 测试逃生舱：逐帧隔离审计需要比对同一份姓名，联机测试统一走模板原名。
  // 正常游戏不会设置这个环境变量。
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  if (proc?.env?.MMAI_FIXED_ROLE_NAMES === '1') return pkg

  const fallback = pkg.roles.map((role) => role.name)
  const oldNames = [...new Set((allRoleNames?.length ? allRoleNames : fallback).filter(Boolean))]
  const newNames = pickDistinctNames(oldNames.length, allRoleGenders)
  if (oldNames.length !== newNames.length) return pkg

  let text = JSON.stringify(pkg)

  // 先保护 NPC 姓名（可能包含某个角色名作为子串）
  const protectedTokens: { token: string; value: string }[] = []
  PROTECTED_NAMES.forEach((name, i) => {
    if (!text.includes(name)) return
    const token = `@@MMAI_NPC_${i}@@`
    text = text.split(name).join(token)
    protectedTokens.push({ token, value: name })
  })

  // 长名优先，避免「白露」先于「白露笙」被替换（NPC 已经保护，这里再兜一层）
  const pairs = oldNames
    .map((old, i) => ({ old, token: `@@MMAI_ROLE_${i}@@`, next: newNames[i] }))
    .sort((a, b) => b.old.length - a.old.length)

  for (const pair of pairs) {
    if (!pair.old) continue
    text = text.split(pair.old).join(pair.token)
  }
  for (const pair of pairs) {
    text = text.split(pair.token).join(pair.next)
  }
  for (const item of protectedTokens) {
    text = text.split(item.token).join(item.value)
  }

  const next = JSON.parse(text) as ScriptPackage
  if (caseId) next.game_config.case_id = caseId
  return next
}
