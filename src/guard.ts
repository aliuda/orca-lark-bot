import { randomInt } from 'node:crypto'
import type { LarkIncomingMessage } from './lark/types'
import { findBotRouteByName } from './routes'
import type { BotRouteEntry, FeishuChatType, OwnerPairingState, PendingPairingCode } from './types'

export const PAIRING_TTL_MS = 10 * 60 * 1000
export const PAIRING_MAX_ATTEMPTS = 5

export function generatePairingCode(now: number): PendingPairingCode {
  const code = String(randomInt(100000, 1000000))
  return {
    code,
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS,
    attempts: 0,
    maxAttempts: PAIRING_MAX_ATTEMPTS
  }
}

export function parseAllowedChatIds(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    )
  )
}

/** Strips leading Feishu @mention placeholders (`@_user_1` or `@Name`) from text. */
export function stripLeadingMentions(text: string): string {
  let out = text.trim()
  while (/^@[^\s]+\s*/.test(out)) {
    out = out.replace(/^@[^\s]+\s*/, '').trimStart()
  }
  return out.trim()
}

/** Matches `/pair` command regardless of whether a code argument is attached. */
export function isPairCommand(text: string): boolean {
  return /^\/pair(?=$|[\s:：])/i.test(text.trim())
}

/** Matches `/pair 123456` or raw `123456` in a DM. */
export function extractPairingAttempt(text: string): string | null {
  const clean = text.trim()
  const cmdMatch = /^\/pair\s+(\d{6})$/i.exec(clean)
  if (cmdMatch) return cmdMatch[1]
  if (/^\d{6}$/.test(clean)) return clean
  return null
}

/**
 * Matches `/<BotName>` path-style prefix (case-insensitive exact token match against
 * configured bot routes, followed by whitespace, newline, colon, or end of text).
 * Does NOT false-match longer names (e.g. `/MyBot2` will not match `MyBot`).
 */
export function extractBotRouteCommand(
  text: string,
  routes: readonly BotRouteEntry[]
): { matched: true; route: BotRouteEntry; prompt: string } | { matched: false; prompt: string } {
  const clean = stripLeadingMentions(text)
  const match = /^\/([^\s/:：]+)(?:$|[\s:：])[:：]?\s*([\s\S]*)$/.exec(clean)
  if (!match) {
    return { matched: false, prompt: clean }
  }
  const route = findBotRouteByName(routes, match[1])
  if (!route) {
    return { matched: false, prompt: clean }
  }
  return { matched: true, route, prompt: match[2].trim() }
}

export function buildConversationKey(params: {
  domain: string
  appId: string
  targetBot?: string
  chatId: string
  chatType: FeishuChatType
  threadId?: string
  rootId?: string
  messageId: string
}): { tenantAppScope: string; threadOrRootId: string; conversationKey: string } {
  const botScope = params.targetBot?.trim()
  const baseScope = `${params.domain.replace(/\/+$/, '')}|${params.appId || 'local-app'}`
  const tenantAppScope = botScope ? `${baseScope}|${botScope.toLowerCase()}` : baseScope
  const threadOrRootId = params.threadId
    ? `thread:${params.threadId}`
    : params.rootId
      ? `root:${params.rootId}`
      : params.chatType === 'p2p'
        ? `dm:${params.chatId}`
        : `msg:${params.messageId}`
  return {
    tenantAppScope,
    threadOrRootId,
    conversationKey: `${tenantAppScope}|${params.chatId}|${threadOrRootId}`
  }
}

export type GuardDecision =
  | {
      action: 'dispatch'
      targetBot: string
      webhookUrl: string
      promptText: string
      replyInThreadPreferred: boolean
    }
  | {
      action: 'pair_success'
      nextOwnerState: OwnerPairingState
      replyText: string
    }
  | {
      action: 'reply_only'
      nextOwnerState?: OwnerPairingState
      replyText: string
      reason:
        | 'pairing_required'
        | 'pairing_invalid'
        | 'pairing_expired'
        | 'pairing_locked'
        | 'already_paired'
        | 'unauthorized_sender'
        | 'empty_prompt'
    }
  | {
      action: 'ignore'
      reason: 'non_user_sender' | 'group_not_allowed' | 'group_missing_mention_or_prefix'
    }

export interface GuardContext {
  ownerState: OwnerPairingState
  allowedChatIds: readonly string[]
  defaultRoute: BotRouteEntry
  routes: readonly BotRouteEntry[]
  botOpenId?: string
  now: number
}

function messageMentionsBot(msg: LarkIncomingMessage, botOpenId?: string): boolean {
  if (!msg.mentions || msg.mentions.length === 0) return false
  if (botOpenId) {
    return msg.mentions.some((m) => m.openId === botOpenId)
  }
  return msg.mentions.length > 0
}

