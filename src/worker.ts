// Orca trusted-worker entry for Lark Bot Bridge.
// Runs persistent Feishu WebSocket transport + authenticated loopback Bot callback server,
// persists dedupe/bindings/owner state in orca.storage, stores App Secret in orca.secrets,
// updates Orca's status bar, and answers the right-sidebar TSX panel via orca.panels.handle.

import type { Disposable, JsonValue } from 'orca/host'
import type { OrcaWorkerApi } from 'orca/worker'
import { LocalCallbackServer, type CallbackHandlers } from './bot/callback-server'
import { OrcaWebhookDispatcher, type BotDispatcher } from './bot/webhook-dispatcher'
import { BridgeEngine } from './bridge-engine'
import { createLarkTransport } from './lark/node-sdk-transport'
import type { LarkTransport, LarkTransportStatus } from './lark/types'
import type { SettingsPatch } from './protocol'
import { BridgeStore } from './store'
import type { BridgeSettings, BridgeSnapshot, ConnectionSnapshot, TransportMode } from './types'

export const SECRET_APP_SECRET = 'feishu.appSecret'
const STATUS_BAR_ID = 'lark-bridge-status'

export interface WorkerTestOverrides {
  createTransport?: (settings: BridgeSettings, appSecret: string) => Promise<LarkTransport>
  createDispatcher?: (getSettings: () => BridgeSettings) => BotDispatcher
  runtimeFilePath?: string | null
  startCallbackServer?: boolean
  now?: () => number
}

let testOverrides: WorkerTestOverrides | null = null
let activeController: BridgeWorkerController | null = null

/** Test-only injection hook used by `mountWorker` unit tests. */
export function setWorkerTestOverrides(overrides: WorkerTestOverrides | null): void {
  testOverrides = overrides
}

/** Exposes the active worker controller for deterministic testing with `mountWorker`. */
export function getActiveBridgeController(): BridgeWorkerController | null {
  return activeController
}

function readString(map: Record<string, JsonValue>, key: string, fallback: string): string {
  const val = map[key]
  return typeof val === 'string' ? val : fallback
}

function readNumber(map: Record<string, JsonValue>, key: string, fallback: number): number {
  const val = map[key]
  return typeof val === 'number' && Number.isFinite(val) ? val : fallback
}

function readBoolean(map: Record<string, JsonValue>, key: string, fallback: boolean): boolean {
  const val = map[key]
  return typeof val === 'boolean' ? val : fallback
}

function parseSettings(raw: Record<string, JsonValue>): BridgeSettings {
  const modeRaw = readString(raw, 'transportMode', 'auto')
  const transportMode: TransportMode =
    modeRaw === 'direct' || modeRaw === 'node-sdk' ? modeRaw : 'auto'
  return {
    appId: readString(raw, 'appId', '').trim(),
    domain: readString(raw, 'domain', 'https://open.feishu.cn').trim() || 'https://open.feishu.cn',
    targetBot: readString(raw, 'targetBot', 'MyBot').trim() || 'MyBot',
    webhookUrl: readString(raw, 'webhookUrl', '').trim(),
    allowedChatIds: readString(raw, 'allowedChatIds', ''),
    transportMode,
    callbackPort: readNumber(raw, 'callbackPort', 0),
    requestTimeoutSec: Math.max(5, readNumber(raw, 'requestTimeoutSec', 300)),
    autoConnect: readBoolean(raw, 'autoConnect', true)
  }
}

export class BridgeWorkerController {
  readonly store: BridgeStore
  readonly engine: BridgeEngine
  private readonly orca: OrcaWorkerApi
  private readonly overrides: WorkerTestOverrides | null
  private readonly disposables: Disposable[] = []

  private settings: BridgeSettings = parseSettings({})
  private appSecret: string | null = null
  private transport: LarkTransport | null = null
  private callbackServer: LocalCallbackServer | null = null
  private transportStatus: LarkTransportStatus = {
    state: 'unconfigured',
    since: Date.now(),
    transportKind: 'none'
  }
  private dispatcher: BotDispatcher

