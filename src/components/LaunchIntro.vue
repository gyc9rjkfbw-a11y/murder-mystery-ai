<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import BrandMark from '@/components/BrandMark.vue'
import {
  markLaunchIntroSeen,
  prefersReducedMotion,
  shouldPlayLaunchIntro,
} from '@/services/launchExperience'

const visible = ref(shouldPlayLaunchIntro(undefined, prefersReducedMotion()))
const leaving = ref(false)
let leaveTimer = 0
let removeTimer = 0

function finish(): void {
  if (!visible.value || leaving.value) return
  leaving.value = true
  window.clearTimeout(removeTimer)
  removeTimer = window.setTimeout(() => {
    visible.value = false
  }, 320)
}

onMounted(() => {
  if (!visible.value) return
  markLaunchIntroSeen()
  leaveTimer = window.setTimeout(finish, 1280)
})

onBeforeUnmount(() => {
  window.clearTimeout(leaveTimer)
  window.clearTimeout(removeTimer)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="launch-end">
      <div
        v-if="visible"
        class="launch-intro"
        :class="{ 'launch-intro--leaving': leaving }"
        aria-hidden="true"
        @click="finish"
      >
        <div class="launch-intro__mist" />
        <div class="launch-intro__stage">
          <div class="launch-intro__eyebrow">AN AI MURDER MYSTERY</div>
          <BrandMark class="launch-intro__mark" animated />
          <h1 class="launch-intro__title">迷案</h1>
          <p class="launch-intro__tagline">NO BODY, NO TRUTH</p>
          <div class="launch-intro__rule"><span /></div>
          <p class="launch-intro__loading">正在展开卷宗</p>
        </div>
        <span class="launch-intro__skip">轻触跳过</span>
      </div>
    </Transition>
  </Teleport>
</template>
