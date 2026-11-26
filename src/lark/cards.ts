import type { ProgressEntry } from '../types'

export type CardStage = 'received' | 'processing' | 'completed' | 'failed' | 'timeout'

export interface BuildProgressCardParams {
  stage: CardStage
  botName: string
  requestId: string
  promptPreview: string
  progressHistory?: readonly ProgressEntry[]
  finalAnswer?: string
  errorMessage?: string
}

const STAGE_META: Record<CardStage, { title: string; template: string; badge: string }> = {
  received: {
    title: '已收到请求',
    template: 'wathet',
    badge: 'QUEUED'
  },
  processing: {
    title: '正在处理中',
    template: 'blue',
    badge: 'WORKING'
  },
  completed: {
    title: '处理完成',
    template: 'green',
    badge: 'DONE'
  },
  failed: {
    title: '处理失败',
    template: 'red',
    badge: 'FAILED'
  },
  timeout: {
    title: '处理超时',
    template: 'orange',
    badge: 'TIMEOUT'
  }
}

function truncate(text: string, maxLen: number): string {
  const clean = text.trim()
  if (clean.length <= maxLen) return clean
  return `${clean.slice(0, maxLen - 1)}…`
}

/**
 * Builds a Feishu Interactive Card (JSON 2.0) for each stage of the Bot request lifecycle.
 */
export function buildStageCard(params: BuildProgressCardParams): Record<string, unknown> {
  const meta = STAGE_META[params.stage]
  const elements: Record<string, unknown>[] = []

  if (params.stage === 'received') {
    elements.push({
      tag: 'markdown',
      content: `**${params.botName}** 已接收请求，正在派发处理…\n> ${truncate(params.promptPreview, 180)}`
    })
  } else if (params.stage === 'processing') {
    const recentSteps = (params.progressHistory ?? []).slice(-5)
    const lines =
      recentSteps.length > 0
        ? recentSteps.map((entry) =>
            entry.stage ? `- **${entry.stage}**：${entry.text}` : `- ${entry.text}`
          )
        : [`- 已交由 **${params.botName}** 推进中，等待阶段汇报…`]
    elements.push({
      tag: 'markdown',
      content: `**当前进展**\n${lines.join('\n')}`
    })
  } else if (params.stage === 'completed') {
    const answer = params.finalAnswer?.trim() || '（Bot 已完成处理，但未返回正文）'
    elements.push({
      tag: 'markdown',
      content: truncate(answer, 12000)
    })
  } else if (params.stage === 'timeout') {
    elements.push({
      tag: 'markdown',
      content:
        params.errorMessage?.trim() ||
        `等待 **${params.botName}** 回传结果超时。可在 Orca 中检查对应自动化运行记录，或重新发送消息重试。`
    })
  } else {
    elements.push({
      tag: 'markdown',
      content: `**执行出错**：${truncate(params.errorMessage?.trim() || '未知错误', 2000)}`
    })
  }

  elements.push({
    tag: 'hr'
  })
  elements.push({
    tag: 'markdown',
    content: `<font color="grey">Bot: ${params.botName} · Request: \`${params.requestId}\` · Status: ${meta.badge}</font>`
  })

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true
    },
    header: {
      template: meta.template,
      title: {
        tag: 'plain_text',
        content: `${params.botName} · ${meta.title}`
      }
    },
    body: {
      elements
    }
  }
}
