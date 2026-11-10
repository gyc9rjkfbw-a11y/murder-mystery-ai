<script setup lang="ts">
import { computed, ref } from 'vue'
import SheetModal from '@/components/SheetModal.vue'
import { useToast } from '@/composables/useToast'
import type { CustomScriptParseResult } from '@/services/customScripts'
import { TEMPLATES } from '@/services/templates'
import { useCustomScriptsStore } from '@/stores/customScripts'
import type { ScriptPackage } from '@/types/script'

const emit = defineEmits<{
  (e: 'start-solo', pkg: ScriptPackage): void
  (e: 'start-online', pkg: ScriptPackage): void
}>()

const store = useCustomScriptsStore()
const toast = useToast()
const fileInput = ref<HTMLInputElement | null>(null)
const pasteOpen = ref(false)
const pasteText = ref('')
const errors = ref<string[]>([])
const selectedId = ref(store.records[0]?.id ?? '')

const selected = computed(
  () => store.records.find((record) => record.id === selectedId.value) ?? store.records[0],
)

function accepted(result: CustomScriptParseResult): void {
  if (!result.ok || !result.pkg) {
    errors.value = result.errors
    toast.error('剧本未通过校验')
    return
  }
  errors.value = []
  selectedId.value = store.records[0]?.id ?? ''
  pasteText.value = ''
  pasteOpen.value = false
  toast.success('自定义剧本已保存')
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > 1_000_000) {
    errors.value = ['剧本文件超过 1 MB，请精简后再导入']
    toast.error('文件过大')
    return
  }
  accepted(store.addText(await file.text()))
}

function savePaste(): void {
  accepted(store.addText(pasteText.value))
}

function select(recordId: string): void {
  selectedId.value = recordId
  errors.value = []
}

function removeSelected(): void {
  const record = selected.value
  if (!record) return
  if (!window.confirm(`删除自定义剧本「${record.title}」？`)) return
  store.remove(record.id)
  selectedId.value = store.records[0]?.id ?? ''
  toast.info('已删除自定义剧本')
}

function downloadSample(): void {
  const sample = TEMPLATES[0].create(5)
  const blob = new Blob([JSON.stringify(sample, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = '迷案-自定义剧本模板.json'
  link.click()
  URL.revokeObjectURL(url)
  toast.success('已下载 5 人剧本模板')
}

function startSolo(): void {
  if (selected.value) emit('start-solo', selected.value.pkg)
}

function startOnline(): void {
  if (selected.value) emit('start-online', selected.value.pkg)
}

function dateText(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}
</script>

<template>
  <section class="card custom-scripts">
    <div class="custom-scripts__head">
      <div>
        <h3 class="card__title" style="margin-bottom: 4px">自定义剧本</h3>
        <p class="card__hint">导入完整 JSON 剧本，校验通过后可直接开局。</p>
      </div>
      <span class="tag tag--gold">{{ store.count }} 份</span>
    </div>

    <div class="custom-scripts__actions">
      <button class="mini-btn mini-btn--gold" @click="fileInput?.click()">导入 JSON</button>
      <button class="mini-btn" @click="pasteOpen = true">粘贴内容</button>
      <button class="mini-btn" @click="downloadSample">下载模板</button>
      <input ref="fileInput" class="custom-scripts__file" type="file" accept=".json,application/json" @change="onFile" />
    </div>

    <div v-if="errors.length" class="custom-scripts__errors">
      <strong>校验未通过</strong>
      <p v-for="error in errors.slice(0, 8)" :key="error">{{ error }}</p>
      <p v-if="errors.length > 8" class="tiny">另有 {{ errors.length - 8 }} 项错误未显示</p>
    </div>

    <div v-if="store.records.length === 0" class="custom-scripts__empty">
      <p>还没有自定义剧本。</p>
      <span>可以先下载模板，改完后重新导入。</span>
    </div>

    <template v-else>
      <div class="custom-scripts__list" role="listbox" aria-label="自定义剧本列表">
        <button
          v-for="record in store.records"
          :key="record.id"
          class="custom-script"
          :class="{ 'custom-script--on': selected?.id === record.id }"
          role="option"
          :aria-selected="selected?.id === record.id"
          @click="select(record.id)"
        >
          <span class="custom-script__main">
            <strong>{{ record.title }}</strong>
            <small>{{ record.playerCount }} 人 · {{ record.pkg.roles.length }} 个角色 · {{ dateText(record.updatedAt) }}</small>
          </span>
          <span class="tag">{{ record.pkg.game_config.theme === record.title ? '完整剧本' : '剧本包' }}</span>
        </button>
      </div>

      <div v-if="selected" class="custom-scripts__selected">
        <div>
          <span>当前选中</span>
          <strong>{{ selected.title }}</strong>
          <small>
            {{ selected.playerCount }} 人 ·
            {{ selected.pkg.clue_batches?.length ?? 0 }} 批线索 ·
            {{ selected.pkg.private_clues?.length ?? 0 }} 条私有线索
          </small>
        </div>
        <button class="mini-btn" @click="removeSelected">删除</button>
      </div>

      <div class="custom-scripts__start">
        <button class="btn btn--primary" @click="startOnline">用此剧本创建联机房间</button>
        <button class="btn btn--ghost" @click="startSolo">单人带 AI 开局</button>
      </div>
    </template>
  </section>

  <SheetModal :open="pasteOpen" title="粘贴自定义剧本 JSON" @close="pasteOpen = false">
    <p class="card__hint" style="margin-bottom: 10px">
      必须包含 game_config、global_truth、roles、凶手特权与线索。导入时会执行完整结构、人数和字数校验。
    </p>
    <textarea
      v-model="pasteText"
      class="textarea custom-scripts__paste"
      placeholder='{ "game_config": { ... } }'
      spellcheck="false"
    />
    <button class="btn btn--primary" :disabled="!pasteText.trim()" @click="savePaste">
      校验并保存
    </button>
  </SheetModal>
</template>
