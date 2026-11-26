import {
  FRAME_METHOD_CONTROL,
  FRAME_METHOD_DATA,
  FrameFragmentAssembler,
  getFrameHeader,
  marshalPbbp2Frame,
  unmarshalPbbp2Frame,
  type Pbbp2Frame
} from './pbbp2-frame'
import type {
  LarkBotInfo,
  LarkIncomingMessage,
  LarkMention,
  LarkMessageHandler,
  LarkReplyResult,
  LarkStatusHandler,
  LarkTransport,
  LarkTransportStatus
} from './types'

export interface FeishuDirectTransportOptions {
  appId: string
  appSecret: string
  domain: string
  log?: (msg: string) => void
  fetchImpl?: typeof fetch
}

interface TenantTokenCache {
  token: string
  expiresAt: number
}

interface WsClientConfig {
  ReconnectCount?: number
  ReconnectInterval?: number
  ReconnectNonce?: number
  PingInterval?: number
}

interface FeishuEventEnvelope {
  schema?: string
  header?: {
    event_id?: string
    event_type?: string
    create_time?: string
    tenant_key?: string
    app_id?: string
  }
  event?: {
    sender?: {
      sender_id?: {
        open_id?: string
        union_id?: string
        user_id?: string
      }
      sender_type?: string
    }
    message?: {
      message_id?: string
      root_id?: string
      parent_id?: string
      thread_id?: string
      create_time?: string
      chat_id?: string
      chat_type?: string
      message_type?: string
      content?: string
      mentions?: Array<{
        key?: string
        id?: { open_id?: string }
        name?: string
      }>
    }
  }
}

const DEFAULT_PING_INTERVAL_MS = 120_000
const MIN_BACKOFF_MS = 2_000
const MAX_BACKOFF_MS = 60_000

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function extractPlainTextFromFeishuContent(messageType: string, rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent) as Record<string, unknown>
    if (messageType === 'text' && typeof parsed.text === 'string') {
      return parsed.text
    }
    if (messageType === 'post') {
      const chunks: string[] = []
      const title = typeof parsed.title === 'string' ? parsed.title : ''
      if (title) chunks.push(title)
      const content = Array.isArray(parsed.content) ? parsed.content : []
      for (const line of content) {
        if (!Array.isArray(line)) continue
        const lineText: string[] = []
        for (const node of line) {
          if (typeof node !== 'object' || node === null) continue
          const rec = node as Record<string, unknown>
          if (rec.tag === 'text' && typeof rec.text === 'string') {
            lineText.push(rec.text)
          } else if (rec.tag === 'at') {
            const name = typeof rec.user_name === 'string' ? rec.user_name : 'user'
            lineText.push(`@${name}`)
          } else if (rec.tag === 'a' && typeof rec.text === 'string') {
            lineText.push(rec.text)
          }
        }
        if (lineText.length > 0) chunks.push(lineText.join(''))
      }
      return chunks.join('\n').trim()
    }
  } catch {
    // Fallback to raw content when payload is plain text or malformed JSON.
  }
  return rawContent
}

export function parseFeishuReceiveEvent(rawPayload: Uint8Array | string): LarkIncomingMessage | null {
  const jsonText = typeof rawPayload === 'string' ? rawPayload : textDecoder.decode(rawPayload)
  let envelope: FeishuEventEnvelope
  try {
    envelope = JSON.parse(jsonText) as FeishuEventEnvelope
  } catch {
    return null
  }
  if (envelope.header?.event_type !== 'im.message.receive_v1') {
    return null
  }
  const msg = envelope.event?.message
  const sender = envelope.event?.sender
  if (!msg?.message_id || !msg.chat_id) {
    return null
  }
  const chatType = msg.chat_type === 'p2p' ? 'p2p' : 'group'
  const rawContent = msg.content ?? ''
  const messageType = msg.message_type ?? 'text'
  const mentions: LarkMention[] = (msg.mentions ?? []).map((m) => ({
    key: m.key ?? '',
    openId: m.id?.open_id,
    name: m.name
  }))
  const parsedTime = Number(msg.create_time ?? envelope.header?.create_time ?? Date.now())
  return {
    eventId: envelope.header?.event_id,
    messageId: msg.message_id,
    chatId: msg.chat_id,
    chatType,
    rootId: msg.root_id || undefined,
    parentId: msg.parent_id || undefined,
    threadId: msg.thread_id || undefined,
    senderOpenId: sender?.sender_id?.open_id ?? '',
    senderType: sender?.sender_type ?? 'user',
    messageType,
    rawContent,
    text: extractPlainTextFromFeishuContent(messageType, rawContent),
    mentions,
    createTimeMs: Number.isFinite(parsedTime) ? parsedTime : Date.now()
  }
}

