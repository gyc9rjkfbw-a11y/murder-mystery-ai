export interface StoryParagraph {
  text: string
  sourceIndex: number
}

export interface StoryAct {
  id: string
  title: string
  subtitle: string
  paragraphs: StoryParagraph[]
  charCount: number
}

const BODY_ACTS = [
  { title: '第一幕 · 入戏', subtitle: '你是谁，此刻身在何处' },
  { title: '第二幕 · 暗潮', subtitle: '你为什么被卷进这场旧事' },
  { title: '第三幕 · 案发', subtitle: '案发前后，你看见了什么' },
  { title: '第四幕 · 人心', subtitle: '谁在说谎，你又要藏住什么' },
] as const

const RULE_ACT = {
  title: '终幕 · 守则',
  subtitle: '接下来的每一句话，都要守住你的秘密',
} as const

function charCount(paragraphs: StoryParagraph[]): number {
  return paragraphs.reduce((sum, paragraph) => sum + paragraph.text.replace(/\s/g, '').length, 0)
}

function isRule(text: string): boolean {
  return /^其[一二三四五六七八九十]/.test(text.trim())
}

function isHeading(text: string): boolean {
  return /^【.+】$/.test(text.trim())
}

function headingTitle(text: string): string {
  return text.trim().replace(/^【|】$/g, '').trim()
}

function makeAct(
  title: string,
  subtitle: string,
  paragraphs: StoryParagraph[],
  index: number,
): StoryAct {
  return {
    id: /守则|准则/.test(title) ? 'rules' : `act-${index + 1}`,
    title,
    subtitle,
    paragraphs,
    charCount: charCount(paragraphs),
  }
}

/** 优先读取剧本显式幕标题；旧剧本则按叙事顺序自动分组。 */
export function buildStoryActs(script: string): StoryAct[] {
  const source = script
    .split(/\n+/)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text, sourceIndex) => ({ text, sourceIndex }))

  if (source.length === 0) return []

  const firstHeading = source.findIndex((paragraph) => isHeading(paragraph.text))
  if (firstHeading >= 0) {
    const acts: StoryAct[] = []
    let currentTitle = ''
    let current: StoryParagraph[] = []
    const flush = () => {
      if (!currentTitle && current.length === 0) return
      const title = currentTitle || '序章 · 开场'
      acts.push(makeAct(title, '卷宗已经翻开，故事从这里开始', current, acts.length))
      current = []
    }

    for (let i = 0; i < source.length; i += 1) {
      const paragraph = source[i]
      if (isHeading(paragraph.text)) {
        flush()
        currentTitle = headingTitle(paragraph.text)
      } else {
        current.push(paragraph)
      }
    }
    flush()
    return acts.filter((act) => act.paragraphs.length > 0)
  }

  const rules = source.filter((paragraph) => isRule(paragraph.text))
  const body = source.filter((paragraph) => !isRule(paragraph.text))
  const acts: StoryAct[] = []

  if (body.length <= 4) {
    body.forEach((paragraph, index) => {
      const meta = BODY_ACTS[index] ?? BODY_ACTS[BODY_ACTS.length - 1]
      acts.push(makeAct(meta.title, meta.subtitle, [paragraph], index))
    })
  } else {
    const total = charCount(body)
    const targets = [0.22, 0.48, 0.75]
    let start = 0
    let cumulative = 0

    for (let actIndex = 0; actIndex < BODY_ACTS.length; actIndex += 1) {
      if (actIndex === BODY_ACTS.length - 1) {
        const paragraphs = body.slice(start)
        acts.push(makeAct(BODY_ACTS[actIndex].title, BODY_ACTS[actIndex].subtitle, paragraphs, actIndex))
        break
      }

      const target = total * targets[actIndex]
      let end = start
      while (end < body.length) {
        cumulative += charCount([body[end]])
        end += 1
        const remainingGroups = BODY_ACTS.length - actIndex - 1
        if (cumulative >= target && body.length - end >= remainingGroups) break
      }
      const paragraphs = body.slice(start, end)
      acts.push(makeAct(BODY_ACTS[actIndex].title, BODY_ACTS[actIndex].subtitle, paragraphs, actIndex))
      start = end
    }
  }

  if (rules.length > 0) {
    acts.push(makeAct(RULE_ACT.title, RULE_ACT.subtitle, rules, acts.length))
  }

  return acts
}
