/** Default seconds before an unanswered Bot request times out (10 minutes). */
export const DEFAULT_REQUEST_TIMEOUT_SEC = 600
export const MIN_REQUEST_TIMEOUT_SEC = 5
export const MAX_REQUEST_TIMEOUT_SEC = 3600

/**
 * Validates a request timeout coming from the panel / bridge.updateSettings.
 * Returns the integer seconds, or an error message when it is not an integer within range.
 */
export function validateRequestTimeoutSec(
  value: unknown
): { ok: true; value: number } | { ok: false; error: string } {
  const num = typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : value
  if (typeof num !== 'number' || !Number.isInteger(num)) {
    return { ok: false, error: `requestTimeoutSec must be an integer between ${MIN_REQUEST_TIMEOUT_SEC} and ${MAX_REQUEST_TIMEOUT_SEC}` }
  }
  if (num < MIN_REQUEST_TIMEOUT_SEC || num > MAX_REQUEST_TIMEOUT_SEC) {
    return { ok: false, error: `requestTimeoutSec must be between ${MIN_REQUEST_TIMEOUT_SEC} and ${MAX_REQUEST_TIMEOUT_SEC} seconds (got ${num})` }
  }
  return { ok: true, value: num }
}

export type BridgeRequestStatus =
  | 'received'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'posted'

export type BridgeRequestOutcome = 'completed' | 'failed' | 'timeout'

export type FeishuChatType = 'p2p' | 'group'

export type TransportMode = 'auto' | 'direct' | 'node-sdk'

export type ConnectionState =
  | 'unconfigured'
  | 'offline'
  | 'connecting'
  | 'connected'
  | 'error'

export interface BridgeSettings {
  appId: string
  domain: string
  targetBot: string
  webhookUrl: string
  botRoutes: string
  allowedChatIds: string
  transportMode: TransportMode
  callbackPort: number
  requestTimeoutSec: number
  autoConnect: boolean
}

export interface BotRouteEntry {
  name: string
  webhookUrl: string
  isDefault: boolean
}

export interface BotRouteSummary {
  name: string
  webhookConfigured: boolean
  webhookUrlPreview: string
  isDefault: boolean
}

export interface ProgressEntry {
  at: number
  stage?: string
  text: string
}

export interface BridgeRequestRecord {
  requestId: string
  messageId: string
  chatId: string
  chatType: FeishuChatType
  rootId?: string
  parentId?: string
  threadId?: string
  conversationKey: string
  senderOpenId: string
  senderName?: string
  rawText: string
  promptText: string
  targetBot: string
  status: BridgeRequestStatus
  outcome?: BridgeRequestOutcome
  progressMessageId?: string
  replyMessageId?: string
  repliedInThread?: boolean
  reactionId?: string
  progressHistory: ProgressEntry[]
  finalAnswer?: string
  errorMessage?: string
  createdAt: number
  updatedAt: number
  dispatchedAt?: number
  completedAt?: number
  postedAt?: number
  deadlineAt: number
}

export interface ConversationBinding {
  conversationKey: string
  tenantAppScope: string
  chatId: string
  chatType: FeishuChatType
  threadOrRootId: string
  targetBot: string
  lastRequestId: string
  lastMessageId: string
  createdAt: number
  updatedAt: number
}

export interface PendingPairingCode {
  code: string
  createdAt: number
  expiresAt: number
  attempts: number
  maxAttempts: number
}

export interface OwnerPairingState {
  ownerOpenId?: string
  ownerDmChatId?: string
  pairedAt?: number
  pendingCode?: PendingPairingCode
}

export interface ConnectionSnapshot {
  state: ConnectionState
  since: number
  lastEventAt?: number
  error?: string
  transportKind: 'none' | 'direct' | 'node-sdk' | 'mock'
  callbackUrl?: string
  runtimeFilePath?: string
  botOpenId?: string
  botName?: string
}

export interface RequestSummary {
  requestId: string
  messageId: string
  chatId: string
  chatType: FeishuChatType
  threadId?: string
  conversationKey: string
  targetBot: string
  senderName?: string
  status: BridgeRequestStatus
  outcome?: BridgeRequestOutcome
  promptSummary: string
  answerPreview?: string
  errorMessage?: string
  createdAt: number
  updatedAt: number
}

export interface BridgeStats {
  totalRequests: number
  inFlight: number
  completed: number
  failedOrTimeout: number
  dedupedMessages: number
  bindingsCount: number
}

export interface BridgeSnapshot {
  connection: ConnectionSnapshot
  targetBot: string
  appId: string
  domain: string
  hasAppSecret: boolean
  webhookConfigured: boolean
  webhookUrlPreview: string
  routes: BotRouteSummary[]
  allowedChatIds: string[]
  requestTimeoutSec: number
  ownerPairing: OwnerPairingState
  recentRequests: RequestSummary[]
  stats: BridgeStats
}
