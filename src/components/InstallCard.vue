<script setup lang="ts">
import { computed, ref } from 'vue'
import { useToast } from '@/composables/useToast'
import { promptInstall, usePwa } from '@/services/pwa'

/**
 * 「安装到桌面」卡片（设置页）
 * 三种人看到三种话：
 *   · 已经装了 → 告诉他们现在就是全屏、怎么退出；
 *   · 能装 → 一个按钮直接调起系统安装框；
 *   · 不能装（iOS / http 局域网）→ 给可照做的手动步骤，别让人一脸问号。
 */
const pwa = usePwa()
const toast = useToast()
const busy = ref(false)

const isReady = computed(() => pwa.state.value === 'ready')
const isInstalled = computed(() => pwa.state.value === 'installed')
const isInsecure = computed(() => pwa.state.value === 'insecure')
const isIosDevice = computed(() => pwa.isIos())
/** 模板里不能直接用 location，这里取一次 */
const host = `${location.protocol}//${location.host}`

const steps = computed<string[]>(() => {
  if (isIosDevice.value) {
    return [
      '点浏览器底部的「分享」按钮（方框 + 向上箭头）',
      '选「添加到主屏幕」，名字保持「谜案剧本杀」',
      '之后从桌面图标打开：全屏、没有地址栏',
    ]
  }
  return [
    '点浏览器右上角「⋮」菜单',
    '选「安装应用」或「添加到主屏幕」',
    '之后从桌面图标打开：全屏、没有地址栏',
  ]
})

async function install() {
  busy.value = true
  const result = await promptInstall()
  busy.value = false
  if (result === 'accepted') toast.success('已添加到桌面')
  else if (result === 'dismissed') toast.info('已取消，随时可以在这里再装')
  else toast.warn('这个浏览器没有给出安装入口，按下面的步骤手动添加')
}
</script>

<template>
  <section class="card">
    <h3 class="card__title">安装到桌面</h3>

    <template v-if="isInstalled">
      <p class="card__hint" style="margin: 0 0 10px">
        <span class="ok">✓ 正在以独立窗口运行</span>（全屏、没有地址栏）。
        想回到浏览器版本：关掉这个窗口，用原地址重新打开即可。
      </p>
      <p class="tiny muted" style="margin: 0; line-height: 1.7">
        桌面图标就是入口；战绩与档案跟着设备走，删掉图标不会丢档案。
      </p>
    </template>

    <template v-else-if="isInsecure">
      <p class="card__hint" style="margin: 0 0 10px">
        这个地址装不了：浏览器只在 <b>https</b> 或 <b>localhost</b> 下允许安装。
        现在用的是 <code>{{ host }}</code>。
      </p>
      <p class="tiny muted" style="margin: 0 0 10px; line-height: 1.7">
        两个办法：① 用隧道地址（<code>pnpm tunnel</code> 给的 https 链接）；
        ② 局域网自签证书（<code>pnpm cert</code> 然后 <code>pnpm server:tls</code>，
        手机装一次证书）。<br />
        <b>iPhone 例外</b>：Safari 的「添加到主屏幕」不受 https 限制，
        用它打开现在是独立窗口，只是没有离线能力。
      </p>
      <ul class="steps">
        <li v-for="s in steps" :key="s">{{ s }}</li>
      </ul>
    </template>

    <template v-else>
      <p class="card__hint" style="margin: 0 0 12px">
        把「谜案剧本杀」装到桌面：从图标打开就是全屏、没有地址栏，也不会误触刷新丢局。
      </p>
      <button v-if="isReady" class="btn btn--primary" :disabled="busy" @click="install">
        {{ busy ? '正在唤起安装…' : '添加到桌面' }}
      </button>
      <template v-else>
        <ol class="steps">
          <li v-for="s in steps" :key="s">{{ s }}</li>
        </ol>
        <p class="tiny muted" style="margin: 8px 0 0">
          没看到「添加到主屏幕」：先把这一局打完（进行中的对局不适合换窗口），
          或者换 Chrome / Safari 再试。
        </p>
      </template>
    </template>
  </section>
</template>

<style scoped>
.ok {
  color: #7ed957;
}
.steps {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.9;
  color: var(--muted);
}
code {
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 5px;
  border-radius: 5px;
  font-size: 12px;
}
</style>