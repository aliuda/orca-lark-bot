import type { TransportMode } from '../types'
import {
  extractPlainTextFromFeishuContent,
  FeishuDirectTransport,
  type FeishuDirectTransportOptions
} from './feishu-transport'
import type {
  LarkIncomingMessage,
  LarkMessageHandler,
  LarkReplyResult,
  LarkStatusHandler,
  LarkTransport,
  LarkTransportStatus
} from './types'

interface LarkNodeSdkModule {
  Domain?: { Feishu?: string; Lark?: string }
  Client: new (opts: { appId: string; appSecret: string; domain?: string }) => {
    im: {
      message: {
        reply(req: {
          path: { message_id: string }
          data: { msg_type: string; content: string; reply_in_thread?: boolean; uuid?: string }
        }): Promise<{ data?: { message_id?: string; thread_id?: string } }>
        patch(req: {
          path: { message_id: string }
          data: { content: string }
        }): Promise<unknown>
      }
      messageReaction: {
        create(req: {
          path: { message_id: string }
          data: { reaction_type: { emoji_type: string } }
        }): Promise<{ data?: { reaction_id?: string } }>
        delete(req: {
          path: { message_id: string; reaction_id: string }
        }): Promise<unknown>
      }
    }
  }
  WSClient: new (opts: { appId: string; appSecret: string; domain?: string }) => {
    start(opts: { eventDispatcher: unknown }): Promise<void>
    close?(): Promise<void> | void
  }
  EventDispatcher: new (opts: Record<string, unknown>) => {
    register(handlers: Record<string, (data: unknown) => Promise<void> | void>): unknown
  }
}

async function tryLoadNodeSdk(): Promise<LarkNodeSdkModule | null> {
  try {
    // Dynamic specifier prevents bundlers / Orca's static loader from failing when
    // `@larksuiteoapi/node-sdk` is not installed in a zero-node_modules plugin install.
    const moduleName = '@larksuiteoapi/node-sdk'
    const loaded = (await import(moduleName)) as unknown as LarkNodeSdkModule
    if (loaded && typeof loaded.Client === 'function' && typeof loaded.WSClient === 'function') {
      return loaded
    }
    return null
  } catch {
    return null
  }
}

/**
 * Optional adapter wrapping the official `@larksuiteoapi/node-sdk` (`WSClient` + `Client`)
 * when installed in `node_modules`.
 */
export class FeishuNodeSdkTransport implements LarkTransport {
  readonly kind = 'node-sdk' as const
  private readonly sdk: LarkNodeSdkModule
  private readonly appId: string
  private readonly appSecret: string
  private readonly domain: string
  private readonly log: (msg: string) => void
  private readonly client: InstanceType<LarkNodeSdkModule['Client']>
  private wsClient: InstanceType<LarkNodeSdkModule['WSClient']> | null = null
  private status: LarkTransportStatus
  private onStatus?: LarkStatusHandler

