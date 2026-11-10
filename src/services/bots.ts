import type { Role } from '@/types/script'

/**
 * 机器人玩家（前端模拟）
 * ------------------------------------------------------------------
 * 前端这一版没有后端，为了让 4-6 人的流程完整可玩，除自己之外的座位
 * 由本地模拟玩家填充。它们的发言与投票都基于剧本数据推导，
 * 因此接入真实 WebSocket 后，把这些函数换成服务端事件即可，UI 不用改。
 *
 * 发言按轮次设计，与产品给的节奏规范对齐：
 *   第 1 轮：破冰，交代时间线，抛出表层秘密
 *   第 2 轮：质询，抓住第一轮的矛盾点，凶手开始甩锅
 *   第 3 轮：收网，串联线索，指向具体的人
 */

/** 把「表层任务」模糊化成一句可以公开说出口的话（不能自曝） */
export function blurSurfaceTask(text: string): string {
  const cleaned = text.replace(/[（(][^）)]*[）)]/g, '').replace(/[“”"]/g, '')
  const firstClause = cleaned.split(/[，。；;]/)[0] ?? cleaned
  return firstClause.length > 24 ? `${firstClause.slice(0, 24)}……` : firstClause
}

const OPENERS = [
  '那我先开个口。',
  '既然轮到我了，我就直说。',
  '我不太会说话，但有几件事必须讲清楚。',
  '我不想绕圈子。',
  '这个屋子里的空气不对，我先说我这边的情况。',
]

/** 第一轮：破冰与时间线 */
const ROUND1_TAILS = [
  '那段时间我的行踪就是这样，谁不信可以来对。',
  '我该说的都说了，剩下的是我自己的事。',
  '时间我记不了那么准，但大致就是这样。',
]

/** 第二轮：质询与甩锅 */
const ROUND2_TAILS = [
  '刚才有人说的和第一轮对不上，我想知道为什么。',
  '我承认我有事没说，可那件事和死者的死没有关系。',
  '你们与其盯着我，不如想想谁最需要那段时间没人看见他。',
  '我不是要替谁遮掩，我只是不想被人当刀使。',
  '我可以把我知道的全说了，但你们得先回答我一个问题。',
]

/** 第三轮：收网 */
const ROUND3_TAILS = [
  '我不再纠结那些小秘密了，把时间线串起来只有一个人说得通。',
  '现在就问道具、问手法、问动机——别再问谁跟谁有私情了。',
  '我这一票已经有方向了，但我想先听最后一个人的解释。',
  '把所有线索摆在一起看，那个人的说法是唯一有断口的。',
]

/** 生成一条模拟发言：依据角色身份与表层任务，绝不泄露深层任务 */
export function makeBotStatement(role: Role, allRoles: Role[], index: number, round = 1): string {
  const opener = OPENERS[(index + round) % OPENERS.length]
  const others = allRoles.filter((r) => r.name !== role.name)
  const watched = others[(index + round) % Math.max(1, others.length)]
  const surface = blurSurfaceTask(role.surface_task)

  const tails = round <= 1 ? ROUND1_TAILS : round === 2 ? ROUND2_TAILS : ROUND3_TAILS
  const tail = tails[(index * 2 + round) % tails.length]

  const accuse =
    round >= 3 && watched
      ? `我现在的票准备给${watched.name}。${watched.name}，你说你在现场只待了两分钟，可你身上那件东西怎么解释？`
      : watched
        ? `${watched.name}刚才的眼神一直在躲，我想听听${watched.name}怎么说。`
        : ''

  const parts = [
    `${opener}我是${role.identity}。`,
    round <= 1
      ? `案发那段时间我在忙自己的事——${surface}，这点我不否认。`
      : `第一轮我说过的那部分不变，但我要补一句：${surface}这件事，不止我一个人知道。`,
    role.is_murderer
      ? '死者的死对我来说不是解脱，是麻烦。'
      : '我和死者之间确实有过节，但还没到要他命的地步。',
    accuse,
    tail,
  ]
  return parts.filter(Boolean).join('')
}

/** 模拟玩家投票：带一点直觉噪声，约四成概率命中凶手 */
export function makeBotVoteTarget(
  allRoles: Role[],
  murdererName: string,
  selfName: string | undefined,
  seed: number,
): string {
  const candidates = allRoles.filter((r) => r.name !== selfName)
  if (candidates.length === 0) return allRoles[0].name
  const hit = (seed % 10) < 4
  if (hit) {
    const m = candidates.find((r) => r.name === murdererName)
    if (m) return m.name
  }
  const pool = candidates.filter((r) => r.name !== murdererName)
  const list = pool.length > 0 ? pool : candidates
  return list[seed % list.length].name
}

/** 对一条线索的模拟反应，用在搜证环节的公共播报里 */
export function makeClueComment(clue: string): string {
  const head = clue.length > 18 ? `${clue.slice(0, 18)}……` : clue
  const tails = ['这条我记住了。', '……这条有点意思。', '谁放的？', '和某人说的对不上。']
  return `${head} ${tails[clue.length % tails.length]}`
}

/** AI 侦探提示的备用抓手（当本轮还没有任何线索可引用时使用） */
export const DETECTIVE_FALLBACKS = [
  '先让每个人按顺序复述案发前后 30 分钟的行动轨迹',
  '问清楚谁知道死者的行程安排，以及是谁最后一个见过死者',
  '确认现场有没有被移动过的东西，谁有机会单独留在现场',
  '让每个人说一个自己怀疑的人，并给出理由',
]