import { randomInt } from 'node:crypto'
import type { FeishuChatType, OwnerPairingState, PendingPairingCode } from './types'
import type { LarkIncomingMessage } from './lark/types'

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

/**
 * Matches `/agent` prefix (case-insensitive) followed by whitespace, colon, newline, or end.
 * Does NOT match `/agents` (matches Persona convention).
 */
export function extractAgentCommand(text: string): { matched: boolean; prompt: string } {
  const clean = stripLeadingMentions(text)
  const match = /^\/agent(?=$|[\s:：])[:：]?\s*([\s\S]*)$/i.exec(clean)
  if (!match) {
    return { matched: false, prompt: clean }
  }
  return { matched: true, prompt: match[1].trim() }
}

/** Matches `/pair 123456` or raw `123456` in a DM. */
export function extractPairingAttempt(text: string): string | null {
  const clean = text.trim()
  const cmdMatch = /^\/pair\s+(\d{6})$/i.exec(clean)
  if (cmdMatch) return cmdMatch[1]
  if (/^\d{6}$/.test(clean)) return clean
  return null
}

export function buildConversationKey(params: {
  domain: string
  appId: string
  chatId: string
  chatType: FeishuChatType
  threadId?: string
  rootId?: string
  messageId: string
}): { tenantAppScope: string; threadOrRootId: string; conversationKey: string } {
  const tenantAppScope = `${params.domain.replace(/\/+$/, '')}|${params.appId || 'local-app'}`
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
  botOpenId?: string
  now: number
}

function messageMentionsBot(msg: LarkIncomingMessage, botOpenId?: string): boolean {
  if (!msg.mentions || msg.mentions.length === 0) return false
  if (botOpenId) {
    return msg.mentions.some((m) => m.openId === botOpenId)
  }
  // When botOpenId hasn't been fetched yet, accept any explicit @_user_ mention present in payload.
  return msg.mentions.length > 0
}

/**
 * Evaluates access control, 6-digit DM owner pairing, DM direct passthrough,
 * and opt-in group allowlist (`@bot /agent ...`) rules.
 */
export function evaluateIncomingMessage(
  msg: LarkIncomingMessage,
  ctx: GuardContext
): GuardDecision {
  // Never process bot/app self-messages to avoid echo loops.
  if (msg.senderType && msg.senderType !== 'user') {
    return { action: 'ignore', reason: 'non_user_sender' }
  }

  const { ownerState, now } = ctx

  if (msg.chatType === 'p2p') {
    // Unpaired state: only accept 6-digit pairing code in DM; never wake Bot.
    if (!ownerState.ownerOpenId) {
      const attempt = extractPairingAttempt(msg.text)
      const pending = ownerState.pendingCode
      if (!attempt) {
        return {
          action: 'reply_only',
          reason: 'pairing_required',
          replyText:
            '当前 Orca Bot 尚未完成 Owner 认主。请在 Orca 右侧「Lark Bot」面板点击「生成 6 位配对码」，然后在本私聊发送 `/pair <6位配对码>` 完成绑定。'
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
          replyText:
            '配对成功！已将当前飞书账号绑定为本机 Orca Bot 的唯一 Owner。现在可直接私聊发送需求，或在白名单群内 `@机器人 /agent <需求>` 触发。'
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

    // Already paired: strictly enforce owner open_id.
    if (msg.senderOpenId !== ownerState.ownerOpenId) {
      return {
        action: 'reply_only',
        reason: 'unauthorized_sender',
        replyText: '抱歉，本机 Orca Bot 已绑定其他 Owner，未授权的私聊消息不会唤醒 Bot。'
      }
    }

    // Owner DM: direct passthrough to Bot (strip optional /agent prefix if typed).
    const parsed = extractAgentCommand(msg.text)
    const promptText = parsed.matched ? parsed.prompt : msg.text.trim()
    if (!promptText) {
      return {
        action: 'reply_only',
        reason: 'empty_prompt',
        replyText: '请输入具体需求内容后再发送给 Orca Bot。'
      }
    }
    return {
      action: 'dispatch',
      promptText,
      replyInThreadPreferred: Boolean(msg.threadId || msg.rootId)
    }
  }

  // Group chat: opt-in allowlist + @bot + /agent prefix + owner check.
  if (!ctx.allowedChatIds.includes(msg.chatId)) {
    return { action: 'ignore', reason: 'group_not_allowed' }
  }

  if (!messageMentionsBot(msg, ctx.botOpenId)) {
    return { action: 'ignore', reason: 'group_missing_mention_or_prefix' }
  }

  const parsed = extractAgentCommand(msg.text)
  if (!parsed.matched) {
    return { action: 'ignore', reason: 'group_missing_mention_or_prefix' }
  }

  if (!ownerState.ownerOpenId || msg.senderOpenId !== ownerState.ownerOpenId) {
    return {
      action: 'reply_only',
      reason: 'unauthorized_sender',
      replyText: '仅已配对的本机 Owner 可在白名单群内通过 `@机器人 /agent` 唤醒 Orca Bot。'
    }
  }

  if (!parsed.prompt) {
    return {
      action: 'reply_only',
      reason: 'empty_prompt',
      replyText: '请在 `/agent` 后附带具体任务内容，例如：`@机器人 /agent 帮我看下当前分支改动`。'
    }
  }

  return {
    action: 'dispatch',
    promptText: parsed.prompt,
    replyInThreadPreferred: true
  }
}
