<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppTopBar from '@/components/AppTopBar.vue'
import InstallCard from '@/components/InstallCard.vue'
import ProfileCard from '@/components/ProfileCard.vue'
import SheetModal from '@/components/SheetModal.vue'
import { useToast } from '@/composables/useToast'
import { testConnection, type AiProvider } from '@/services/aiEngine'
import {
  loadScriptHistory,
  persistScriptHistory,
  type ScriptHistoryStorage,
} from '@/services/scriptHistory'
import { SYSTEM_PROMPT } from '@/services/systemPrompt'
import { useSettingsStore } from '@/stores/settings'

const settings = useSettingsStore()
const toast = useToast()
const testing = ref(false)
const testResult = ref('')
const promptOpen = ref(false)
const historyCount = ref(0)
const ai = computed(() => settings.state.ai)

const providers: { key: AiProvider; title: string; desc: string }[] = [
  {
    key: 'offline',
    title: '离线模拟引擎',
    desc: '内置剧本库，无需联网和密钥，适合快速试玩。',
  },
  {
    key: 'openai',
    title: '真实 AI 引擎',
    desc: 'DeepSeek、通义千问、Kimi 或任意 OpenAI 兼容接口。',
  },
]

const presets = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  {
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  { label: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { label: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b' },
]

function scriptHistoryStorage(): ScriptHistoryStorage {
  return localStorage
}

function refreshHistoryCount(): void {
  try {
    historyCount.value = loadScriptHistory(scriptHistoryStorage()).length
  } catch {
    historyCount.value = 0
  }
}

function clearScriptHistory(): void {
  if (!window.confirm('清空最近剧本记录？清空后，相同案件可能再次被生成。')) return
  try {
    persistScriptHistory(scriptHistoryStorage(), [])
    refreshHistoryCount()
    toast.info('最近剧本记录已清空')
  } catch {
    toast.error('无法清除本地剧本记录')
  }
}

function applyPreset(preset: (typeof presets)[number]): void {
  ai.value.baseUrl = preset.baseUrl
  ai.value.model = preset.model
  toast.info(`已填入 ${preset.label}`)
}

async function runTest(): Promise<void> {
  testing.value = true
  testResult.value = ''
  const result = await testConnection({ ...ai.value })
  testResult.value = result.message
  testing.value = false
  if (result.ok) toast.success('连接正常')
  else toast.error('连接失败')
}

function setPlayerCount(value: 4 | 5 | 6): void {
  settings.state.defaultPlayerCount = value
}

onMounted(refreshHistoryCount)
</script>

<template>
  <AppTopBar title="游戏设置" sub="偏好、档案与高级选项" show-back />

  <main class="page settings-page">
    <ProfileCard />

    <p class="settings-section-title">游戏偏好</p>
    <section class="settings-menu">
      <div class="settings-row">
        <div class="settings-row__copy">
          <strong>默认玩家人数</strong>
          <span>新建游戏时自动使用</span>
        </div>
        <div class="settings-seg">
          <button
            v-for="count in [4, 5, 6]"
            :key="count"
            :class="{ 'settings-seg__btn--on': settings.state.defaultPlayerCount === count }"
            @click="setPlayerCount(count as 4 | 5 | 6)"
          >
            {{ count }} 人
          </button>
        </div>
      </div>

      <div class="settings-row">
        <div class="settings-row__copy">
          <strong>动画效果</strong>
          <span>关闭后会减少启动、页面和卡牌动效</span>
        </div>
        <div class="settings-seg">
          <button
            :class="{ 'settings-seg__btn--on': settings.state.motion === 'system' }"
            @click="settings.state.motion = 'system'"
          >
            跟随系统
          </button>
          <button
            :class="{ 'settings-seg__btn--on': settings.state.motion === 'reduced' }"
            @click="settings.state.motion = 'reduced'"
          >
            精简
          </button>
        </div>
      </div>

      <div class="settings-row">
        <div class="settings-row__copy">
          <strong>剧本字号</strong>
          <span>调整阅读页正文大小</span>
        </div>
        <div class="settings-seg">
          <button
            :class="{ 'settings-seg__btn--on': settings.state.readingFontSize === 'normal' }"
            @click="settings.state.readingFontSize = 'normal'"
          >
            标准
          </button>
          <button
            :class="{ 'settings-seg__btn--on': settings.state.readingFontSize === 'large' }"
            @click="settings.state.readingFontSize = 'large'"
          >
            大号
          </button>
        </div>
      </div>
    </section>

    <p class="settings-section-title">设备与应用</p>
    <InstallCard />

    <details class="settings-advanced">
      <summary>
        <span>高级设置</span>
        <small>AI 引擎、剧本查重与调试</small>
      </summary>
      <div class="settings-advanced__body">
        <section class="card">
          <h3 class="card__title">剧本生成引擎</h3>
          <button
            v-for="provider in providers"
            :key="provider.key"
            class="theme"
            style="width: 100%; text-align: left; margin-bottom: 10px"
            :class="{ 'theme--on': ai.provider === provider.key }"
            @click="settings.setProvider(provider.key)"
          >
            <div style="display: flex; align-items: center; gap: 8px">
              <span style="font-size: 14px; font-weight: 600">{{ provider.title }}</span>
              <span
                v-if="ai.provider === provider.key"
                class="tag tag--gold"
                style="margin-left: auto"
              >
                使用中
              </span>
            </div>
            <div class="tiny muted" style="margin-top: 6px">{{ provider.desc }}</div>
          </button>
          <p class="card__hint">当前：{{ settings.providerLabel }}</p>
        </section>

        <section v-if="ai.provider === 'openai'" class="card">
          <h3 class="card__title">接口配置</h3>
          <p
            v-if="!String(ai.apiKey ?? '').trim()"
            class="small"
            style="margin: 0 0 12px; color: #ef8a7c"
          >
            尚未填写 API Key，真实 AI 生成会失败。
          </p>
          <div class="field">
            <label class="field__label">快速填充</label>
            <div style="display: flex; flex-wrap: wrap; gap: 8px">
              <button
                v-for="preset in presets"
                :key="preset.label"
                class="mini-btn"
                @click="applyPreset(preset)"
              >
                {{ preset.label }}
              </button>
            </div>
          </div>
          <div class="field">
            <label class="field__label">Base URL</label>
            <input v-model="ai.baseUrl" class="input" placeholder="https://api.deepseek.com/v1" />
          </div>
          <div class="field">
            <label class="field__label">API Key</label>
            <input v-model="ai.apiKey" class="input" type="password" placeholder="sk-..." />
            <p class="tiny muted" style="margin: 6px 0 0">密钥只保存在本机浏览器。</p>
          </div>
          <div class="field">
            <label class="field__label">模型名</label>
            <input v-model="ai.model" class="input" placeholder="deepseek-chat" />
          </div>
          <div class="field">
            <label class="field__label">温度 {{ ai.temperature.toFixed(1) }}</label>
            <input
              v-model.number="ai.temperature"
              class="input"
              type="range"
              min="0"
              max="2"
              step="0.1"
            />
          </div>
          <div class="field">
            <label class="field__label">单次最大输出 Token</label>
            <input
              v-model.number="ai.maxTokens"
              class="input"
              type="number"
              min="1024"
              max="32768"
              step="512"
            />
            <p class="tiny muted" style="margin: 6px 0 0">长剧本逐角色生成，建议至少 8192。</p>
          </div>
          <div class="btn-row">
            <button class="btn" :disabled="testing" @click="runTest">
              {{ testing ? '测试中…' : '测试连接' }}
            </button>
            <button class="btn btn--ghost" @click="promptOpen = true">查看系统指令</button>
          </div>
          <p
            v-if="testResult"
            class="small"
            style="margin: 10px 0 0"
            :class="testResult.includes('成功') ? 'gold' : 'blood'"
          >
            {{ testResult }}
          </p>
        </section>

        <section class="card card--flat">
          <div class="list-row">
            <div>
              <div style="font-size: 14px">AI 剧本防重复</div>
              <div class="tiny muted">最近记录 {{ historyCount }} 局</div>
            </div>
            <button class="mini-btn" :disabled="historyCount === 0" @click="clearScriptHistory">
              清空记录
            </button>
          </div>
          <div class="list-row" @click="settings.state.demoMode = !settings.state.demoMode">
            <div>
              <div style="font-size: 14px">单人演示模式</div>
              <div class="tiny muted">可查看全部剧本与凶手特权</div>
            </div>
            <span class="tag" :class="settings.state.demoMode ? 'tag--gold' : ''">
              {{ settings.state.demoMode ? '已开启' : '已关闭' }}
            </span>
          </div>
        </section>

        <section class="card card--flat">
          <button class="btn btn--ghost" @click="settings.reset()">恢复默认设置</button>
        </section>
      </div>
    </details>

    <p class="tiny muted center settings-version">
      迷案 · AI 剧本杀 v0.1.0<br />
      Vue 3 + Vite + TypeScript
    </p>
  </main>

  <SheetModal :open="promptOpen" title="剧本杀 AI 游戏引擎系统指令" @close="promptOpen = false">
    <pre class="tiny settings-prompt">{{ SYSTEM_PROMPT }}</pre>
  </SheetModal>
</template>
