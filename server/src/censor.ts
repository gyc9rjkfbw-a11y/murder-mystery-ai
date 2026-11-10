/**
 * ★ 按座位裁剪（联机安全性的全部）
 * ==========================================================================
 * `censorSeat(room, seatId)` 是**唯一**生成对外视图的函数。
 * 服务器任何地方都不允许直接 `JSON.stringify(room)` / 下发内部状态，
 * 必须经过这里 —— 否则就等于把整个剧本包（含凶手是谁）广播给所有玩家。
 *
 * 严格对齐 `src/services/net/protocol.ts` 里的裁剪规则表：
 *
 * | 字段 | 自己（平民） | 自己（凶手） | 其他座位 | 复盘时所有人 |
 * | --- | --- | --- | --- | --- |
 * | self.role（剧本全文） | ✅ | ✅ | —（不下发） | ✅ |
 * | self.isMurderer / camp | ✅ 平民 | ✅ 凶手 | — | ✅ |
 * | script.roles[i].is_murderer | 只有自己是 true 才为 true | 同左 | 恒 false | ✅ 真实值 |
 * | script.roles[i].full_script | 只有自己非空 | 同左 | 空字符串 | ✅ |
 * | script.murderer_privilege | ❌ null | ✅ 第 2 轮起 | ❌ null | ✅ |
 * | script.global_truth | ❌ 空壳 | ❌ 空壳 | ❌ 空壳 | ✅ 真实值 |
 * | script.clue_batches | 只含已发放 tier | 同左 | 同左 | ✅ 全部 |
 * | script.private_clues | 只含自己的 | 同左 | 同左 | ✅ 全部 |
 * | script.search_locations[].clues | ❌ 清空 | ❌ 清空 | ❌ 清空 | ✅ 全部 |
 * | seats[].roleName | 只有自己 | 只有自己 | ❌ 不下发 | ✅ 全部 |
 * | reveal | ❌ null | ❌ null | ❌ null | ✅ |
 * | chats[]（公屏文字） | ✅ 公开 | ✅ 公开 | ✅ 公开 | ✅ 公开 |
 * | chats[].roleName | 不存在该字段 | 同左 | 同左 | 同左 |
 * | voice[]（谁在麦上） | ✅ 公开 | ✅ 公开 | ✅ 公开 | ✅ 公开 |
 */

import { pacingFor } from '@/services/rules'
import type {
  RevealView,
  SeatBrief,
  SeatView,
  SelfView,
  TallyRow,
} from '@/services/net/protocol'
import type { ClueBatch, ClueItem, GlobalTruth, PrivateClue, Role, ScriptPackage } from '@/types/script'
import type { Statement, VoteRecord } from '@/types/game'
import type { Room } from './room'

/** 对局中 global_truth 的空壳（三个字段全部清空） */
function blankTruth(): GlobalTruth {
  return { murderer_name: '', cause_of_death: '', absolute_timeline: '' }
}

/** 别人角色的骨架：只留 name / identity，其余全部清空，is_murderer 恒 false */
function roleSkeleton(role: Role): Role {
  return {
    name: role.name,
    identity: role.identity,
    is_murderer: false,
    surface_task: '',
    deep_task: '',
    personal_timeline: '',
    full_script: '',
    side_quests: [],
  }
}

/** 完整角色（自己 / 复盘时） */
function roleFull(role: Role): Role {
  return { ...role, side_quests: [...(role.side_quests ?? [])] }
}

function cloneClue(c: ClueItem): ClueItem {
  return { ...c }
}

function cloneBatch(b: ClueBatch): ClueBatch {
  return { tier: b.tier, title: b.title, clues: [...b.clues] }
}

/**
 * 生成某个座位的完整视图。
 *
 * @param room   房间内部状态（含未公开信息）
 * @param seatId 视图归属的座位
 */