  constructor(orca: OrcaWorkerApi, overrides: WorkerTestOverrides | null) {
    this.orca = orca
    this.overrides = overrides
    this.store = new BridgeStore(orca.storage)
    this.dispatcher =
      overrides?.createDispatcher?.(() => this.settings) ??
      new OrcaWebhookDispatcher({ getWebhookUrl: () => this.settings.webhookUrl })

    this.engine = new BridgeEngine({
      store: this.store,
      getSettings: () => this.settings,
      hasAppSecret: () => Boolean(this.appSecret && this.appSecret.trim().length > 0),
      getTransport: () => this.transport,
      getDispatcher: () => this.dispatcher,
      getConnectionSnapshot: () => this.buildConnectionSnapshot(),
      onSnapshotChanged: (snapshot) => {
        this.pushSnapshot(snapshot)
        void this.syncStatusBar(snapshot)
      },
      onNotify: (title, body) => {
        void this.orca.host.call('notifications.show', { title, body }).catch(() => undefined)
      },
      now: overrides?.now,
      log: (msg) => this.orca.log(msg)
    })
  }

  getCallbackServer(): LocalCallbackServer | null {
    return this.callbackServer
  }

  getTransport(): LarkTransport | null {
    return this.transport
  }

  private buildConnectionSnapshot(): ConnectionSnapshot {
    return {
      ...this.transportStatus,
      callbackUrl: this.callbackServer?.getCallbackUrl() ?? undefined,
      runtimeFilePath: this.callbackServer?.getRuntimeFilePath() ?? undefined
    }
  }

  private pushSnapshot(snapshot: BridgeSnapshot): void {
    this.orca.panels.post('bridge.snapshot', snapshot)
  }

  private async syncStatusBar(snapshot: BridgeSnapshot): Promise<void> {
    const state = snapshot.connection.state
    const inFlight = snapshot.stats.inFlight
    let text = 'Lark: Offline'
    let tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' = 'neutral'

    if (state === 'unconfigured') {
      text = 'Lark: Setup'
      tone = 'neutral'
    } else if (state === 'connecting') {
      text = 'Lark: Connecting…'
      tone = 'warning'
    } else if (state === 'connected') {
      text = inFlight > 0 ? `Lark: ${inFlight} running` : `Lark: ${snapshot.targetBot}`
      tone = inFlight > 0 ? 'accent' : 'success'
    } else if (state === 'error') {
      text = 'Lark: Error'
      tone = 'danger'
    }

    const tooltip = snapshot.connection.error
      ? `Lark Bot Bridge (${state}): ${snapshot.connection.error}`
      : `Lark Bot Bridge → ${snapshot.targetBot} (${state})`

    await this.orca.host
      .call('statusBar.update', {
        id: STATUS_BAR_ID,
        text,
        tone,
        tooltip
      })
      .catch(() => undefined)
  }

  async start(): Promise<void> {
    await this.reloadConfig()
    await this.engine.initialize()

    this.registerHandlers()
    this.registerCommands()

    this.disposables.push(
      this.orca.settings.onDidChange(() => {
        void this.reloadConfig().then(() => {
          this.engine.emitSnapshot()
        })
      })
    )

    // Start local loopback callback server when webhookUrl is configured or test explicitly asks.
    if (this.overrides?.startCallbackServer === true || this.settings.webhookUrl.length > 0) {
      await this.ensureCallbackServer()
    }

    if (this.settings.autoConnect && this.settings.appId && this.appSecret) {
      await this.connectTransport()
    } else {
      this.transportStatus = {
        state: this.settings.appId && this.appSecret ? 'offline' : 'unconfigured',
        since: (this.overrides?.now ?? Date.now)(),
        transportKind: 'none'
      }
      this.engine.emitSnapshot()
    }
  }