/**
 * Zero-dependency Feishu Open Platform transport speaking the official `/callback/ws/endpoint`
 * persistent WebSocket (`pbbp2.Frame`) protocol plus IM v1 OpenAPI REST endpoints.
 */
export class FeishuDirectTransport implements LarkTransport {
  readonly kind = 'direct' as const
  private readonly appId: string
  private readonly appSecret: string
  private readonly domain: string
  private readonly log: (msg: string) => void
  private readonly fetchImpl: typeof fetch

  private tokenCache: TenantTokenCache | null = null
  private botInfo: LarkBotInfo = {}
  private status: LarkTransportStatus
  private onMessage?: LarkMessageHandler
  private onStatus?: LarkStatusHandler
  private running = false
  private ws: WebSocket | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingIntervalMs = DEFAULT_PING_INTERVAL_MS
  private backoffMs = MIN_BACKOFF_MS
  private readonly assembler = new FrameFragmentAssembler()

  constructor(options: FeishuDirectTransportOptions) {
    this.appId = options.appId
    this.appSecret = options.appSecret
    this.domain = options.domain.replace(/\/+$/, '')
    this.log = options.log ?? (() => undefined)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.status = {
      state: 'offline',
      since: Date.now(),
      transportKind: 'direct'
    }
  }

  getStatus(): LarkTransportStatus {
    return { ...this.status }
  }

  private setStatus(next: Partial<LarkTransportStatus>): void {
    this.status = {
      ...this.status,
      ...next,
      transportKind: 'direct',
      botOpenId: this.botInfo.openId ?? this.status.botOpenId,
      botName: this.botInfo.appName ?? this.status.botName
    }
    this.onStatus?.(this.getStatus())
  }