  constructor(sdk: LarkNodeSdkModule, options: FeishuDirectTransportOptions) {
    this.sdk = sdk
    this.appId = options.appId
    this.appSecret = options.appSecret
    this.domain = options.domain
    this.log = options.log ?? (() => undefined)
    this.client = new sdk.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.domain
    })
    this.status = {
      state: 'offline',
      since: Date.now(),
      transportKind: 'node-sdk'
    }
  }

  getStatus(): LarkTransportStatus {
    return { ...this.status }
  }

  private setStatus(next: Partial<LarkTransportStatus>): void {
    this.status = { ...this.status, ...next, transportKind: 'node-sdk' }
    this.onStatus?.(this.getStatus())
  }

  async start(onMessage: LarkMessageHandler, onStatus?: LarkStatusHandler): Promise<void> {
    this.onStatus = onStatus
    this.setStatus({ state: 'connecting', since: Date.now(), error: undefined })

    const dispatcher = new this.sdk.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        const raw = data as {
          event_id?: string
          sender?: { sender_id?: { open_id?: string }; sender_type?: string }
          message?: {
            message_id?: string
            root_id?: string
            parent_id?: string
            thread_id?: string
            chat_id?: string
            chat_type?: string
            message_type?: string
            content?: string
            create_time?: string
            mentions?: Array<{ key?: string; id?: { open_id?: string }; name?: string }>
          }
        }
        const msg = raw.message
        if (!msg?.message_id || !msg.chat_id) return
        const incoming: LarkIncomingMessage = {
          eventId: raw.event_id,
          messageId: msg.message_id,
          chatId: msg.chat_id,
          chatType: msg.chat_type === 'p2p' ? 'p2p' : 'group',
          rootId: msg.root_id || undefined,
          parentId: msg.parent_id || undefined,
          threadId: msg.thread_id || undefined,
          senderOpenId: raw.sender?.sender_id?.open_id ?? '',
          senderType: raw.sender?.sender_type ?? 'user',
          messageType: msg.message_type ?? 'text',
          rawContent: msg.content ?? '',
          text: extractPlainTextFromFeishuContent(msg.message_type ?? 'text', msg.content ?? ''),
          mentions: (msg.mentions ?? []).map((m) => ({
            key: m.key ?? '',
            openId: m.id?.open_id,
            name: m.name
          })),
          createTimeMs: Number(msg.create_time ?? Date.now()) || Date.now()
        }
        this.setStatus({ lastEventAt: Date.now() })
        await onMessage(incoming)
      }
    })

    this.wsClient = new this.sdk.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.domain
    })
    await this.wsClient.start({ eventDispatcher: dispatcher })
    this.setStatus({ state: 'connected', since: Date.now(), error: undefined })
  }

  async stop(): Promise<void> {
    if (this.wsClient?.close) {
      await this.wsClient.close()
    }
    this.wsClient = null
    this.setStatus({ state: 'offline', since: Date.now(), error: undefined })
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | null> {
    try {
      const res = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } }
      })
      return res.data?.reaction_id ?? null
    } catch (err) {
      this.log(`node-sdk addReaction warning: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  async deleteReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      await this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId }
      })
    } catch (err) {
      this.log(`node-sdk deleteReaction warning: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async sendReply(params: {
    messageId: string
    msgType: 'interactive' | 'text'
    content: string
    replyInThread: boolean
    uuid?: string
  }): Promise<LarkReplyResult> {
    const attempt = async (inThread: boolean, uuid?: string): Promise<LarkReplyResult> => {
      const res = await this.client.im.message.reply({
        path: { message_id: params.messageId },
        data: {
          msg_type: params.msgType,
          content: params.content,
          reply_in_thread: inThread,
          ...(uuid ? { uuid } : {})
        }
      })
      return {
        messageId: res.data?.message_id ?? '',
        threadId: res.data?.thread_id,
        repliedInThread: inThread
      }
    }

    if (!params.replyInThread) return attempt(false, params.uuid)
    try {
      return await attempt(true, params.uuid)
    } catch {
      return attempt(false, params.uuid ? `${params.uuid}-fb` : undefined)
    }
  }

  async replyCard(params: {
    messageId: string
    card: Record<string, unknown>
    replyInThread: boolean
    uuid?: string
  }): Promise<LarkReplyResult> {
    return this.sendReply({
      messageId: params.messageId,
      msgType: 'interactive',
      content: JSON.stringify(params.card),
      replyInThread: params.replyInThread,
      uuid: params.uuid
    })
  }

  async patchCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) }
    })
  }

  async replyText(params: {
    messageId: string
    text: string
    replyInThread: boolean
    uuid?: string
  }): Promise<LarkReplyResult> {
    return this.sendReply({
      messageId: params.messageId,
      msgType: 'text',
      content: JSON.stringify({ text: params.text }),
      replyInThread: params.replyInThread,
      uuid: params.uuid
    })
  }
}

export async function createLarkTransport(
  mode: TransportMode,
  options: FeishuDirectTransportOptions
): Promise<LarkTransport> {
  if (mode === 'node-sdk' || mode === 'auto') {
    const sdk = await tryLoadNodeSdk()
    if (sdk) {
      return new FeishuNodeSdkTransport(sdk, options)
    }
    if (mode === 'node-sdk') {
      throw new Error(
        '@larksuiteoapi/node-sdk is not installed. Switch transportMode to "auto" or "direct", or install @larksuiteoapi/node-sdk.'
      )
    }
  }
  return new FeishuDirectTransport(options)
}
