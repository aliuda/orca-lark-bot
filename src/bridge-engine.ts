import { randomUUID } from 'node:crypto'
import type { CallbackOutcome } from './bot/callback-server'
import type { BotDispatcher } from './bot/webhook-dispatcher'
import {
  buildConversationKey,
  evaluateIncomingMessage,
  generatePairingCode,
  parseAllowedChatIds
} from './guard'
import { buildStageCard } from './lark/cards'
import type { LarkIncomingMessage, LarkTransport } from './lark/types'
import { maskWebhookUrl, resolveBotRoutes, summarizeBotRoutes } from './routes'
import type { BridgeStore } from './store'
import type {
  BridgeRequestRecord,
  BridgeSettings,
  BridgeSnapshot,
  ConnectionSnapshot,
  RequestSummary
} from './types'

export interface BridgeEngineOptions {
  store: BridgeStore
  getSettings: () => BridgeSettings
  hasAppSecret: () => boolean
  getTransport: () => LarkTransport | null
  getDispatcher: () => BotDispatcher
  getConnectionSnapshot: () => ConnectionSnapshot
  onSnapshotChanged?: (snapshot: BridgeSnapshot) => void
  onNotify?: (title: string, body: string) => void
  now?: () => number
  log?: (msg: string) => void
}

function summarize(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= maxLen) return clean
  return `${clean.slice(0, maxLen - 1)}…`
}

/**
 * Deterministic Feishu <-> Orca Bot bridge state machine.
 *
 * State transitions:
 *   received -> dispatched -> completed -> posted
 *                          -> failed    -> posted
 *                          -> timeout   -> posted
 */
export class BridgeEngine {
  private readonly store: BridgeStore
  private readonly getSettings: () => BridgeSettings
  private readonly hasAppSecret: () => boolean
  private readonly getTransport: () => LarkTransport | null
  private readonly getDispatcher: () => BotDispatcher
  private readonly getConnectionSnapshot: () => ConnectionSnapshot
  private readonly onSnapshotChanged?: (snapshot: BridgeSnapshot) => void
  private readonly onNotify?: (title: string, body: string) => void
  private readonly now: () => number
  private readonly log: (msg: string) => void

  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(options: BridgeEngineOptions) {
    this.store = options.store
    this.getSettings = options.getSettings
    this.hasAppSecret = options.hasAppSecret
    this.getTransport = options.getTransport
    this.getDispatcher = options.getDispatcher
    this.getConnectionSnapshot = options.getConnectionSnapshot
    this.onSnapshotChanged = options.onSnapshotChanged
    this.onNotify = options.onNotify
    this.now = options.now ?? (() => Date.now())
    this.log = options.log ?? (() => undefined)
  }

  /** Restores persisted dedupe/bindings/owner/requests and reconciles in-flight timers. */
  async initialize(): Promise<void> {
    await this.store.load()
    const currentNow = this.now()
    for (const req of this.store.listRequests()) {
      if (req.status === 'dispatched' || req.status === 'received') {
        if (req.deadlineAt <= currentNow) {
          await this.handleTimeout(req.requestId)
        } else {
          this.scheduleTimeout(req.requestId, req.deadlineAt - currentNow)
        }
      }
    }
    this.emitSnapshot()
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
  }

  private clearTimer(requestId: string): void {
    const timer = this.timers.get(requestId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(requestId)
    }
  }

  private scheduleTimeout(requestId: string, delayMs: number): void {
    this.clearTimer(requestId)
    const bounded = Math.max(10, delayMs)
    const timer = setTimeout(() => {
      this.timers.delete(requestId)
      void this.handleTimeout(requestId)
    }, bounded)
    const maybeUnref = timer as unknown as { unref?: () => void }
    maybeUnref.unref?.()
    this.timers.set(requestId, timer)
  }