  async start(onMessage: LarkMessageHandler, onStatus?: LarkStatusHandler): Promise<void> {
    this.onMessage = onMessage
    this.onStatus = onStatus
    if (this.running) return
    this.running = true
    this.backoffMs = MIN_BACKOFF_MS
    this.setStatus({ state: 'connecting', since: Date.now(), error: undefined })

    // Best-effort fetch bot info so group @bot checks know exact bot open_id.
    try {
      this.botInfo = await this.fetchBotInfo()
    } catch (err) {
      this.log(`feishu bot info warning: ${err instanceof Error ? err.message : String(err)}`)
    }

    await this.connectOnce()
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'shutdown')
      } catch {
        // Ignore close errors during shutdown.
      }
      this.ws = null
    }
    this.setStatus({ state: 'offline', since: Date.now(), error: undefined })
  }

  private async connectOnce(): Promise<void> {
    if (!this.running) return
    try {
      const { url, config } = await this.fetchWsEndpoint()
      if (config?.PingInterval && config.PingInterval > 0) {
        this.pingIntervalMs = config.PingInterval * 1000
      }
      const parsed = new URL(url)
      const serviceId = Number(parsed.searchParams.get('service_id') ?? '0') || 0

      if (typeof WebSocket !== 'function') {
        throw new Error('Global WebSocket is unavailable in this Node runtime')
      }

      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      this.ws = ws

      ws.addEventListener('open', () => {
        if (!this.running || this.ws !== ws) return
        this.backoffMs = MIN_BACKOFF_MS
        this.setStatus({ state: 'connected', since: Date.now(), error: undefined })
        this.log('feishu ws connected')
        this.startPingLoop(ws, serviceId)
      })

      ws.addEventListener('message', (event) => {
        if (!this.running || this.ws !== ws) return
        void this.handleWsMessage(ws, event.data)
      })

      ws.addEventListener('close', () => {
        if (this.ws === ws) {
          this.ws = null
        }
        if (this.pingTimer) {
          clearInterval(this.pingTimer)
          this.pingTimer = null
        }
        if (this.running) {
          this.scheduleReconnect('WebSocket connection closed')
        }
      })

      ws.addEventListener('error', () => {
        if (this.running) {
          this.setStatus({ state: 'error', since: Date.now(), error: 'WebSocket transport error' })
        }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.scheduleReconnect(msg)
    }
  }

  private scheduleReconnect(reason: string): void {
    if (!this.running) return
    this.setStatus({ state: 'error', since: Date.now(), error: reason })
    this.log(`feishu ws reconnecting in ${this.backoffMs}ms: ${reason}`)
    const jitter = Math.floor(Math.random() * 1000)
    const delay = this.backoffMs + jitter
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.setStatus({ state: 'connecting', since: Date.now() })
      void this.connectOnce()
    }, delay)
    const maybeUnref = this.reconnectTimer as unknown as { unref?: () => void }
    maybeUnref.unref?.()
  }

  private startPingLoop(ws: WebSocket, serviceId: number): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    const sendPing = (): void => {
      if (ws.readyState !== WebSocket.OPEN) return
      const pingFrame: Pbbp2Frame = {
        seqId: 0n,
        logId: 0n,
        service: serviceId,
        method: FRAME_METHOD_CONTROL,
        headers: [{ key: 'type', value: 'ping' }],
        payloadEncoding: '',
        payloadType: '',
        logIdNew: ''
      }
      ws.send(marshalPbbp2Frame(pingFrame))
      this.assembler.sweep(Date.now())
    }
    sendPing()
    this.pingTimer = setInterval(sendPing, this.pingIntervalMs)
    const maybeUnref = this.pingTimer as unknown as { unref?: () => void }
    maybeUnref.unref?.()
  }

  private async handleWsMessage(ws: WebSocket, data: unknown): Promise<void> {
    let bytes: Uint8Array
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data)
    } else if (data instanceof Uint8Array) {
      bytes = data
    } else {
      return
    }
    const frame = unmarshalPbbp2Frame(bytes)
    if (!frame) return

    if (frame.method === FRAME_METHOD_CONTROL) {
      if (getFrameHeader(frame, 'type') === 'pong' && frame.payload && frame.payload.length > 0) {
        try {
          const cfg = JSON.parse(textDecoder.decode(frame.payload)) as WsClientConfig
          if (cfg.PingInterval && cfg.PingInterval > 0) {
            this.pingIntervalMs = cfg.PingInterval * 1000
          }
        } catch {
          // Ignore malformed pong config.
        }
      }
      return
    }

    if (frame.method !== FRAME_METHOD_DATA) return

    const sum = Number(getFrameHeader(frame, 'sum') || '1') || 1
    const seq = Number(getFrameHeader(frame, 'seq') || '0') || 0
    const frameMsgId = getFrameHeader(frame, 'message_id')
    const rawPayload = frame.payload ?? new Uint8Array()
    const payload =
      sum > 1 ? this.assembler.push(frameMsgId, sum, seq, rawPayload, Date.now()) : rawPayload
    if (!payload) return

    const frameType = getFrameHeader(frame, 'type')
    if (frameType !== 'event' && frameType !== 'card') return

    const startMs = Date.now()
    this.setStatus({ lastEventAt: startMs })

    // Acknowledge immediately within Feishu's 3-second window so events are not redelivered,
    // while dispatching async bridge processing in the background.
    const ackBytes = textEncoder.encode(JSON.stringify({ code: 200, headers: null, data: null }))
    const ackFrame: Pbbp2Frame = {
      ...frame,
      headers: [...frame.headers, { key: 'biz_rt', value: String(Date.now() - startMs) }],
      payload: ackBytes
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(marshalPbbp2Frame(ackFrame))
    }

    if (frameType === 'event' && this.onMessage) {
      const parsed = parseFeishuReceiveEvent(payload)
      if (parsed) {
        try {
          await this.onMessage(parsed)
        } catch (err) {
          this.log(`feishu message handler error: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }

  private async fetchWsEndpoint(): Promise<{ url: string; config?: WsClientConfig }> {
    const res = await this.fetchImpl(`${this.domain}/callback/ws/endpoint`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        locale: 'zh'
      },
      body: JSON.stringify({ AppID: this.appId, AppSecret: this.appSecret })
    })
    const body = (await res.json()) as {
      code?: number
      msg?: string
      data?: { URL?: string; ClientConfig?: WsClientConfig }
    }
    if (!res.ok || body.code !== 0 || !body.data?.URL) {
      throw new Error(`Feishu ws/endpoint failed (HTTP ${res.status}, code=${body.code}): ${body.msg ?? 'unknown'}`)
    }
    return { url: body.data.URL, config: body.data.ClientConfig }
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now()
    if (this.tokenCache && now < this.tokenCache.expiresAt - 60_000) {
      return this.tokenCache.token
    }
    const res = await this.fetchImpl(
      `${this.domain}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret })
      }
    )
    const body = (await res.json()) as {
      code?: number
      msg?: string
      tenant_access_token?: string
      expire?: number
    }
    if (!res.ok || body.code !== 0 || !body.tenant_access_token) {
      throw new Error(
        `Feishu tenant_access_token failed (HTTP ${res.status}, code=${body.code}): ${body.msg ?? 'unknown'}`
      )
    }
    this.tokenCache = {
      token: body.tenant_access_token,
      expiresAt: now + (body.expire ?? 7200) * 1000
    }
    return this.tokenCache.token
  }

  private async apiRequest<T>(
    method: string,
    path: string,
    payload?: Record<string, unknown>
  ): Promise<T> {
    const token = await this.getTenantAccessToken()
    const res = await this.fetchImpl(`${this.domain}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: payload ? JSON.stringify(payload) : undefined
    })
    const body = (await res.json()) as { code?: number; msg?: string; data?: T } & T
    if (!res.ok || (typeof body.code === 'number' && body.code !== 0)) {
      const err = new Error(
        `Feishu API ${method} ${path} failed (HTTP ${res.status}, code=${body.code}): ${body.msg ?? 'unknown'}`
      ) as Error & { feishuCode?: number }
      err.feishuCode = body.code
      throw err
    }
    return (body.data ?? body) as T
  }

  private async fetchBotInfo(): Promise<LarkBotInfo> {
    const data = await this.apiRequest<{ bot?: { open_id?: string; app_name?: string } }>(
      'GET',
      '/open-apis/bot/v3/info'
    )
    return {
      openId: data.bot?.open_id,
      appName: data.bot?.app_name
    }
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | null> {
    try {
      const data = await this.apiRequest<{ reaction_id?: string }>(
        'POST',
        `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
        { reaction_type: { emoji_type: emojiType } }
      )
      return data.reaction_id ?? null
    } catch (err) {
      this.log(`feishu addReaction(${emojiType}) warning: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  async deleteReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      await this.apiRequest(
        'DELETE',
        `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`
      )
    } catch (err) {
      this.log(`feishu deleteReaction warning: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async sendReplyInternal(params: {
    messageId: string
    msgType: 'interactive' | 'text'
    content: string
    replyInThread: boolean
    uuid?: string
  }): Promise<LarkReplyResult> {
    const endpoint = `/open-apis/im/v1/messages/${encodeURIComponent(params.messageId)}/reply`
    const attempt = async (inThread: boolean, uuid?: string): Promise<LarkReplyResult> => {
      const data = await this.apiRequest<{ message_id?: string; thread_id?: string }>('POST', endpoint, {
        msg_type: params.msgType,
        content: params.content,
        reply_in_thread: inThread,
        ...(uuid ? { uuid } : {})
      })
      return {
        messageId: data.message_id ?? '',
        threadId: data.thread_id,
        repliedInThread: inThread
      }
    }

    if (!params.replyInThread) {
      return attempt(false, params.uuid)
    }

    try {
      return await attempt(true, params.uuid)
    } catch (err) {
      // Fallback to quoted reply on original message if Feishu rejects thread creation.
      this.log(
        `feishu reply_in_thread rejected, falling back to quoted reply: ${err instanceof Error ? err.message : String(err)}`
      )
      return attempt(false, params.uuid ? `${params.uuid}-fb` : undefined)
    }
  }

  async replyCard(params: {
    messageId: string
    card: Record<string, unknown>
    replyInThread: boolean
    uuid?: string
  }): Promise<LarkReplyResult> {
    return this.sendReplyInternal({
      messageId: params.messageId,
      msgType: 'interactive',
      content: JSON.stringify(params.card),
      replyInThread: params.replyInThread,
      uuid: params.uuid
    })
  }

  async patchCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    await this.apiRequest('PATCH', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      content: JSON.stringify(card)
    })
  }

  async replyText(params: {
    messageId: string
    text: string
    replyInThread: boolean
    uuid?: string
  }): Promise<LarkReplyResult> {
    return this.sendReplyInternal({
      messageId: params.messageId,
      msgType: 'text',
      content: JSON.stringify({ text: params.text }),
      replyInThread: params.replyInThread,
      uuid: params.uuid
    })
  }
}
