<script setup lang="ts">
import { computed } from 'vue'
import { hideInstallHint, promptInstall, usePwa } from '@/services/pwa'
import { useToast } from '@/composables/useToast'

/**
 * 首页顶部那条「装到桌面」提示。
 * 只在真的能装（`ready`）或需要手动装（`manual`，iOS/安卓）时出现；
 * 点过「以后再说」就不再出现（设置页里始终留着手动入口）。
 */
const pwa = usePwa()
const toast = useToast()
const manual = computed(() => pwa.state.value === 'manual')

async function install() {
  const result = await promptInstall()
  if (result === 'accepted') toast.success('已添加到桌面，从图标打开就是全屏')
  else if (result === 'dismissed') toast.info('已取消')
  else toast.info('按设置页「安装到桌面」里的步骤手动添加')
}
</script>

<template>
  <div v-if="pwa.showHint.value" class="install-bar">
    <span class="install-bar__icon" aria-hidden="true">📲</span>
    <div class="install-bar__text">
      <b>装到桌面，全屏玩</b>
      <span class="tiny muted">没有地址栏，也不会手滑刷新丢局</span>
    </div>
    <button v-if="!manual" class="mini-btn mini-btn--gold" @click="install">安装</button>
    <button v-else class="mini-btn" @click="install">看步骤</button>
    <button class="install-bar__close" aria-label="以后再说" @click="hideInstallHint">✕</button>
  </div>
</template>

<style scoped>
.install-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 12px;
  padding: 10px 12px;
  border-radius: 14px;
  border: 1px solid rgba(216, 179, 106, 0.32);
  background: linear-gradient(135deg, rgba(216, 179, 106, 0.14), rgba(216, 179, 106, 0.04));
}
.install-bar__icon {
  font-size: 20px;
  line-height: 1;
}
.install-bar__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}
.install-bar__text b {
  font-weight: 600;
}
.mini-btn--gold {
  border-color: rgba(216, 179, 106, 0.5);
  color: var(--gold, #d8b36a);
}
.install-bar__close {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
}
.install-bar__close:active {
  background: rgba(255, 255, 255, 0.08);
}
</style>