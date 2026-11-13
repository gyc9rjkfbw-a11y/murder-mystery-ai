<script setup lang="ts">
/**
 * 角色动漫头像（纯 SVG，离线可用）
 * ------------------------------------------------------------------
 * 用法：
 *   <RoleAvatar :role="role" :size="88" />
 *   <RoleAvatar name="沈知雪" gender="female" :size="44" />
 *
 * 同一角色名 + 性别永远得到同一张脸（见 services/roleAvatar.ts），
 * 所以复盘、投票、陈述页出现的「沈知雪」长得都是同一个人。
 */
import { computed, useId } from 'vue'
import { lookOfRole, roleLook } from '@/services/roleAvatar'
import type { Gender, Role } from '@/types/script'

const props = withDefaults(
  defineProps<{
    role?: Pick<Role, 'name' | 'identity' | 'gender'> | null
    name?: string
    gender?: Gender
    size?: number
    /** 外圈色调：金 = 普通，血 = 凶手 */
    tone?: 'gold' | 'blood' | 'none'
    /** 变暗（未发言 / 已出局的人） */
    dim?: boolean
  }>(),
  { size: 64, tone: 'gold', dim: false },
)

const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
const look = computed(() =>
  props.role
    ? lookOfRole(props.role)
    : roleLook(props.name || '无名', props.gender || 'female'),
)
const label = computed(() => {
  const who = props.role?.name ?? props.name ?? '角色'
  return `${who}（${look.value.gender === 'female' ? '女' : '男'}）的角色头像`
})

/* ---- 后发：女性 4 种（长直 / 双马尾 / 高马尾 / 波波头），男性统一短发 ---- */
const backHair = computed(() => {
  if (look.value.gender === 'male') {
    return 'M33 44 C31 25 39.5 17 50 17 C60.5 17 69 25 67 44 L67 50 L33 50 Z'
  }
  switch (look.value.hair) {
    case 1:
      return 'M30 46 C28 26 37 17 50 17 C63 17 72 26 70 46 L70 62 L30 62 Z'
    case 2:
      return 'M31 45 C29 25 38 16 50 16 C63 16 71 25 69 45 L69 57 L31 57 Z'
    case 3:
      return 'M31 46 C29 26 38 18 50 18 C62 18 71 26 69 46 L69 62 C66 58 64 53 63 47 L37 47 C36 53 34 58 31 62 Z'
    default:
      return 'M30 45 C28 26 37 17 50 17 C63 17 72 26 70 45 L71 78 C68 71 65 62 64 51 L36 51 C35 62 32 71 29 78 Z'
  }
})

/* ---- 女性额外发束（双马尾 / 高马尾） ---- */
const hasTwintails = computed(() => look.value.gender === 'female' && look.value.hair === 1)
const hasPonytail = computed(() => look.value.gender === 'female' && look.value.hair === 2)
const ponytail = 'M61 23 C73 19 82 29 80 43 C79 51 74 56 70 56 C75 44 72 32 60 30 Z'

/* ---- 侧发：女性除了波波头都留两缕垂在脸颊边 ---- */
const hasSideLock = computed(() => look.value.gender === 'female' && look.value.hair !== 3)

/* ---- 刘海 ---- */
const bangs = computed(() => {
  if (look.value.gender === 'male') {
    switch (look.value.hair) {
      case 1:
        return 'M33.6 41 C33.4 28 40.5 23 50 23 C60.5 23 66.8 29 66.4 41 C64 32.5 57.5 27.6 49 28.4 C44 30 39 34 36 39 C35 39.7 34.2 40.3 33.6 41 Z'
      case 2:
        return 'M34 40 C34 27.5 41 22.5 50 22.5 C60 22.5 66.5 28 66 40 C64 34 59 30 52.5 29.6 C47 31.5 42 31.8 37 29.8 C35.5 32.5 34.6 36 34 40 Z'
      case 3:
        return 'M34.5 41 C34.5 29 41 24 50 24 C59 24 65.5 29 65.5 41 C63 36 58 33.5 50 33.5 C42 33.5 37 36 34.5 41 Z'
      default:
        return 'M33.5 42 C33 29.5 40 23.5 50 23.5 C60 23.5 67 29.5 66.5 42 C64.5 35 59 30.5 53 30.8 C49 33 45.5 33 41.5 31 C37 32.5 34.8 36.5 33.5 42 Z'
    }
  }
  switch (look.value.hair) {
    case 1:
      return 'M33.5 44 C33 30 39.5 23 50 23 C60.5 23 67 30 66.5 44 C64 34 58.5 29.5 51 29 C50.4 34 49.6 34 49 29 C42 29.6 36 34 33.5 44 Z'
    case 2:
      return 'M33.5 43 C33 29 40 23 50 23 C61 23 67 29.5 66.5 42 C65 34 60 28.5 52 28 C48 30 42 33 38 39 C36.5 40 34.8 41.5 33.5 43 Z'
    case 3:
      return 'M33.5 43 C32.8 30 39.5 23.5 50 23.5 C60.5 23.5 67.2 30 66.5 43 C63.5 37 59 33 54 32.2 C52 35 51 36 50 36 C47.5 35.5 45 33.5 43 32 C38 33 35 37 33.5 43 Z'
    default:
      return 'M33.5 43 C32.5 30 39 23.5 50 23.5 C61 23.5 67.5 30 66.5 43 C64 36 60 32 55 31.5 C51 34 46 34 42 31.5 C37.5 32.5 34.5 36.5 33.5 43 Z'
  }
})
</script>

