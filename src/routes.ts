import type { BotRouteEntry, BotRouteSummary } from './types'

const VALID_BOT_NAME_RE = /^[^\s/:：]+$/

/** Masks a webhook URL to protocol + host only so secrets/keys are never echoed. */
export function maskWebhookUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  try {
    const u = new URL(trimmed)
    return `${u.protocol}//${u.host}/…`
  } catch {
    return 'configured'
  }
}

function parseExtraRoutePairs(raw: string): Array<{ name: string; webhookUrl: string }> {
  const trimmed = raw.trim()
  if (!trimmed) return []

  // JSON object format: { "Coder": "https://...", "Reviewer": "https://..." }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const entries: Array<{ name: string; webhookUrl: string }> = []
        for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
          const name = key.trim()
          const url = typeof val === 'string' ? val.trim() : ''
          if (name && VALID_BOT_NAME_RE.test(name) && url) {
            entries.push({ name, webhookUrl: url })
          }
        }
        return entries
      }
    } catch {
      // Fall through to line-based parser if JSON is malformed.
    }
  }

  // Line-based format: `BotName=https://...` (supports `#` comments and blank lines).
  const entries: Array<{ name: string; webhookUrl: string }> = []
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eqIndex = line.indexOf('=')
    if (eqIndex <= 0) continue
    const name = line.slice(0, eqIndex).trim()
    const webhookUrl = line.slice(eqIndex + 1).trim()
    if (name && VALID_BOT_NAME_RE.test(name) && webhookUrl) {
      entries.push({ name, webhookUrl })
    }
  }
  return entries
}

/**
 * Builds the normalized multi-bot routing table from default `targetBot`/`webhookUrl`
 * plus optional `botRoutes`. Matching is case-insensitive while preserving canonical names.
 */
export function resolveBotRoutes(params: {
  targetBot: string
  webhookUrl: string
  botRoutes: string
}): { defaultRoute: BotRouteEntry; routes: BotRouteEntry[] } {
  const defaultName = params.targetBot.trim() || 'MyBot'
  const defaultUrl = params.webhookUrl.trim()

  const byLower = new Map<string, BotRouteEntry>()
  const defaultRoute: BotRouteEntry = {
    name: defaultName,
    webhookUrl: defaultUrl,
    isDefault: true
  }
  byLower.set(defaultName.toLowerCase(), defaultRoute)

  for (const extra of parseExtraRoutePairs(params.botRoutes)) {
    const key = extra.name.toLowerCase()
    const existing = byLower.get(key)
    if (existing) {
      // Allow botRoutes to fill in or override URL for the same bot while keeping default flag.
      existing.webhookUrl = extra.webhookUrl
    } else {
      byLower.set(key, {
        name: extra.name,
        webhookUrl: extra.webhookUrl,
        isDefault: false
      })
    }
  }

  return {
    defaultRoute,
    routes: Array.from(byLower.values())
  }
}

export function findBotRouteByName(
  routes: readonly BotRouteEntry[],
  candidateName: string
): BotRouteEntry | undefined {
  const target = candidateName.trim().toLowerCase()
  if (!target) return undefined
  return routes.find((r) => r.name.toLowerCase() === target)
}

export function summarizeBotRoutes(routes: readonly BotRouteEntry[]): BotRouteSummary[] {
  return routes.map((r) => ({
    name: r.name,
    webhookConfigured: r.webhookUrl.trim().length > 0,
    webhookUrlPreview: maskWebhookUrl(r.webhookUrl),
    isDefault: r.isDefault
  }))
}