  getSnapshot(): BridgeSnapshot {
    const settings = this.getSettings()
    const { defaultRoute, routes } = resolveBotRoutes({
      targetBot: settings.targetBot,
      webhookUrl: settings.webhookUrl,
      botRoutes: settings.botRoutes
    })
    const requests = this.store.listRequests(50)
    const recentRequests: RequestSummary[] = requests.map((r) => ({
      requestId: r.requestId,
      messageId: r.messageId,
      chatId: r.chatId,
      chatType: r.chatType,
      threadId: r.threadId,
      conversationKey: r.conversationKey,
      targetBot: r.targetBot,
      senderName: r.senderName,
      status: r.status,
      outcome: r.outcome,
      promptSummary: summarize(r.promptText || r.rawText, 80),
      answerPreview: r.finalAnswer ? summarize(r.finalAnswer, 120) : undefined,
      errorMessage: r.errorMessage,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt
    }))

    let inFlight = 0
    let completed = 0
    let failedOrTimeout = 0
    for (const r of requests) {
      if (r.status === 'received' || r.status === 'dispatched') inFlight++
      else if (r.outcome === 'completed') completed++
      else if (r.outcome === 'failed' || r.outcome === 'timeout' || r.status === 'failed' || r.status === 'timeout') {
        failedOrTimeout++
      }
    }

    const snapshot: BridgeSnapshot = {
      connection: this.getConnectionSnapshot(),
      targetBot: defaultRoute.name,
      appId: settings.appId,
      domain: settings.domain,
      hasAppSecret: this.hasAppSecret(),
      webhookConfigured: routes.some((r) => r.webhookUrl.trim().length > 0),
      webhookUrlPreview: maskWebhookUrl(defaultRoute.webhookUrl),
      routes: summarizeBotRoutes(routes),
      allowedChatIds: parseAllowedChatIds(settings.allowedChatIds),
      requestTimeoutSec: settings.requestTimeoutSec,
      ownerPairing: this.store.getOwnerState(),
      recentRequests,
      stats: {
        totalRequests: requests.length,
        inFlight,
        completed,
        failedOrTimeout,
        dedupedMessages: this.store.dedupeCount(),
        bindingsCount: this.store.listBindings().length
      }
    }
    return JSON.parse(JSON.stringify(snapshot)) as BridgeSnapshot
  }

  emitSnapshot(): void {
    this.onSnapshotChanged?.(this.getSnapshot())
  }

  async createPairingCode(): Promise<{ code: string; expiresAt: number }> {
    await this.store.load()
    const pendingCode = generatePairingCode(this.now())
    const current = this.store.getOwnerState()
    await this.store.saveOwnerState({
      ...current,
      pendingCode
    })
    this.emitSnapshot()
    return { code: pendingCode.code, expiresAt: pendingCode.expiresAt }
  }

  async revokeOwnerPairing(): Promise<void> {
    await this.store.load()
    await this.store.saveOwnerState({})
    this.emitSnapshot()
  }

