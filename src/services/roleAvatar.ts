/**
 * 角色头像：确定性动漫头像生成
 * ==========================================================================
 * 为什么不用图片资源：
 *   1. 角色名每局都会随机换（见 roleNames.ts），不可能给每个名字配一张图；
 *   2. 项目要能完全离线跑，不能依赖外部头像服务（DiceBear 之类的 CDN）；
 *   3. AI 生成的剧本还要在本地即时渲染，没有素材包可用。
 *
 * 做法：用「角色名 + 性别」算一个稳定散列，映射到发型 / 发色 / 瞳色 / 服饰 /
 * 配饰，再由 `RoleAvatar.vue` 画成纯 SVG。同一个角色名永远得到同一张脸，
 * 不同角色之间又有足够区分度 —— 复盘时不会出现两张一模一样的头像。
 *
 * 本模块同时被浏览器与房间服务器（esbuild 打包）引用，所以不依赖 DOM。
 */

import type { Gender, Role } from '@/types/script'

export type HairVariant = 0 | 1 | 2 | 3
export type Accessory = 'none' | 'ribbon' | 'clip' | 'earring' | 'glasses'

export interface RoleLook {
  gender: Gender
  hair: HairVariant
  hairColor: string
  hairShade: string
  eyeColor: string
  skin: string
  skinShade: string
  outfit: string
  outfitShade: string
  accessory: Accessory
  bgFrom: string
  bgTo: string
  /** 女性角色偶尔带一点腮红，男性一律不画 */
  blush: boolean
}

const HAIR_COLORS: [string, string][] = [
  ['#241c26', '#141018'],
  ['#3c2a22', '#241811'],
  ['#593626', '#33200f'],
  ['#6d4630', '#3f281a'],
  ['#2a3048', '#171b2a'],
  ['#4a2430', '#2a1219'],
  ['#8a6a4e', '#5a4230'],
  ['#9aa6bb', '#6a7488'],
]

const FEMALE_EYES = ['#8a5cd6', '#4b86d8', '#39a894', '#cf5b4a', '#c8963a', '#6a63d8', '#b44d86']
const MALE_EYES = ['#3f6fb5', '#4a8c7a', '#7a5bb8', '#b05a3c', '#57707f', '#8a6a2f']

const SKINS: [string, string][] = [
  ['#f8e0ce', '#e6bfa8'],
  ['#f2d3bd', '#dcae95'],
  ['#ebc7ad', '#d2a184'],
  ['#dfb595', '#c2916f'],
]

const FEMALE_OUTFITS: [string, string][] = [
  ['#3f2f57', '#251a36'],
  ['#2f4257', '#1a2735'],
  ['#52283f', '#301322'],
  ['#2c4440', '#182a27'],
  ['#4a3a26', '#2b2013'],
]
const MALE_OUTFITS: [string, string][] = [
  ['#26303f', '#161d27'],
  ['#33283f', '#1d1526'],
  ['#3a2a24', '#211611'],
  ['#243b35', '#132420'],
  ['#3d2b33', '#22161b'],
]

const BGS: [string, string][] = [
  ['#2b2138', '#141019'],
  ['#1e2b3c', '#0f1720'],
  ['#35222a', '#1a1014'],
  ['#22322f', '#101a18'],
  ['#332c1e', '#191509'],
  ['#2a2430', '#141118'],
]

/** FNV-1a：短字符串散列，足够稳定且实现极简 */
function hashCode(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 从散列里按不同「盐」取一个下标，保证同一角色各维度互相独立 */
function pick<T>(items: readonly T[], seed: number, salt: number): T {
  const mixed = (seed ^ Math.imul(salt, 2654435761)) >>> 0
  return items[mixed % items.length]
}

const FEMALE_HINTS = [
  '女', '夫人', '太太', '小姐', '女子', '少女', '姑娘', '母亲', '姐姐', '妹妹', '妻', '妾',
  '妃', '公主', '女史', '伎', '保姆', '阿姨', '姑姑', '婶', '护士', '空乘', '女孩',
]
const MALE_HINTS = [
  '男', '先生', '公子', '少爷', '父亲', '兄', '弟', '叔', '伯', '将军', '中郎将', '内侍',
  '和尚', '道士', '大叔', '侍卫', '伴读', '副站长',
]

/**
 * 角色性别：优先用剧本里写明的 `gender`；
 * 没写就按「身份 → 名字」推断，实在推断不出来再按名字散列对半分。
 * AI 生成的剧本偶尔会漏字段，这里是最后一道兜底，不能让头像空着。
 */
export function resolveGender(role: Pick<Role, 'name' | 'identity' | 'gender'>): Gender {
  if (role.gender === 'male' || role.gender === 'female') return role.gender
  const text = `${role.identity ?? ''}`
  const female = FEMALE_HINTS.some((w) => text.includes(w))
  const male = MALE_HINTS.some((w) => text.includes(w))
  if (female && !male) return 'female'
  if (male && !female) return 'male'

  // 名字层面的强特征（雪、月、婉、娘……）只作为弱提示
  const name = role.name ?? ''
  if (/[娘姐妹母女妃娥婉娟娥婷娜丽芳媛]$/.test(name)) return 'female'
  if (/[郎君父兄叔伯公爷]$/.test(name)) return 'male'
  return hashCode(name || 'role') % 2 === 0 ? 'female' : 'male'
}

/** 给一个角色算出一张稳定的脸 */
export function roleLook(name: string, gender: Gender): RoleLook {
  const seed = hashCode(`${name}|${gender}`)
  const female = gender === 'female'
  const [hairColor, hairShade] = pick(HAIR_COLORS, seed, 3)
  const [skin, skinShade] = pick(SKINS, seed, 7)
  const [outfit, outfitShade] = pick(female ? FEMALE_OUTFITS : MALE_OUTFITS, seed, 11)
  const [bgFrom, bgTo] = pick(BGS, seed, 17)
  const accessoryRoll = (seed >>> 13) % 4

  let accessory: Accessory = 'none'
  if (female) {
    accessory = accessoryRoll === 0 ? 'ribbon' : accessoryRoll === 1 ? 'clip' : accessoryRoll === 2 ? 'earring' : 'none'
  } else if (accessoryRoll === 0) {
    accessory = 'glasses'
  }

  return {
    gender,
    hair: (seed % 4) as HairVariant,
    hairColor,
    hairShade,
    eyeColor: pick(female ? FEMALE_EYES : MALE_EYES, seed, 5),
    skin,
    skinShade,
    outfit,
    outfitShade,
    accessory,
    bgFrom,
    bgTo,
    blush: female && (seed >>> 19) % 3 !== 0,
  }
}

/** 角色 → 脸（视图里最常用的入口） */
export function lookOfRole(role: Pick<Role, 'name' | 'identity' | 'gender'> | null | undefined): RoleLook {
  if (!role) return roleLook('待定角色', 'female')
  return roleLook(role.name || '无名', resolveGender(role))
}