  async stop(): Promise<void> {
    for (const d of this.disposables) {
      d.dispose()
    }
    this.disposables.length = 0
    this.engine.dispose()
    if (this.transport) {
      await this.transport.stop().catch(() => undefined)
      this.transport = null
    }
    if (this.callbackServer) {
      await this.callbackServer.stop().catch(() => undefined)
      this.callbackServer = null
    }
  }

  private async reloadConfig(): Promise<void> {
    const rawSettings = await this.orca.settings.get()
    this.settings = parseSettings(rawSettings)
    this.appSecret = await this.orca.secrets.get(SECRET_APP_SECRET)
  }

  async ensureCallbackServer(): Promise<{ callbackUrl: string; token: string } | null> {
    if (this.overrides?.startCallbackServer === false) {
      return null
    }
    if (this.callbackServer && this.callbackServer.getCallbackUrl()) {
      return {
        callbackUrl: this.callbackServer.getCallbackUrl()!,
        token: this.callbackServer.getToken()
      }
    }
    const handlers: CallbackHandlers = {
      onProgress: (input) => this.engine.handleBotProgress(input),
      onComplete: (input) => this.engine.handleBotComplete(input),
      onFail: (input) => this.engine.handleBotFail(input)
    }
    const server = new LocalCallbackServer({
      port: this.settings.callbackPort,
      runtimeFilePath: this.overrides?.runtimeFilePath,
      handlers,
      log: (msg) => this.orca.log(msg)
    })
    const info = await server.start()
    this.callbackServer = server
    this.engine.emitSnapshot()
    return { callbackUrl: info.callbackUrl, token: info.token }
  }

  async connectTransport(): Promise<{ ok: boolean; state: ConnectionSnapshot['state']; error?: string }> {
    await this.reloadConfig()
    if (!this.settings.appId || !this.appSecret) {
      this.transportStatus = {
        state: 'unconfigured',
        since: (this.overrides?.now ?? Date.now)(),
        transportKind: 'none',
        error: '请先填写 Feishu App ID 并保存 App Secret'
      }
      this.engine.emitSnapshot()
      return { ok: false, state: 'unconfigured', error: this.transportStatus.error }
    }

    if (this.transport) {
      await this.transport.stop().catch(() => undefined)
      this.transport = null
    }

    if (this.settings.webhookUrl.length > 0 || this.overrides?.startCallbackServer === true) {
      await this.ensureCallbackServer()
    }

    try {
      const transport = this.overrides?.createTransport
        ? await this.overrides.createTransport(this.settings, this.appSecret)
        : await createLarkTransport(this.settings.transportMode, {
            appId: this.settings.appId,
            appSecret: this.appSecret,
            domain: this.settings.domain,
            log: (msg) => this.orca.log(msg)
          })

      this.transport = transport
      this.transportStatus = {
        state: 'connecting',
        since: (this.overrides?.now ?? Date.now)(),
        transportKind: transport.kind
      }
      this.engine.emitSnapshot()

      await transport.start(
        async (msg) => {
          await this.engine.handleIncomingMessage(msg)
        },
        (status) => {
          this.transportStatus = status
          this.engine.emitSnapshot()
        }
      )

      this.transportStatus = transport.getStatus()
      this.engine.emitSnapshot()
      return { ok: true, state: this.transportStatus.state }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.transportStatus = {
        state: 'error',
        since: (this.overrides?.now ?? Date.now)(),
        transportKind: 'none',
        error
      }
      this.engine.emitSnapshot()
      return { ok: false, state: 'error', error }
    }
  }

  async disconnectTransport(): Promise<void> {
    if (this.transport) {
      await this.transport.stop().catch(() => undefined)
      this.transport = null
    }
    this.transportStatus = {
      state: this.settings.appId && this.appSecret ? 'offline' : 'unconfigured',
      since: (this.overrides?.now ?? Date.now)(),
      transportKind: 'none'
    }
    this.engine.emitSnapshot()
  }