export function censorSeat(room: Room, seatId: string): SeatView {
  const seat = room.seatById(seatId)
  if (!seat) throw new Error(`未知座位：${seatId}`)

  const atReveal = room.phase === 'reveal'
  const script = room.script
  const pacing = pacingFor(room.playerCount)
  const myRoleName = seat.roleName
  const myRole = myRoleName ? room.roleByName(myRoleName) : null
  const truth = script?.global_truth ?? blankTruth()
  const isMurderer = !!myRoleName && myRoleName === truth.murderer_name

  // ---------------- seats ----------------
  const seats: SeatBrief[] = room.seats.map((s) => {
    const brief: SeatBrief = {
      seatId: s.seatId,
      name: s.name,
      // 头像跟昵称同级，都是公开装饰信息（来自玩家档案；没档案就是默认头像）
      avatar: s.avatar,
      isSelf: s.seatId === seatId,
      isHost: s.seatId === room.hostSeatId,
      isBot: s.isBot,
      ready: s.ready,
      connected: s.connected,
    }
    // 角色名只在「自己」或复盘时下发，避免大厅/对局中泄露座位与角色的对应关系
    if (s.seatId === seatId || atReveal) {
      if (s.roleName) brief.roleName = s.roleName
    }
    return brief
  })

  // ---------------- self ----------------
  // 凶手特权：只有凶手端、且已进入 privilegeRound（第 2 轮）之后才有值
  const hint = script?.murderer_privilege?.intuition_hint ?? ''
  const privilegeUnlocked = room.round >= pacing.privilegeRound
  const canSeePrivilege = isMurderer && hint.length > 0 && (privilegeUnlocked || atReveal)

  const myStraw = room.strawPoll.find((v) => v.voterSeatId === seatId)
  const myVote = room.votes.find((v) => v.voterSeatId === seatId)

  const self: SelfView = {
    seatId,
    name: seat.name,
    roleName: myRoleName ?? '',
    // 如实告诉本人阵营：凶手必须知道自己是凶手，平民也必须明确知道自己是平民
    camp: isMurderer ? 'murderer' : 'civil',
    isMurderer,
    role: myRole ? roleFull(myRole) : null,
    privateClues: room.privateCluesOf(seatId).map(cloneClue),
    privilege: canSeePrivilege
      ? { round: pacing.privilegeRound, hint, at: room.privilegeAt || Date.now() }
      : null,
    strawVote: myStraw?.targetRoleName ?? null,
    vote: myVote?.targetRoleName ?? null,
  }

  // ---------------- script（裁剪过） ----------------
  const releasedTiers = atReveal
    ? (script?.clue_batches ?? []).map((b) => b.tier)
    : [...room.releasedTiers]

  const batches = (script?.clue_batches ?? [])
    .filter((b) => releasedTiers.includes(b.tier))
    .map(cloneBatch)

  // 公共线索板 = 已发放批次 + 已被任何玩家公开的搜证/私有线索
  const publicClues = atReveal
    ? room.clues.map((c) => c.text)
    : room.clues.filter((c) => c.published).map((c) => c.text)

  // 私有线索（PrivateClue 视图）：对局中只含自己的角色私有线索；
  // 复盘时全部公开，并附上每个人翻出来的搜证线索。
  let privateClues: PrivateClue[]
  if (atReveal) {
    privateClues = [
      ...(script?.private_clues ?? []).map((pc) => ({ ...pc })),
      ...room.clues
        .filter((c) => !c.isPrivate && c.tier === undefined && c.foundBy)
        .map((c) => ({
          role_name: room.seatById(c.foundBy ?? '')?.roleName ?? '未知',
          text: c.text,
        })),
    ]
  } else {
    privateClues = (script?.private_clues ?? [])
      .filter((pc) => pc.role_name === myRoleName)
      .map((pc) => ({ ...pc }))
  }

  const censored: ScriptPackage = {
    game_config: script
      ? { ...script.game_config }
      : { theme: room.theme, player_count: room.playerCount, background_story: '' },
    // 对局中一律空壳，只有复盘阶段才填真实值
    global_truth: atReveal ? { ...truth } : blankTruth(),
    roles: (script?.roles ?? []).map((r) => {
      const mine = !!myRoleName && r.name === myRoleName
      if (mine || atReveal) return roleFull(r)
      return roleSkeleton(r)
    }),
    murderer_privilege: {
      intuition_hint: atReveal || canSeePrivilege ? hint : '',
    },
    public_clues: publicClues,
    clue_batches: batches,
    private_clues: privateClues,
    // 搜证地点的线索内容永远不下发（抽取由服务器做），只给地点名
    search_locations: (script?.search_locations ?? []).map((loc) => ({
      name: loc.name,
      clues: atReveal ? [...loc.clues] : [],
    })),
  }

  // ---------------- 其它 ----------------
  const statements: Statement[] = room.statements.map((s) => ({ ...s }))
  const strawTally: TallyRow[] = room.strawTally.map((row) => ({
    roleName: row.roleName,
    count: row.count,
    voters: [...row.voters],
  }))
  const votes: VoteRecord[] | undefined =
    room.phase === 'voting' ? room.votes.map((v) => ({ ...v })) : undefined
  const reveal: RevealView | null = atReveal && room.reveal ? cloneReveal(room.reveal) : null

  return {
    v: room.version,
    roomCode: room.code,
    playerCount: room.playerCount,
    theme: room.theme,
    phase: room.phase,
    started: room.started,
    round: room.round,
    maxRounds: room.maxRounds,
    searchRounds: room.searchRounds,
    phaseEndsAt: room.phaseEndsAt,
    serverAt: Date.now(),

    seats,
    self,
    script: censored,

    releasedTiers,
    searchLeft: room.phase === 'search' ? room.searchLeftFor(seatId) : 0,
    locations: room.locationStats(),

    statements,
    turnSeatId: room.phase === 'statement' ? room.turnSeatId : null,
    strawTally,
    accel: { ...room.accel },
    roundSummary: room.roundSummary ? { ...room.roundSummary, tally: { ...room.roundSummary.tally } } : null,
    hints: room.hints.map((h) => ({ ...h })),
    reveal,
    ...(votes ? { votes } : {}),

    // 公屏历史与语音名单都是纯公开信息（不含任何身份字段），原样下发即可；
    // 仍然逐条浅拷贝，避免调用方不小心改到房间内部状态。
    chats: room.chats.map((m) => ({ ...m })),
    voice: room.voicePeers(),
  }
}

function cloneReveal(reveal: RevealView): RevealView {
  return {
    murdererRoleName: reveal.murdererRoleName,
    truth: { ...reveal.truth },
    settlement: reveal.settlement.map((r) => ({ ...r })),
    votes: reveal.votes.map((v) => ({ ...v })),
    review: reveal.review.map((r) => ({ ...r })),
  }
}