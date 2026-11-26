import type { FeishuChatType } from '../types'

/**
 * Payload sent to the Orca Bot's `webhook.call` automation.
 * Deliberately excludes Feishu credentials, tenant tokens, and direct reply privileges:
 * the Bot correlates exclusively through opaque `request_id`.
 */
export interface BotDispatchPayload {
  request_id: string
  conversation_key: string
  chat_type: FeishuChatType
  message_id: string
  thread_id?: string
  sender_name: string
  target_bot: string
  text: string
  received_at: string
}

export interface BotDispatchOptions {
  webhookUrl?: string
}

export interface BotDispatchResult {
  accepted: boolean
  statusCode?: number
  attempts?: number
  error?: string
}

export interface BotDispatcher {
  dispatch(payload: BotDispatchPayload, options?: BotDispatchOptions): Promise<BotDispatchResult>
}

export const DEFAULT_WEBHOOK_RETRY_DELAYS_MS = [0, 600, 1800] as const

function sanitizeUrlFromText(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
}

/**
 * Extracts underlying `err.cause` details (such as ECONNRESET / ETIMEDOUT / AggregateError)
 * while stripping any embedded URLs so webhook URLs/keys are never leaked.
 */
export function formatErrorWithCause(err: unknown): string {
  const parts: string[] = []
  let current: unknown = err
  const seen = new Set<unknown>()

  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    if (seen.has(current)) break
    seen.add(current)

    if (typeof current === 'object') {
      const rec = current as {
        name?: unknown
        message?: unknown
        code?: unknown
        errno?: unknown
        syscall?: unknown
        cause?: unknown
        errors?: unknown
      }
      const tokens: string[] = []
      if (typeof rec.code === 'string' && rec.code) tokens.push(`code=${rec.code}`)
      if (typeof rec.syscall === 'string' && rec.syscall) tokens.push(`syscall=${rec.syscall}`)
      if (typeof rec.name === 'string' && rec.name && rec.name !== 'Error' && rec.name !== 'TypeError') {
        tokens.push(rec.name)
      }
      if (typeof rec.message === 'string' && rec.message.trim()) {
        tokens.push(sanitizeUrlFromText(rec.message.trim()))
      }
      if (Array.isArray(rec.errors) && rec.errors.length > 0) {
        const inner = rec.errors
          .slice(0, 3)
          .map((e) => formatErrorWithCause(e))
          .filter(Boolean)
        if (inner.length > 0) tokens.push(`[${inner.join('; ')}]`)
      }
      const label = tokens.join(' ')
      if (label && !parts.includes(label)) {
        parts.push(depth === 0 ? label : `cause: ${label}`)
      }
      current = rec.cause
    } else {
      const text = sanitizeUrlFromText(String(current).trim())
      if (text && !parts.includes(text)) {
        parts.push(depth === 0 ? text : `cause: ${text}`)
      }
      break
    }
  }

  return parts.join(' | ') || 'unknown error'
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    const maybeUnref = timer as unknown as { unref?: () => void }
    maybeUnref.unref?.()
  })
}

export class OrcaWebhookDispatcher implements BotDispatcher {
  private readonly getWebhookUrl: (targetBot?: string) => string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly retryDelaysMs: readonly number[]
  private readonly sleepImpl: (ms: number) => Promise<void>
  private readonly log: (msg: string) => void

  constructor(options: {
    getWebhookUrl: (targetBot?: string) => string
    fetchImpl?: typeof fetch
    timeoutMs?: number
    retryDelaysMs?: readonly number[]
    sleepImpl?: (ms: number) => Promise<void>
    log?: (msg: string) => void
  }) {
    this.getWebhookUrl = options.getWebhookUrl
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.retryDelaysMs =
      options.retryDelaysMs && options.retryDelaysMs.length > 0
        ? options.retryDelaysMs
        : DEFAULT_WEBHOOK_RETRY_DELAYS_MS
    this.sleepImpl = options.sleepImpl ?? defaultSleep
    this.log = options.log ?? (() => undefined)
  }

  async dispatch(
    payload: BotDispatchPayload,
    options?: BotDispatchOptions
  ): Promise<BotDispatchResult> {
    const webhookUrl = (options?.webhookUrl ?? this.getWebhookUrl(payload.target_bot)).trim()
    if (!webhookUrl) {
      return {
        accepted: false,
        attempts: 0,
        error: `目标 Bot (${payload.target_bot}) 的 Orca Webhook URL 未配置。请在插件设置中粘贴对应 Bot 自动化卡片的 Copy URL。`
      }
    }

    const totalAttempts = this.retryDelaysMs.length
    let lastStatusCode: number | undefined
    let lastError = 'unknown error'

    for (let index = 0; index < totalAttempts; index++) {
      const attempt = index + 1
      const delayMs = this.retryDelaysMs[index] ?? 0
      if (index > 0 && delayMs > 0) {
        await this.sleepImpl(delayMs)
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      const maybeUnref = timer as unknown as { unref?: () => void }
      maybeUnref.unref?.()

      try {
        const res = await this.fetchImpl(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Lark-Request-Id': payload.request_id,
            'X-Orca-Lark-Attempt': String(attempt)
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        })

        if (res.ok) {
          return { accepted: true, statusCode: res.status, attempts: attempt }
        }

        lastStatusCode = res.status
        const snippet = sanitizeUrlFromText((await res.text().catch(() => '')).slice(0, 200))
        lastError = `Orca Webhook 返回 HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`

        if (!isRetryableHttpStatus(res.status)) {
          this.log(
            `webhook dispatch non-retryable HTTP ${res.status} (bot=${payload.target_bot}, request_id=${payload.request_id}, attempt=${attempt}/${totalAttempts})`
          )
          return {
            accepted: false,
            statusCode: res.status,
            attempts: attempt,
            error: lastError
          }
        }

        this.log(
          `webhook dispatch retryable HTTP ${res.status} (bot=${payload.target_bot}, request_id=${payload.request_id}, attempt=${attempt}/${totalAttempts})`
        )
      } catch (err) {
        lastStatusCode = undefined
        const detail = formatErrorWithCause(err)
        lastError = `调用 Orca Webhook 失败: ${detail}`
        this.log(
          `webhook dispatch network error (bot=${payload.target_bot}, request_id=${payload.request_id}, attempt=${attempt}/${totalAttempts}): ${detail}`
        )
      } finally {
        clearTimeout(timer)
      }
    }

    return {
      accepted: false,
      statusCode: lastStatusCode,
      attempts: totalAttempts,
      error: `${lastError}（已重试 ${totalAttempts} 次）`
    }
  }
}
