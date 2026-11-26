import type { JsonValue } from 'orca/host'
import type {
  BridgeRequestRecord,
  ConversationBinding,
  OwnerPairingState
} from './types'

export interface KeyValueStorage {
  get(key: string): Promise<JsonValue | null>
  set(key: string, value: JsonValue): Promise<void>
  delete(key: string): Promise<void>
}

export const STORAGE_KEYS = {
  dedupe: 'bridge:dedupe:v1',
  bindings: 'bridge:bindings:v1',
  requests: 'bridge:requests:v1',
  owner: 'bridge:owner:v1'
} as const

const MAX_DEDUPE_ENTRIES = 1000
const MAX_BINDING_ENTRIES = 500
const MAX_REQUEST_RECORDS = 200

interface DedupeEntry {
  messageId: string
  seenAt: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Strips explicit `undefined` properties so values conform strictly to Orca's JsonValue schema. */
function toPlainJson<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/**
 * Persistent state store backed by Orca plugin storage (`storage:own`).
 * Serializes mutations via an internal promise queue so concurrent Feishu events
 * or out-of-order Bot callbacks never clobber each other's writes.
 */
export class BridgeStore {
  private readonly storage: KeyValueStorage
  private loaded = false
  private dedupeMap = new Map<string, number>()
  private bindingsMap = new Map<string, ConversationBinding>()
  private requestsMap = new Map<string, BridgeRequestRecord>()
  private ownerState: OwnerPairingState = {}
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(storage: KeyValueStorage) {
    this.storage = storage
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn, fn)
    this.writeChain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  async load(): Promise<void> {
    if (this.loaded) return
    const [rawDedupe, rawBindings, rawRequests, rawOwner] = await Promise.all([
      this.storage.get(STORAGE_KEYS.dedupe),
      this.storage.get(STORAGE_KEYS.bindings),
      this.storage.get(STORAGE_KEYS.requests),
      this.storage.get(STORAGE_KEYS.owner)
    ])

    this.dedupeMap.clear()
    if (Array.isArray(rawDedupe)) {
      for (const item of rawDedupe) {
        if (isObject(item) && typeof item.messageId === 'string' && typeof item.seenAt === 'number') {
          this.dedupeMap.set(item.messageId, item.seenAt)
        }
      }
    }

    this.bindingsMap.clear()
    if (Array.isArray(rawBindings)) {
      for (const item of rawBindings) {
        if (isObject(item) && typeof item.conversationKey === 'string') {
          this.bindingsMap.set(item.conversationKey, item as unknown as ConversationBinding)
        }
      }
    }

    this.requestsMap.clear()
    if (Array.isArray(rawRequests)) {
      for (const item of rawRequests) {
        if (isObject(item) && typeof item.requestId === 'string') {
          this.requestsMap.set(item.requestId, item as unknown as BridgeRequestRecord)
        }
      }
    }

    if (isObject(rawOwner)) {
      this.ownerState = rawOwner as unknown as OwnerPairingState
    } else {
      this.ownerState = {}
    }

    this.loaded = true
  }

  /** Atomically checks & records `messageId`. Returns `true` if newly claimed, `false` if duplicate. */
  async claimMessageId(messageId: string, now: number): Promise<boolean> {
    return this.enqueue(async () => {
      await this.load()
      if (this.dedupeMap.has(messageId)) {
        return false
      }
      this.dedupeMap.set(messageId, now)
      if (this.dedupeMap.size > MAX_DEDUPE_ENTRIES) {
        const entries = Array.from(this.dedupeMap.entries()).sort((a, b) => a[1] - b[1])
        const overflow = entries.length - MAX_DEDUPE_ENTRIES
        for (let i = 0; i < overflow; i++) {
          this.dedupeMap.delete(entries[i][0])
        }
      }
      const serialized: DedupeEntry[] = Array.from(this.dedupeMap.entries()).map(([id, seenAt]) => ({
        messageId: id,
        seenAt
      }))
      await this.storage.set(STORAGE_KEYS.dedupe, toPlainJson(serialized))
      return true
    })
  }

  hasMessageId(messageId: string): boolean {
    return this.dedupeMap.has(messageId)
  }

  dedupeCount(): number {
    return this.dedupeMap.size
  }

  getOwnerState(): OwnerPairingState {
    return structuredClone(this.ownerState)
  }

  async saveOwnerState(nextState: OwnerPairingState): Promise<OwnerPairingState> {
    return this.enqueue(async () => {
      await this.load()
      this.ownerState = structuredClone(nextState)
      await this.storage.set(STORAGE_KEYS.owner, toPlainJson(this.ownerState))
      return structuredClone(this.ownerState)
    })
  }

  getBinding(conversationKey: string): ConversationBinding | undefined {
    const existing = this.bindingsMap.get(conversationKey)
    return existing ? structuredClone(existing) : undefined
  }

  listBindings(): ConversationBinding[] {
    return Array.from(this.bindingsMap.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((item) => structuredClone(item))
  }

  async upsertBinding(binding: ConversationBinding): Promise<ConversationBinding> {
    return this.enqueue(async () => {
      await this.load()
      this.bindingsMap.set(binding.conversationKey, structuredClone(binding))
      if (this.bindingsMap.size > MAX_BINDING_ENTRIES) {
        const ordered = Array.from(this.bindingsMap.values()).sort((a, b) => a.updatedAt - b.updatedAt)
        const overflow = ordered.length - MAX_BINDING_ENTRIES
        for (let i = 0; i < overflow; i++) {
          this.bindingsMap.delete(ordered[i].conversationKey)
        }
      }
      await this.storage.set(
        STORAGE_KEYS.bindings,
        toPlainJson(Array.from(this.bindingsMap.values()))
      )
      return structuredClone(binding)
    })
  }

  getRequest(requestId: string): BridgeRequestRecord | undefined {
    const rec = this.requestsMap.get(requestId)
    return rec ? structuredClone(rec) : undefined
  }

  listRequests(limit = MAX_REQUEST_RECORDS): BridgeRequestRecord[] {
    return Array.from(this.requestsMap.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((item) => structuredClone(item))
  }

  async saveRequest(record: BridgeRequestRecord): Promise<BridgeRequestRecord> {
    return this.enqueue(async () => {
      await this.load()
      this.requestsMap.set(record.requestId, structuredClone(record))
      if (this.requestsMap.size > MAX_REQUEST_RECORDS) {
        const ordered = Array.from(this.requestsMap.values()).sort((a, b) => a.createdAt - b.createdAt)
        const overflow = ordered.length - MAX_REQUEST_RECORDS
        for (let i = 0; i < overflow; i++) {
          this.requestsMap.delete(ordered[i].requestId)
        }
      }
      await this.storage.set(
        STORAGE_KEYS.requests,
        toPlainJson(Array.from(this.requestsMap.values()))
      )
      return structuredClone(record)
    })
  }

  async updateRequest(
    requestId: string,
    updater: (current: BridgeRequestRecord) => BridgeRequestRecord
  ): Promise<BridgeRequestRecord | null> {
    return this.enqueue(async () => {
      await this.load()
      const current = this.requestsMap.get(requestId)
      if (!current) return null
      const updated = updater(structuredClone(current))
      this.requestsMap.set(requestId, structuredClone(updated))
      await this.storage.set(
        STORAGE_KEYS.requests,
        toPlainJson(Array.from(this.requestsMap.values()))
      )
      return structuredClone(updated)
    })
  }
}