  private registerHandlers(): void {
    this.disposables.push(
      this.orca.panels.handle('bridge.getSnapshot', async () => {
        await this.reloadConfig()
        return this.engine.getSnapshot()
      }),

      this.orca.panels.handle('bridge.saveSecret', async ({ appSecret }) => {
        const trimmed = appSecret.trim()
        if (!trimmed) {
          throw Object.assign(new Error('App Secret cannot be empty'), { code: 'invalid_params' })
        }
        await this.orca.secrets.set(SECRET_APP_SECRET, trimmed)
        this.appSecret = trimmed
        if (this.transportStatus.state === 'unconfigured' && this.settings.appId) {
          this.transportStatus = {
            ...this.transportStatus,
            state: 'offline',
            error: undefined
          }
        }
        this.engine.emitSnapshot()
        return { ok: true as const, hasAppSecret: true }
      }),

      this.orca.panels.handle('bridge.clearSecret', async () => {
        await this.orca.secrets.delete(SECRET_APP_SECRET)
        this.appSecret = null
        await this.disconnectTransport()
        return { ok: true as const, hasAppSecret: false }
      }),

      this.orca.panels.handle('bridge.generatePairingCode', async () => {
        return this.engine.createPairingCode()
      }),

      this.orca.panels.handle('bridge.revokePairing', async () => {
        await this.engine.revokeOwnerPairing()
        return { ok: true as const }
      }),

      this.orca.panels.handle('bridge.reconnect', async () => {
        return this.connectTransport()
      }),

      this.orca.panels.handle('bridge.disconnect', async () => {
        await this.disconnectTransport()
        return { ok: true as const }
      }),

      this.orca.panels.handle('bridge.updateSettings', async (patch: SettingsPatch) => {
        const keys: (keyof SettingsPatch)[] = [
          'appId',
          'domain',
          'targetBot',
          'webhookUrl',
          'allowedChatIds'
        ]
        for (const key of keys) {
          const val = patch[key]
          if (typeof val === 'string') {
            await this.orca.settings.set(key, val)
          }
        }
        await this.reloadConfig()
        if (this.settings.webhookUrl.length > 0 && !this.callbackServer) {
          await this.ensureCallbackServer()
        }
        this.engine.emitSnapshot()
        return this.engine.getSnapshot()
      }),

      this.orca.panels.handle('bridge.sweepTimeouts', async () => {
        const timedOutIds = await this.engine.sweepTimeouts()
        return { timedOutIds }
      })
    )
  }

  private registerCommands(): void {
    this.disposables.push(
      this.orca.commands.register('lark-bot-bridge.reconnect', async () => {
        const res = await this.connectTransport()
        return res.ok ? `Lark Bot Bridge connected (${res.state})` : `Reconnect failed: ${res.error}`
      }),

      this.orca.commands.register('lark-bot-bridge.generate-pairing-code', async () => {
        const { code } = await this.engine.createPairingCode()
        return `Pairing code (valid 10m): ${code} — send "/pair ${code}" to the bot in Feishu DM.`
      }),

      this.orca.commands.register('lark-bot-bridge.status', async () => {
        const snap = this.engine.getSnapshot()
        return `State=${snap.connection.state}, Bot=${snap.targetBot}, Owner=${
          snap.ownerPairing.ownerOpenId ?? 'unpaired'
        }, Requests=${snap.stats.totalRequests}`
      })
    )
  }
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  if (activeController) {
    await activeController.stop()
  }
  const controller = new BridgeWorkerController(orca, testOverrides)
  activeController = controller
  await controller.start()
}

export async function deactivate(): Promise<void> {
  if (activeController) {
    const ctrl = activeController
    activeController = null
    await ctrl.stop()
  }
}
