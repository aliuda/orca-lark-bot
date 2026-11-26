import type {
  LarkIncomingMessage,
  LarkMessageHandler,
  LarkReplyResult,
  LarkStatusHandler,
  LarkTransport,
  LarkTransportStatus
} from './lark/types'

export interface RecordedCardReply {
  replyMessageId: string
  targetMessageId: string
  card: Record<string, unknown>
  replyInThread: boolean
  threadId?: string
  uuid?: string
}

export interface RecordedCardPatch {
  messageId: string
  card: Record<string, unknown>
}

export interface RecordedTextReply {
  replyMessageId: string
  targetMessageId: string
  text: string
  replyInThread: boolean
  uuid?: string
}

export interface RecordedReaction {
  action: 'add' | 'delete'
  messageId: string
  emojiType?: string
  reactionId?: string
}

/**
 * Deterministic in-memory Feishu transport for offline unit and integration tests.
 */
export class MockLarkTransport implements LarkTransport {
  readonly kind = 'mock' as const
  readonly cardReplies: RecordedCardReply[] = []
  readonly cardPatches: RecordedCardPatch[] = []
  readonly textReplies: RecordedTextReply[] = []
  readonly reactions: RecordedReaction[] = []
  readonly failThreadReplyForMessageIds = new Set<string>()
  readonly failPatchForMessageIds = new Set<string>()

  private onMessage?: LarkMessageHandler
  private onStatus?: LarkStatusHandler
  private seq = 0
  private status: LarkTransportStatus

  constructor(options?: { botOpenId?: string; botName?: string }) {
    this.status = {
      state: 'offline',
      since: Date.now(),
      transportKind: 'mock',
      botOpenId: options?.botOpenId ?? 'ou_bot_demo',
      botName: options?.botName ?? 'MyBot'
    }
  }

  getStatus(): LarkTransportStatus {
    return { ...this.status }
  }

  async start(onMessage: LarkMessageHandler, onStatus?: LarkStatusHandler): Promise<void> {
    this.onMessage = onMessage
    this.onStatus = onStatus
    this.status = {
      ...this.status,
      state: 'connected',
      since: Date.now(),
      error: undefined
    }
    this.onStatus?.(this.getStatus())
  }

  async stop(): Promise<void> {
    this.status = {
      ...this.status,
      state: 'offline',
      since: Date.now()
    }
    this.onStatus?.(this.getStatus())
  }

  async simulateIncoming(msg: LarkIncomingMessage): Promise<void> {
    this.status = { ...this.status, lastEventAt: Date.now() }
    this.onStatus?.(this.getStatus())
    if (!this.onMessage) {
      throw new Error('MockLarkTransport has not been started')
    }
    await this.onMessage(msg)
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | null> {
    const reactionId = `rx_${++this.seq}`
    this.reactions.push({ action: 'add', messageId, emojiType, reactionId })
    return reactionId
  }

  async deleteReaction(messageId: string, reactionId: string): Promise<void> {
    this.reactions.push({ action: 'delete', messageId, reactionId })
  }

  async replyCard(params: {
    messageId: string
    card: Record<string, unknown>
    replyInThread: boolean
    uuid?: string
  }): Promise<LarkReplyResult> {
    const replyMessageId = `om_card_${++this.seq}`
    const shouldFallback =
      params.replyInThread && this.failThreadReplyForMessageIds.has(params.messageId)
    const repliedInThread = params.replyInThread && !shouldFallback
    const threadId = repliedInThread ? `omt_reply_${params.messageId}` : undefined
    this.cardReplies.push({
      replyMessageId,
      targetMessageId: params.messageId,
      card: structuredClone(params.card),
      replyInThread: repliedInThread,
      threadId,
      uuid: params.uuid
    })
    return { messageId: replyMessageId, threadId, repliedInThread }
  }

  async patchCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    if (this.failPatchForMessageIds.has(messageId)) {
      throw new Error(`Simulated patchCard failure for ${messageId}`)
    }
    this.cardPatches.push({ messageId, card: structuredClone(card) })
  }

  async replyText(params: {
    messageId: string
    text: string
    replyInThread: boolean
    uuid?: string
  }): Promise<LarkReplyResult> {
    const replyMessageId = `om_text_${++this.seq}`
    this.textReplies.push({
      replyMessageId,
      targetMessageId: params.messageId,
      text: params.text,
      replyInThread: params.replyInThread,
      uuid: params.uuid
    })
    return { messageId: replyMessageId, repliedInThread: params.replyInThread }
  }
}