function evaluatePairingVerification(
  msg: LarkIncomingMessage,
  ownerState: OwnerPairingState,
  now: number,
  defaultBotName: string
): GuardDecision {
  const attempt = extractPairingAttempt(msg.text)
  const pending = ownerState.pendingCode
  if (!attempt) {
    return {
      action: 'reply_only',
      reason: 'pairing_required',
      replyText:
        '当前 Orca Bot 尚未完成 Owner 认主。请在 Orca 右侧「Lark Bot」面板点击「生成配对码」，然后在本私聊发送 `/pair <6位配对码>` 完成绑定。'
    }
  }
  if (!pending) {
    return {
      action: 'reply_only',
      reason: 'pairing_required',
      replyText:
        '当前没有有效的配对码。请先在 Orca 右侧「Lark Bot」面板生成新的 6 位配对码后再发送。'
    }
  }
  if (now > pending.expiresAt) {
    return {
      action: 'reply_only',
      reason: 'pairing_expired',
      nextOwnerState: { ...ownerState, pendingCode: undefined },
      replyText: '该配对码已过期（有效期 10 分钟）。请在 Orca「Lark Bot」面板重新生成配对码。'
    }
  }
  if (attempt === pending.code) {
    return {
      action: 'pair_success',
      nextOwnerState: {
        ownerOpenId: msg.senderOpenId,
        ownerDmChatId: msg.chatId,
        pairedAt: now,
        pendingCode: undefined
      },
      replyText: `配对成功！已将当前飞书账号绑定为本机 Orca Bot 的唯一 Owner。现在可直接私聊发送需求，或在白名单群内 \`@机器人 /${defaultBotName} <需求>\` 触发。`
    }
  }
  const nextAttempts = pending.attempts + 1
  if (nextAttempts >= pending.maxAttempts) {
    return {
      action: 'reply_only',
      reason: 'pairing_locked',
      nextOwnerState: { ...ownerState, pendingCode: undefined },
      replyText: `配对码错误次数已达上限（${pending.maxAttempts} 次），当前配对码已作废。请在 Orca 面板重新生成。`
    }
  }
  return {
    action: 'reply_only',
    reason: 'pairing_invalid',
    nextOwnerState: {
      ...ownerState,
      pendingCode: { ...pending, attempts: nextAttempts }
    },
    replyText: `配对码不正确（剩余 ${pending.maxAttempts - nextAttempts} 次机会）。`
  }
}

/**
 * Evaluates access control, 6-digit DM owner pairing, already-paired `/pair` interception,
 * DM direct passthrough + `/<BotName>` multi-bot routing, and opt-in group allowlist
 * (`@bot /<BotName> ...`) rules.
 */
export function evaluateIncomingMessage(
  msg: LarkIncomingMessage,
  ctx: GuardContext
): GuardDecision {
  // Never process bot/app self-messages to avoid echo loops.
  if (msg.senderType && msg.senderType !== 'user') {
    return { action: 'ignore', reason: 'non_user_sender' }
  }

  const { ownerState, now, defaultRoute, routes } = ctx

  if (msg.chatType === 'p2p') {
    // Unpaired state: only accept 6-digit pairing code in DM; never wake Bot.
    if (!ownerState.ownerOpenId) {
      return evaluatePairingVerification(msg, ownerState, now, defaultRoute.name)
    }

    // Already paired: non-owner DM either validates an active pairing code (if generated) or is rejected.
    if (msg.senderOpenId !== ownerState.ownerOpenId) {
      if (isPairCommand(msg.text) && ownerState.pendingCode) {
        return evaluatePairingVerification(msg, ownerState, now, defaultRoute.name)
      }
      return {
        action: 'reply_only',
        reason: 'unauthorized_sender',
        replyText: '抱歉，本机 Orca Bot 已绑定其他 Owner，未授权的私聊消息不会唤醒 Bot。'
      }
    }

    // Paired Owner sending `/pair` (with or without code): intercept directly without waking Bot.
    if (isPairCommand(msg.text)) {
      return {
        action: 'reply_only',
        reason: 'already_paired',
        replyText:
          '你的飞书账号已完成 Owner 配对，直接发消息即可与机器人对话；如需换绑请在 Orca 右侧「Lark Bot」面板撤销配对。'
      }
    }

    // Paired Owner DM: match `/<BotName>` route if present, otherwise route to default `targetBot`.
    const routeMatch = extractBotRouteCommand(msg.text, routes)
    const selectedRoute = routeMatch.matched ? routeMatch.route : defaultRoute
    const promptText = routeMatch.matched ? routeMatch.prompt : msg.text.trim()
    if (!promptText) {
      return {
        action: 'reply_only',
        reason: 'empty_prompt',
        replyText: routeMatch.matched
          ? `请在 \`/${selectedRoute.name}\` 后附带具体任务内容。`
          : '请输入具体需求内容后再发送给 Orca Bot。'
      }
    }
    return {
      action: 'dispatch',
      targetBot: selectedRoute.name,
      webhookUrl: selectedRoute.webhookUrl,
      promptText,
      replyInThreadPreferred: Boolean(msg.threadId || msg.rootId)
    }
  }

  // Group chat: opt-in allowlist + @bot + `/<BotName>` route prefix + owner check.
  if (!ctx.allowedChatIds.includes(msg.chatId)) {
    return { action: 'ignore', reason: 'group_not_allowed' }
  }

  if (!messageMentionsBot(msg, ctx.botOpenId)) {
    return { action: 'ignore', reason: 'group_missing_mention_or_prefix' }
  }

  const routeMatch = extractBotRouteCommand(msg.text, routes)
  if (!routeMatch.matched) {
    return { action: 'ignore', reason: 'group_missing_mention_or_prefix' }
  }

  if (!ownerState.ownerOpenId || msg.senderOpenId !== ownerState.ownerOpenId) {
    return {
      action: 'reply_only',
      reason: 'unauthorized_sender',
      replyText: `仅已配对的本机 Owner 可在白名单群内通过 \`@机器人 /${routeMatch.route.name}\` 唤醒 Orca Bot。`
    }
  }

  if (!routeMatch.prompt) {
    return {
      action: 'reply_only',
      reason: 'empty_prompt',
      replyText: `请在 \`/${routeMatch.route.name}\` 后附带具体任务内容，例如：\`@机器人 /${routeMatch.route.name} 帮我看下当前分支改动\`。`
    }
  }

  return {
    action: 'dispatch',
    targetBot: routeMatch.route.name,
    webhookUrl: routeMatch.route.webhookUrl,
    promptText: routeMatch.prompt,
    replyInThreadPreferred: true
  }
}