  /**
   * Entry point for every incoming Feishu `im.message.receive_v1` event.
   * Deduplicates by `message_id`, enforces DM pairing / owner allowlist / group opt-in rules,
   * persists conversation binding, sends initial reaction & progress card, and dispatches to Bot.
   */
  async handleIncomingMessage(msg: LarkIncomingMessage): Promise<{
    handled: boolean
    reason?: string
    requestId?: string
  }> {
    await this.store.load()
    const currentNow = this.now()

    // 1. Persistent message_id deduplication.
    const claimed = await this.store.claimMessageId(msg.messageId, currentNow)
    if (!claimed) {
      this.log(`deduped duplicate Feishu message_id=${msg.messageId}`)
      return { handled: false, reason: 'duplicate_message' }
    }

    const settings = this.getSettings()
    const { defaultRoute, routes } = resolveBotRoutes({
      targetBot: settings.targetBot,
      webhookUrl: settings.webhookUrl,
      botRoutes: settings.botRoutes
    })
    const transport = this.getTransport()
    const conn = this.getConnectionSnapshot()
    const decision = evaluateIncomingMessage(msg, {
      ownerState: this.store.getOwnerState(),
      allowedChatIds: parseAllowedChatIds(settings.allowedChatIds),
      defaultRoute,
      routes,
      botOpenId: conn.botOpenId,
      now: currentNow
    })

    if (decision.action === 'ignore') {
      return { handled: false, reason: decision.reason }
    }

    if (decision.action === 'pair_success') {
      await this.store.saveOwnerState(decision.nextOwnerState)
      if (transport) {
        await transport.replyText({
          messageId: msg.messageId,
          text: decision.replyText,
          replyInThread: false,
          uuid: `pair-${msg.messageId}`.slice(0, 50)
        })
      }
      this.onNotify?.('Lark Bot 已完成 Owner 配对', `已绑定 Owner: ${msg.senderOpenId}`)
      this.emitSnapshot()
      return { handled: true, reason: 'pair_success' }
    }

    if (decision.action === 'reply_only') {
      if (decision.nextOwnerState) {
        await this.store.saveOwnerState(decision.nextOwnerState)
      }
      if (transport) {
        await transport.replyText({
          messageId: msg.messageId,
          text: decision.replyText,
          replyInThread: false,
          uuid: `guard-${msg.messageId}`.slice(0, 50)
        })
      }
      this.emitSnapshot()
      return { handled: true, reason: decision.reason }
    }

    // 2. Authorized request -> create opaque request_id and persist binding + initial record.
    const requestId = `req_${randomUUID()}`
    const targetBot = decision.targetBot
    const timeoutMs = Math.max(5, settings.requestTimeoutSec) * 1000
    const conv = buildConversationKey({
      domain: settings.domain,
      appId: settings.appId,
      targetBot,
      chatId: msg.chatId,
      chatType: msg.chatType,
      threadId: msg.threadId,
      rootId: msg.rootId,
      messageId: msg.messageId
    })

    const existingBinding = this.store.getBinding(conv.conversationKey)
    await this.store.upsertBinding({
      conversationKey: conv.conversationKey,
      tenantAppScope: conv.tenantAppScope,
      chatId: msg.chatId,
      chatType: msg.chatType,
      threadOrRootId: conv.threadOrRootId,
      targetBot,
      lastRequestId: requestId,
      lastMessageId: msg.messageId,
      createdAt: existingBinding?.createdAt ?? currentNow,
      updatedAt: currentNow
    })

    const record: BridgeRequestRecord = {
      requestId,
      messageId: msg.messageId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      rootId: msg.rootId,
      parentId: msg.parentId,
      threadId: msg.threadId,
      conversationKey: conv.conversationKey,
      senderOpenId: msg.senderOpenId,
      senderName: msg.senderName || msg.senderOpenId,
      rawText: msg.text,
      promptText: decision.promptText,
      targetBot,
      status: 'received',
      progressHistory: [],
      createdAt: currentNow,
      updatedAt: currentNow,
      deadlineAt: currentNow + timeoutMs
    }
    await this.store.saveRequest(record)
    this.emitSnapshot()

    // 3. Feishu acknowledgement: OnIt reaction + stage progress card (`reply_in_thread` w/ fallback).
    if (transport) {
      const reactionId = await transport.addReaction(msg.messageId, 'OnIt')
      const card = buildStageCard({
        stage: 'received',
        botName: targetBot,
        requestId,
        promptPreview: decision.promptText
      })
      try {
        const reply = await transport.replyCard({
          messageId: msg.messageId,
          card,
          replyInThread: decision.replyInThreadPreferred,
          uuid: requestId
        })
        await this.store.updateRequest(requestId, (cur) => ({
          ...cur,
          reactionId: reactionId ?? cur.reactionId,
          progressMessageId: reply.messageId || cur.progressMessageId,
          threadId: reply.threadId ?? cur.threadId,
          repliedInThread: reply.repliedInThread,
          updatedAt: this.now()
        }))
      } catch (err) {
        this.log(`failed sending initial Feishu card for ${requestId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // 4. Dispatch to Orca Bot webhook with opaque request_id and resolved route URL.
    const dispatchRes = await this.getDispatcher().dispatch(
      {
        request_id: requestId,
        conversation_key: conv.conversationKey,
        chat_type: msg.chatType,
        message_id: msg.messageId,
        thread_id: msg.threadId,
        sender_name: msg.senderName || msg.senderOpenId,
        target_bot: targetBot,
        text: decision.promptText,
        received_at: new Date(currentNow).toISOString()
      },
      { webhookUrl: decision.webhookUrl }
    )

    if (!dispatchRes.accepted) {
      await this.transitionTerminal(requestId, 'failed', {
        errorMessage: dispatchRes.error ?? 'Dispatch to Orca Bot failed'
      })
      return { handled: true, reason: 'dispatch_failed', requestId }
    }

    const dispatchedAt = this.now()
    const updated = await this.store.updateRequest(requestId, (cur) => ({
      ...cur,
      status: 'dispatched',
      dispatchedAt,
      updatedAt: dispatchedAt
    }))

    if (updated?.progressMessageId && transport) {
      const workingCard = buildStageCard({
        stage: 'processing',
        botName: targetBot,
        requestId,
        promptPreview: decision.promptText,
        progressHistory: [{ at: dispatchedAt, stage: '已派发', text: `已唤醒 ${targetBot}，等待执行进展…` }]
      })
      await transport.patchCard(updated.progressMessageId, workingCard).catch((err) => {
        this.log(`patch processing card failed for ${requestId}: ${err instanceof Error ? err.message : String(err)}`)
      })
    }

    this.scheduleTimeout(requestId, Math.max(10, (updated?.deadlineAt ?? currentNow + timeoutMs) - this.now()))
    this.emitSnapshot()
    return { handled: true, reason: 'dispatched', requestId }
  }

  /** Receives interim progress callback from Bot MCP scoped strictly by `requestId`. */
  async handleBotProgress(input: {
    requestId: string
    text: string
    stage?: string
  }): Promise<CallbackOutcome> {
    await this.store.load()
    const existing = this.store.getRequest(input.requestId)
    if (!existing) {
      return { ok: false, code: 'not_found', message: `Unknown request_id: ${input.requestId}` }
    }
    if (existing.status === 'posted' || existing.outcome) {
      return {
        ok: false,
        code: 'already_settled',
        message: `Request ${input.requestId} is already settled (${existing.outcome ?? existing.status})`
      }
    }

    const at = this.now()
    const updated = await this.store.updateRequest(input.requestId, (cur) => ({
      ...cur,
      status: 'dispatched',
      progressHistory: [...cur.progressHistory, { at, stage: input.stage, text: input.text }],
      updatedAt: at
    }))

    const transport = this.getTransport()
    if (updated?.progressMessageId && transport) {
      const card = buildStageCard({
        stage: 'processing',
        botName: updated.targetBot,
        requestId: updated.requestId,
        promptPreview: updated.promptText,
        progressHistory: updated.progressHistory
      })
      await transport.patchCard(updated.progressMessageId, card).catch((err) => {
        this.log(`patch progress card failed for ${updated.requestId}: ${err instanceof Error ? err.message : String(err)}`)
      })
    }

    this.emitSnapshot()
    return { ok: true }
  }

  /** Receives final answer callback from Bot MCP scoped strictly by `requestId`. */
  async handleBotComplete(input: { requestId: string; answer: string }): Promise<CallbackOutcome> {
    await this.store.load()
    const existing = this.store.getRequest(input.requestId)
    if (!existing) {
      return { ok: false, code: 'not_found', message: `Unknown request_id: ${input.requestId}` }
    }
    if (existing.status === 'posted' || existing.outcome) {
      return {
        ok: false,
        code: 'already_settled',
        message: `Request ${input.requestId} is already settled (${existing.outcome ?? existing.status})`
      }
    }

    await this.transitionTerminal(input.requestId, 'completed', { finalAnswer: input.answer })
    return { ok: true }
  }

  /** Receives explicit failure callback from Bot MCP scoped strictly by `requestId`. */
  async handleBotFail(input: { requestId: string; error: string }): Promise<CallbackOutcome> {
    await this.store.load()
    const existing = this.store.getRequest(input.requestId)
    if (!existing) {
      return { ok: false, code: 'not_found', message: `Unknown request_id: ${input.requestId}` }
    }
    if (existing.status === 'posted' || existing.outcome) {
      return {
        ok: false,
        code: 'already_settled',
        message: `Request ${input.requestId} is already settled (${existing.outcome ?? existing.status})`
      }
    }

    await this.transitionTerminal(input.requestId, 'failed', { errorMessage: input.error })
    return { ok: true }
  }

  /** Marks an overdue in-flight request as timed out and updates its Feishu card. */
  async handleTimeout(requestId: string): Promise<boolean> {
    await this.store.load()
    const existing = this.store.getRequest(requestId)
    if (!existing || existing.status === 'posted' || existing.outcome) {
      return false
    }
    await this.transitionTerminal(requestId, 'timeout', {
      errorMessage: `等待 ${existing.targetBot} 回调超过 ${this.getSettings().requestTimeoutSec} 秒（request_id: ${requestId}）。请检查 Orca 中该轮运行状态后重试。`
    })
    return true
  }

  /** Deterministic sweep helper (used on timer checks, panel trigger, and unit tests). */
  async sweepTimeouts(nowOverride?: number): Promise<string[]> {
    await this.store.load()
    const checkNow = nowOverride ?? this.now()
    const timedOutIds: string[] = []
    for (const req of this.store.listRequests()) {
      if ((req.status === 'received' || req.status === 'dispatched') && req.deadlineAt <= checkNow) {
        const didTimeout = await this.handleTimeout(req.requestId)
        if (didTimeout) timedOutIds.push(req.requestId)
      }
    }
    return timedOutIds
  }

  private async transitionTerminal(
    requestId: string,
    outcome: 'completed' | 'failed' | 'timeout',
    detail: { finalAnswer?: string; errorMessage?: string }
  ): Promise<void> {
    this.clearTimer(requestId)
    const completedAt = this.now()

    // Intermediate state persistence: `completed` | `failed` | `timeout` before posting to Feishu.
    const staged = await this.store.updateRequest(requestId, (cur) => ({
      ...cur,
      status: outcome,
      outcome,
      finalAnswer: detail.finalAnswer ?? cur.finalAnswer,
      errorMessage: detail.errorMessage ?? cur.errorMessage,
      completedAt,
      updatedAt: completedAt
    }))
    if (!staged) return

    const transport = this.getTransport()
    let replyMessageId = staged.progressMessageId
    let repliedInThread = staged.repliedInThread

    if (transport) {
      const card = buildStageCard({
        stage: outcome,
        botName: staged.targetBot,
        requestId: staged.requestId,
        promptPreview: staged.promptText,
        progressHistory: staged.progressHistory,
        finalAnswer: staged.finalAnswer,
        errorMessage: staged.errorMessage
      })

      let patched = false
      if (staged.progressMessageId) {
        try {
          await transport.patchCard(staged.progressMessageId, card)
          patched = true
        } catch (err) {
          this.log(
            `patch terminal card failed for ${requestId}, sending new reply: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      }

      if (!patched) {
        const reply = await transport.replyCard({
          messageId: staged.messageId,
          card,
          replyInThread: Boolean(staged.threadId || staged.rootId || staged.chatType === 'group'),
          uuid: `${requestId}-${outcome}`.slice(0, 50)
        })
        replyMessageId = reply.messageId
        repliedInThread = reply.repliedInThread
      }

      // Swap OnIt -> DONE reaction on completion.
      if (staged.reactionId) {
        await transport.deleteReaction(staged.messageId, staged.reactionId)
      }
      if (outcome === 'completed') {
        await transport.addReaction(staged.messageId, 'DONE')
      }
    }

    const postedAt = this.now()
    await this.store.updateRequest(requestId, (cur) => ({
      ...cur,
      status: 'posted',
      replyMessageId: replyMessageId ?? cur.replyMessageId,
      repliedInThread: repliedInThread ?? cur.repliedInThread,
      postedAt,
      updatedAt: postedAt
    }))

    if (outcome === 'timeout' || outcome === 'failed') {
      this.onNotify?.(
        `Lark Bot 请求${outcome === 'timeout' ? '超时' : '失败'}`,
        `${staged.requestId}: ${staged.errorMessage ?? ''}`.slice(0, 140)
      )
    }
    this.emitSnapshot()
  }
}
