// The panel <-> worker contract, declared once so src/panel.tsx and src/worker.ts stay typed.
import type { BridgeSettings, BridgeSnapshot, ConnectionState } from './types'

export type SettingsPatch = Partial<
  Pick<BridgeSettings, 'appId' | 'domain' | 'targetBot' | 'webhookUrl' | 'botRoutes' | 'allowedChatIds'>
>

declare module 'orca' {
  interface PluginRequests {
    /** Full bridge snapshot for rendering the right-sidebar panel. */
    'bridge.getSnapshot': { output: BridgeSnapshot }
    /** Persists Feishu App Secret in Orca secrets:own without echoing it back. */
    'bridge.saveSecret': {
      input: { appSecret: string }
      output: { ok: true; hasAppSecret: boolean }
    }
    /** Clears stored Feishu App Secret from secrets:own. */
    'bridge.clearSecret': { output: { ok: true; hasAppSecret: boolean } }
    /** Generates a 6-digit random pairing code (10m TTL, max 5 failed attempts). */
    'bridge.generatePairingCode': {
      output: { code: string; expiresAt: number }
    }
    /** Revokes the currently paired Owner open_id and any pending pairing code. */
    'bridge.revokePairing': { output: { ok: true } }
    /** Reconnects the Feishu persistent WebSocket transport using current settings & secret. */
    'bridge.reconnect': {
      output: { ok: boolean; state: ConnectionState; error?: string }
    }
    /** Disconnects the active Feishu transport cleanly. */
    'bridge.disconnect': { output: { ok: true } }
    /** Updates basic bridge settings from the sidebar panel. */
    'bridge.updateSettings': {
      input: SettingsPatch
      output: BridgeSnapshot
    }
    /** Sweeps overdue in-flight requests and transitions them to timeout -> posted. */
    'bridge.sweepTimeouts': {
      output: { timedOutIds: string[] }
    }
  }

  interface PluginPanelEvents {
    /** Pushed to every open panel whenever connection, pairing, or request state changes. */
    'bridge.snapshot': BridgeSnapshot
  }
}
