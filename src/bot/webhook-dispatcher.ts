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

export interface BotDispatchResult {
  accepted: boolean
  statusCode?: number
  error?: string
}

export interface BotDispatcher {
  dispatch(payload: BotDispatchPayload): Promise<BotDispatchResult>
}

export class OrcaWebhookDispatcher implements BotDispatcher {
  private readonly getWebhookUrl: () => string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: {
    getWebhookUrl: () => string
    fetchImpl?: typeof fetch
    timeoutMs?: number
  }) {
    this.getWebhookUrl = options.getWebhookUrl
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  async dispatch(payload: BotDispatchPayload): Promise<BotDispatchResult> {
    const webhookUrl = this.getWebhookUrl().trim()
    if (!webhookUrl) {
      return {
        accepted: false,
        error: 'Orca Bot Webhook URL 未配置。请在插件设置中粘贴 Bot 自动化卡片的 Copy URL。'
      }
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
          'X-Orca-Lark-Request-Id': payload.request_id
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      })
      if (!res.ok) {
        const snippet = (await res.text().catch(() => '')).slice(0, 240)
        return {
          accepted: false,
          statusCode: res.status,
          error: `Orca Webhook 返回 HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`
        }
      }
      return { accepted: true, statusCode: res.status }
    } catch (err) {
      return {
        accepted: false,
        error: `调用 Orca Webhook 失败: ${err instanceof Error ? err.message : String(err)}`
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
