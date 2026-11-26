import type { ConnectionState, FeishuChatType } from '../types'

export interface LarkMention {
  key: string
  openId?: string
  name?: string
}

export interface LarkIncomingMessage {
  eventId?: string
  messageId: string
  chatId: string
  chatType: FeishuChatType
  rootId?: string
  parentId?: string
  threadId?: string
  senderOpenId: string
  senderType: string
  senderName?: string
  messageType: string
  rawContent: string
  text: string
  mentions: LarkMention[]
  createTimeMs: number
}

export interface LarkReplyResult {
  messageId: string
  threadId?: string
  repliedInThread: boolean
}

export interface LarkBotInfo {
  openId?: string
  appName?: string
}

export interface LarkTransportStatus {
  state: ConnectionState
  since: number
  lastEventAt?: number
  error?: string
  transportKind: 'none' | 'direct' | 'node-sdk' | 'mock'
  botOpenId?: string
  botName?: string
}

export type LarkMessageHandler = (msg: LarkIncomingMessage) => void | Promise<void>
export type LarkStatusHandler = (status: LarkTransportStatus) => void

export interface LarkTransport {
  readonly kind: 'direct' | 'node-sdk' | 'mock'
  start(onMessage: LarkMessageHandler, onStatus?: LarkStatusHandler): Promise<void>
  stop(): Promise<void>
  getStatus(): LarkTransportStatus
  addReaction(messageId: string, emojiType: string): Promise<string | null>
  deleteReaction(messageId: string, reactionId: string): Promise<void>
  replyCard(params: {
    messageId: string
    card: Record<string, unknown>
    replyInThread: boolean
    uuid?: string
  }): Promise<LarkReplyResult>
  patchCard(messageId: string, card: Record<string, unknown>): Promise<void>
  replyText(params: {
    messageId: string
    text: string
    replyInThread: boolean
    uuid?: string
  }): Promise<LarkReplyResult>
}
