import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panel from './panel'
import type { BridgeSnapshot } from './types'

let view: TestPanel | undefined
afterEach(async () => {
  if (view) {
    await view.unmount()
    view = undefined
  }
})

function makeSnapshot(overrides: Partial<BridgeSnapshot> = {}): BridgeSnapshot {
  return {
    connection: {
      state: 'offline',
      since: 1_795_666_800_000,
      transportKind: 'direct',
      callbackUrl: 'http://127.0.0.1:41937'
    },
    targetBot: 'MyBot',
    appId: 'cli_demo_app',
    domain: 'https://open.feishu.cn',
    hasAppSecret: false,
    webhookConfigured: true,
    webhookUrlPreview: 'https://hooks.orca.test/…',
    routes: [
      {
        name: 'MyBot',
        webhookConfigured: true,
        webhookUrlPreview: 'https://hooks.orca.test/…',
        isDefault: true
      },
      {
        name: 'Coder',
        webhookConfigured: true,
        webhookUrlPreview: 'https://hooks.orca.test/…',
        isDefault: false
      }
    ],
    allowedChatIds: ['oc_team_1'],
    requestTimeoutSec: 300,
    ownerPairing: {},
    recentRequests: [],
    stats: {
      totalRequests: 0,
      inFlight: 0,
      completed: 0,
      failedOrTimeout: 0,
      dedupedMessages: 0,
      bindingsCount: 0
    },
    ...overrides
  }
}

test('renders bridge status, generates pairing code, saves secret safely, and updates on worker snapshot push', async () => {
  let state = makeSnapshot()
  let savedSecret = ''

  const host = mockHost({
    requests: {
      'bridge.getSnapshot': () => state,
      'bridge.generatePairingCode': () => {
        const pendingCode = {
          code: '654321',
          createdAt: 1_795_666_800_000,
          expiresAt: 1_795_667_400_000,
          attempts: 0,
          maxAttempts: 5
        }
        state = { ...state, ownerPairing: { pendingCode } }
        return { code: pendingCode.code, expiresAt: pendingCode.expiresAt }
      },
      'bridge.saveSecret': ({ appSecret }) => {
        savedSecret = appSecret
        state = { ...state, hasAppSecret: true }
        return { ok: true as const, hasAppSecret: true }
      },
      'bridge.revokePairing': () => {
        state = { ...state, ownerPairing: {} }
        return { ok: true as const }
      }
    }
  })

  view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Lark Bot' }))
  assert.ok(view.find({ text: 'MyBot' }))
  assert.ok(view.find({ text: '/MyBot' }))
  assert.ok(view.find({ text: '/Coder' }))
  assert.ok(view.find({ text: 'Unpaired' }))
  assert.ok(view.find({ text: 'Missing' }))
  assert.equal(JSON.stringify(view.tree()).includes('secret_token'), false)

  // Generate 6-digit pairing code.
  await view.press({ text: '生成配对码' })
  assert.ok(view.find({ text: '654321' }))

  // Save App Secret -> input clears after saving and badge turns to Saved in Keyring.
  await view.type({ label: 'Feishu App Secret' }, 'sec_live_xyz')
  await view.press({ text: '保存 Secret' })
  assert.equal(savedSecret, 'sec_live_xyz')
  assert.equal(view.valueOf({ label: 'Feishu App Secret' }), '')
  assert.ok(view.find({ text: 'Saved in Keyring' }))

  // Worker pushes a live snapshot update (e.g. online + completed request).
  await view.post(
    'bridge.snapshot',
    makeSnapshot({
      hasAppSecret: true,
      connection: {
        state: 'connected',
        since: 1_795_666_900_000,
        lastEventAt: 1_795_666_950_000,
        transportKind: 'direct',
        callbackUrl: 'http://127.0.0.1:41937'
      },
      ownerPairing: {
        ownerOpenId: 'ou_owner_verified',
        ownerDmChatId: 'oc_dm_1',
        pairedAt: 1_795_666_850_000
      },
      recentRequests: [
        {
          requestId: 'req_ui_1',
          messageId: 'om_ui_1',
          chatId: 'oc_dm_1',
          chatType: 'p2p',
          conversationKey: 'k1',
          targetBot: 'MyBot',
          status: 'posted',
          outcome: 'completed',
          promptSummary: '整理发布清单',
          answerPreview: '已整理完成',
          createdAt: 1_795_666_920_000,
          updatedAt: 1_795_666_950_000
        }
      ],
      stats: {
        totalRequests: 1,
        inFlight: 0,
        completed: 1,
        failedOrTimeout: 0,
        dedupedMessages: 1,
        bindingsCount: 1
      }
    })
  )

  assert.ok(view.find({ text: 'Online' }))
  assert.ok(view.find({ text: 'Paired' }))
  assert.ok(view.find({ type: 'ListItem', text: /整理发布清单/ }))

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
})