<template>
  <span
    class="role-avatar"
    :class="[`role-avatar--${tone}`, { 'role-avatar--dim': dim }]"
    :style="{ width: `${size}px`, height: `${size}px` }"
    role="img"
    :aria-label="label"
  >
    <svg viewBox="9 6 82 82" width="100%" height="100%" aria-hidden="true">
      <defs>
        <radialGradient :id="`rb-${uid}`" cx="50%" cy="32%" r="72%">
          <stop offset="0%" :stop-color="look.bgFrom" />
          <stop offset="100%" :stop-color="look.bgTo" />
        </radialGradient>
        <linearGradient :id="`rh-${uid}`" x1="18%" y1="0%" x2="72%" y2="100%">
          <stop offset="0%" :stop-color="look.hairColor" />
          <stop offset="100%" :stop-color="look.hairShade" />
        </linearGradient>
        <clipPath :id="`rc-${uid}`"><circle cx="50" cy="50" r="50" /></clipPath>
      </defs>

      <g :clip-path="`url(#rc-${uid})`">
        <rect width="100" height="100" :fill="`url(#rb-${uid})`" />
        <circle cx="50" cy="40" r="33" :fill="look.bgFrom" opacity="0.5" />

        <!-- 双马尾（先画，压在后发下面） -->
        <template v-if="hasTwintails">
          <ellipse cx="20.5" cy="62" rx="8" ry="15" :fill="look.hairShade" />
          <ellipse cx="79.5" cy="62" rx="8" ry="15" :fill="look.hairShade" />
        </template>

        <!-- 后发 -->
        <path :d="backHair" :fill="`url(#rh-${uid})`" />
        <path v-if="hasPonytail" :d="ponytail" :fill="look.hairShade" />

        <!-- 肩与衣领 -->
        <path
          d="M50 66 C62 66 71 72 75 80 L78 100 L22 100 L25 80 C29 72 38 66 50 66 Z"
          :fill="look.outfit"
        />
        <path d="M45 67 L50 76 L55 67 L52.4 66 L50 70 L47.6 66 Z" :fill="look.outfitShade" />
        <path d="M50 66 L50 76" :stroke="look.outfitShade" stroke-width="0.8" opacity="0.5" />

        <!-- 脖子 -->
        <path d="M43.5 57 h13 v9 c0 4.5 -13 4.5 -13 0 Z" :fill="look.skinShade" />

        <!-- 耳朵 -->
        <ellipse cx="33" cy="46" rx="3.1" ry="4.5" :fill="look.skin" />
        <ellipse cx="67" cy="46" rx="3.1" ry="4.5" :fill="look.skin" />

        <!-- 脸 -->
        <path
          d="M50 25 C59.5 25 66.5 32 66.5 43 C66.5 54 59.5 63.5 50 63.5 C40.5 63.5 33.5 54 33.5 43 C33.5 32 40.5 25 50 25 Z"
          :fill="look.skin"
        />

        <!-- 腮红 -->
        <template v-if="look.blush">
          <ellipse cx="38.6" cy="51.4" rx="4.3" ry="2.2" fill="#e0807f" opacity="0.3" />
          <ellipse cx="61.4" cy="51.4" rx="4.3" ry="2.2" fill="#e0807f" opacity="0.3" />
        </template>

        <!-- 眼睛（左右各一） -->
        <g>
          <ellipse cx="42" cy="46" rx="4.6" ry="5.4" fill="#fdf6f1" opacity="0.94" />
          <ellipse cx="42" cy="46.4" rx="3.4" ry="4.8" :fill="look.eyeColor" />
          <ellipse cx="42" cy="46.8" rx="1.6" ry="2.5" fill="#1a1320" />
          <circle cx="40.9" cy="44.2" r="1.3" fill="#fff" opacity="0.95" />
          <circle cx="43.2" cy="48.8" r="0.7" fill="#fff" opacity="0.55" />
          <path
            d="M37 43.2 Q42 40.2 47 43.4"
            stroke="#1d1526"
            stroke-width="1.5"
            fill="none"
            stroke-linecap="round"
          />
          <template v-if="look.gender === 'female'">
            <path d="M36.6 42.2 l-1.3 -1.5" stroke="#1d1526" stroke-width="1" stroke-linecap="round" />
            <path d="M47.4 42.2 l1.3 -1.5" stroke="#1d1526" stroke-width="1" stroke-linecap="round" />
          </template>
        </g>
        <g>
          <ellipse cx="58" cy="46" rx="4.6" ry="5.4" fill="#fdf6f1" opacity="0.94" />
          <ellipse cx="58" cy="46.4" rx="3.4" ry="4.8" :fill="look.eyeColor" />
          <ellipse cx="58" cy="46.8" rx="1.6" ry="2.5" fill="#1a1320" />
          <circle cx="56.9" cy="44.2" r="1.3" fill="#fff" opacity="0.95" />
          <circle cx="59.2" cy="48.8" r="0.7" fill="#fff" opacity="0.55" />
          <path
            d="M53 43.4 Q58 40.2 63 43.2"
            stroke="#1d1526"
            stroke-width="1.5"
            fill="none"
            stroke-linecap="round"
          />
          <template v-if="look.gender === 'female'">
            <path d="M52.6 42.2 l-1.3 -1.5" stroke="#1d1526" stroke-width="1" stroke-linecap="round" />
            <path d="M63.4 42.2 l1.3 -1.5" stroke="#1d1526" stroke-width="1" stroke-linecap="round" />
          </template>
        </g>

        <!-- 眉毛 -->
        <path
          d="M37.6 38.4 Q42 36.4 46.4 37.9"
          :stroke="look.hairShade"
          :stroke-width="look.gender === 'male' ? 1.7 : 1.2"
          fill="none"
          stroke-linecap="round"
          opacity="0.9"
        />
        <path
          d="M53.6 37.9 Q58 36.4 62.4 38.4"
          :stroke="look.hairShade"
          :stroke-width="look.gender === 'male' ? 1.7 : 1.2"
          fill="none"
          stroke-linecap="round"
          opacity="0.9"
        />

        <!-- 鼻与嘴 -->
        <path
          d="M49.1 49.8 q1.5 1.7 0.2 2.4"
          :stroke="look.skinShade"
          stroke-width="0.9"
          fill="none"
          opacity="0.8"
          stroke-linecap="round"
        />
        <path
          d="M47 55.6 Q50 57.6 53 55.6"
          stroke="#b9605f"
          stroke-width="1.1"
          fill="none"
          stroke-linecap="round"
        />

        <!-- 侧发 -->
        <template v-if="hasSideLock">
          <path d="M33.6 36 C31.6 46 31.8 56 33.4 65 L37.6 64.6 C35.8 56 35.8 46 36.8 37.6 Z" :fill="look.hairColor" />
          <path d="M66.4 36 C68.4 46 68.2 56 66.6 65 L62.4 64.6 C64.2 56 64.2 46 63.2 37.6 Z" :fill="look.hairColor" />
        </template>

        <!-- 刘海 -->
        <path :d="bangs" :fill="`url(#rh-${uid})`" />

        <!-- 配饰 -->
        <template v-if="look.accessory === 'ribbon'">
          <path d="M62.6 28.6 l7.4 -3.2 l0.4 7.6 l-7 -1.2 Z" fill="#e8c07a" />
          <circle cx="62.8" cy="30.2" r="1.6" fill="#c99b45" />
        </template>
        <template v-else-if="look.accessory === 'clip'">
          <rect
            x="58.6"
            y="33.4"
            width="7.6"
            height="2.4"
            rx="1.2"
            fill="#e8c07a"
            transform="rotate(-24 62 34)"
          />
        </template>
        <template v-else-if="look.accessory === 'earring'">
          <circle cx="33.2" cy="52.4" r="1.5" fill="#e8c07a" />
          <circle cx="66.8" cy="52.4" r="1.5" fill="#e8c07a" />
        </template>
        <template v-else-if="look.accessory === 'glasses'">
          <circle cx="42" cy="46" r="7.2" fill="none" stroke="rgba(226,232,244,0.5)" stroke-width="1.1" />
          <circle cx="58" cy="46" r="7.2" fill="none" stroke="rgba(226,232,244,0.5)" stroke-width="1.1" />
          <path d="M49.2 45.4 h1.6" stroke="rgba(226,232,244,0.5)" stroke-width="1.1" />
          <path d="M34.8 44.6 l-2.4 -1" stroke="rgba(226,232,244,0.4)" stroke-width="1" />
          <path d="M65.2 44.6 l2.4 -1" stroke="rgba(226,232,244,0.4)" stroke-width="1" />
        </template>
      </g>
    </svg>
  </span>
</template>

<style scoped>
.role-avatar {
  display: inline-grid;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border-radius: 50%;
  background: #14101c;
  line-height: 0;
  vertical-align: middle;
}
.role-avatar--gold {
  box-shadow:
    0 0 0 1px rgba(232, 192, 122, 0.55),
    0 6px 16px rgba(0, 0, 0, 0.36);
}
.role-avatar--blood {
  box-shadow:
    0 0 0 1px rgba(212, 72, 58, 0.72),
    0 0 12px rgba(212, 72, 58, 0.24),
    0 6px 16px rgba(0, 0, 0, 0.36);
}
.role-avatar--none {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}
.role-avatar--dim {
  filter: grayscale(0.55) brightness(0.72);
}
.role-avatar svg {
  display: block;
}
</style>
