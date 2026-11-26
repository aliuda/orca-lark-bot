import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import type { BotDispatchPayload, BotDispatcher } from './bot/webhook-dispatcher'
import type { LarkIncomingMessage } from './lark/types'
import { MockLarkTransport } from './mock-transport'
import * as main from './worker'
import { getActiveBridgeController, SECRET_APP_SECRET, setWorkerTestOverrides } from './worker'

function makeMessage(overrides: Partial<LarkIncomingMessage> = {}): LarkIncomingMessage {
  return {
    messageId: 'om_default_1',
    chatId: 'oc_dm_owner',
    chatType: 'p2p',
    senderOpenId: 'ou_owner_1',
    senderType: 'user',
    senderName: 'Owner',
    messageType: 'text',
    rawContent: JSON.stringify({ text: overrides.text ?? 'hello' }),
    text: 'hello',
    mentions: [],
    createTimeMs: 1_795_666_800_000,
    ...overrides
  }
}

function makeMockDispatcher(): {
  dispatcher: BotDispatcher
  dispatched: BotDispatchPayload[]
} {
  const dispatched: BotDispatchPayload[] = []
  return {
    dispatched,
    dispatcher: {
      async dispatch(payload) {
        dispatched.push(payload)
        return { accepted: true, statusCode: 200 }
      }
    }
  }
}

function cardText(card: Record<string, unknown>): string {
  return JSON.stringify(card)
}

afterEach(async () => {
  await main.deactivate()
  setWorkerTestOverrides(null)
})

test('concurrent out-of-order completion routes each answer back to its exact message_id & thread_id without crosstalk', async () => {
  let fakeNow = 1_795_666_800_000
  const transport = new MockLarkTransport({ botOpenId: 'ou_bot_demo' })
  const { dispatcher, dispatched } = makeMockDispatcher()

  setWorkerTestOverrides({
    createTransport: async () => transport,
    createDispatcher: () => dispatcher,
    startCallbackServer: false,
    now: () => fakeNow
  })

  const host = mockHost({
    settings: {
      appId: 'cli_team_app',
      domain: 'https://open.feishu.cn',
      targetBot: 'MyBot',
      webhookUrl: 'https://orca.local/webhook/mock',
      allowedChatIds: 'oc_team_group',
      requestTimeoutSec: 300,
      autoConnect: true
    },
    secrets: { [SECRET_APP_SECRET]: 'sec_test_123' }
  })

  const worker = await mountWorker(main, { host })

  // Pair owner via 6-digit pairing code first.
  const { code } = await worker.request('bridge.generatePairingCode')
  await transport.simulateIncoming(
    makeMessage({
      messageId: 'om_pair_1',
      chatId: 'oc_dm_owner',
      chatType: 'p2p',
      senderOpenId: 'ou_owner_1',
      text: `/pair ${code}`
    })
  )
  assert.equal(dispatched.length, 0, 'pairing message must not wake Bot')

  // Fire Req-1 and Req-2 back-to-back in the SAME opt-in group chat with different threads.
  await transport.simulateIncoming(
    makeMessage({
      messageId: 'om_req_1',
      chatId: 'oc_team_group',
      chatType: 'group',
      threadId: 'omt_thread_1',
      senderOpenId: 'ou_owner_1',
      text: '@MyBot /agent 检查任务一',
      mentions: [{ key: '@_user_1', openId: 'ou_bot_demo', name: 'MyBot' }]
    })
  )
  fakeNow += 50
  await transport.simulateIncoming(
    makeMessage({
      messageId: 'om_req_2',
      chatId: 'oc_team_group',
      chatType: 'group',
      threadId: 'omt_thread_2',
      senderOpenId: 'ou_owner_1',
      text: '@MyBot /agent 检查任务二',
      mentions: [{ key: '@_user_1', openId: 'ou_bot_demo', name: 'MyBot' }]
    })
  )

  assert.equal(dispatched.length, 2)
  const req1 = dispatched[0]
  const req2 = dispatched[1]
  assert.notEqual(req1.request_id, req2.request_id)
  assert.equal(req1.message_id, 'om_req_1')
  assert.equal(req1.thread_id, 'omt_thread_1')
  assert.equal(req2.message_id, 'om_req_2')
  assert.equal(req2.thread_id, 'omt_thread_2')

  // Initial cards were posted to their exact respective messages in-thread.
  assert.equal(transport.cardReplies.length, 2)
  const card1 = transport.cardReplies[0]
  const card2 = transport.cardReplies[1]
  assert.equal(card1.targetMessageId, 'om_req_1')
  assert.equal(card1.replyInThread, true)
  assert.equal(card2.targetMessageId, 'om_req_2')
  assert.equal(card2.replyInThread, true)

  const controller = getActiveBridgeController()
  assert.ok(controller)

  // Out-of-order completion: Req-2 finishes BEFORE Req-1!
  fakeNow += 1000
  const prog2 = await controller.engine.handleBotProgress({
    requestId: req2.request_id,
    stage: 'Testing',
    text: 'Req-2 正在跑测试'
  })
  assert.equal(prog2.ok, true)

  fakeNow += 500
  const done2 = await controller.engine.handleBotComplete({
    requestId: req2.request_id,
    answer: 'ANSWER_FOR_REQ_2_ONLY'
  })
  assert.equal(done2.ok, true)

  fakeNow += 1500
  const done1 = await controller.engine.handleBotComplete({
    requestId: req1.request_id,
    answer: 'ANSWER_FOR_REQ_1_ONLY'
  })
  assert.equal(done1.ok, true)

  // Verify card2 got Req-2's answer and NEVER Req-1's, and card1 got Req-1's answer and NEVER Req-2's!
  const card2FinalPatch = transport.cardPatches
    .filter((p) => p.messageId === card2.replyMessageId)
    .at(-1)
  const card1FinalPatch = transport.cardPatches
    .filter((p) => p.messageId === card1.replyMessageId)
    .at(-1)

  assert.ok(card2FinalPatch, 'Req-2 card must be patched with final answer')
  assert.ok(card1FinalPatch, 'Req-1 card must be patched with final answer')
  assert.match(cardText(card2FinalPatch.card), /ANSWER_FOR_REQ_2_ONLY/)
  assert.equal(/ANSWER_FOR_REQ_1_ONLY/.test(cardText(card2FinalPatch.card)), false)
  assert.match(cardText(card1FinalPatch.card), /ANSWER_FOR_REQ_1_ONLY/)
  assert.equal(/ANSWER_FOR_REQ_2_ONLY/.test(cardText(card1FinalPatch.card)), false)

  // Verify OnIt -> DONE reaction swap happened on BOTH original message IDs.
  assert.ok(
    transport.reactions.some(
      (r) => r.action === 'add' && r.messageId === 'om_req_1' && r.emojiType === 'OnIt'
    )
  )
  assert.ok(
    transport.reactions.some(
      (r) => r.action === 'add' && r.messageId === 'om_req_1' && r.emojiType === 'DONE'
    )
  )
  assert.ok(
    transport.reactions.some(
      (r) => r.action === 'add' && r.messageId === 'om_req_2' && r.emojiType === 'DONE'
    )
  )

  // Verify persisted records reflect final posted state and distinct conversation bindings.
  const rec1 = controller.store.getRequest(req1.request_id)
  const rec2 = controller.store.getRequest(req2.request_id)
  assert.equal(rec1?.status, 'posted')
  assert.equal(rec1?.outcome, 'completed')
  assert.equal(rec2?.status, 'posted')
  assert.equal(rec2?.outcome, 'completed')
  assert.notEqual(rec1?.conversationKey, rec2?.conversationKey)
  assert.deepEqual(worker.refusals, [])

  await worker.deactivate()
})

test('dedupes duplicate message_id, blocks non-owner DM without waking Bot, and recovers bindings & dedupe across worker restart', async () => {
  let fakeNow = 1_795_667_000_000
  let transport = new MockLarkTransport()
  const { dispatcher, dispatched } = makeMockDispatcher()

  setWorkerTestOverrides({
    createTransport: async () => transport,
    createDispatcher: () => dispatcher,
    startCallbackServer: false,
    now: () => fakeNow
  })

  const host = mockHost({
    settings: {
      appId: 'cli_team_app',
      domain: 'https://open.feishu.cn',
      targetBot: 'MyBot',
      webhookUrl: 'https://orca.local/webhook/mock',
      allowedChatIds: '',
      requestTimeoutSec: 60,
      autoConnect: true
    },
    secrets: { [SECRET_APP_SECRET]: 'sec_test_123' }
  })

  const worker1 = await mountWorker(main, { host })

  // 1. Before pairing, DM is intercepted with pairing guidance and does NOT wake Bot.
  await transport.simulateIncoming(
    makeMessage({
      messageId: 'om_unpaired_dm',
      senderOpenId: 'ou_stranger',
      text: '帮我执行命令'
    })
  )
  assert.equal(dispatched.length, 0)
  assert.equal(transport.textReplies.length, 1)
  assert.match(transport.textReplies[0].text, /配对码/)

  // 2. Pair legitimate Owner via 6-digit code.
  const { code } = await worker1.request('bridge.generatePairingCode')
  await transport.simulateIncoming(
    makeMessage({
      messageId: 'om_pair_ok',
      senderOpenId: 'ou_owner_real',
      text: `/pair ${code}`
    })
  )

  // 3. Non-owner DM after pairing is still rejected without waking Bot.
  await transport.simulateIncoming(
    makeMessage({
      messageId: 'om_other_user_dm',
      senderOpenId: 'ou_stranger_2',
      text: '试探一下'
    })
  )
  assert.equal(dispatched.length, 0)
  assert.match(transport.textReplies.at(-1)?.text ?? '', /已绑定其他 Owner/)

  // 4. Owner DM dispatches once; re-delivering the exact same message_id is deduped!
  await transport.simulateIncoming(
    makeMessage({
      messageId: 'om_owner_msg_1',
      senderOpenId: 'ou_owner_real',
      text: '总结一下今天的任务'
    })
  )
  await transport.simulateIncoming(
    makeMessage({
      messageId: 'om_owner_msg_1',
      senderOpenId: 'ou_owner_real',
      text: '总结一下今天的任务'
    })
  )
  assert.equal(dispatched.length, 1, 'duplicate message_id must only dispatch once')

  // 5. Simulate WORKER RESTART on the SAME host (preserving orca.storage, wiping in-memory state).
  await worker1.deactivate()
  transport = new MockLarkTransport()
  setWorkerTestOverrides({
    createTransport: async () => transport,
    createDispatcher: () => dispatcher,
    startCallbackServer: false,
    now: () => fakeNow
  })

  const worker2 = await mountWorker(main, { host })
  const snapAfterRestart = await worker2.request('bridge.getSnapshot')
  assert.equal(snapAfterRestart.ownerPairing.ownerOpenId, 'ou_owner_real')
  assert.equal(snapAfterRestart.stats.bindingsCount, 1)
  assert.ok(snapAfterRestart.stats.dedupedMessages >= 4)

  // Replaying `om_owner_msg_1` AFTER restart must STILL be deduped from persisted storage!
  await transport.simulateIncoming(
    makeMessage({
      messageId: 'om_owner_msg_1',
      senderOpenId: 'ou_owner_real',
      text: '总结一下今天的任务'
    })
  )
  assert.equal(dispatched.length, 1, 'dedupe must survive worker restart')

  // Sending a brand-new message from the restored owner works immediately without re-pairing!
  await transport.simulateIncoming(
    makeMessage({
      messageId: 'om_owner_msg_2',
      senderOpenId: 'ou_owner_real',
      text: '继续刚才的话题'
    })
  )
  assert.equal(dispatched.length, 2)
  assert.equal(
    dispatched[1].conversation_key,
    dispatched[0].conversation_key,
    'same DM session keeps stable conversation_key across restart'
  )
  assert.deepEqual(worker2.refusals, [])

  await worker2.deactivate()
})

test('updates Feishu card to timeout state when Bot never calls back and rejects stale late callbacks', async () => {
  let fakeNow = 1_795_668_000_000
  const transport = new MockLarkTransport()
  const { dispatcher, dispatched } = makeMockDispatcher()

  setWorkerTestOverrides({
    createTransport: async () => transport,
    createDispatcher: () => dispatcher,
    startCallbackServer: false,
    now: () => fakeNow
  })

  const host = mockHost({
    settings: {
      appId: 'cli_team_app',
      domain: 'https://open.feishu.cn',
      targetBot: 'MyBot',
      webhookUrl: 'https://orca.local/webhook/mock',
      requestTimeoutSec: 30,
      autoConnect: true
    },
    secrets: { [SECRET_APP_SECRET]: 'sec_test_123' },
    storage: {
      'bridge:owner:v1': {
        ownerOpenId: 'ou_owner_1',
        ownerDmChatId: 'oc_dm_owner',
        pairedAt: fakeNow - 10_000
      }
    }
  })

  const worker = await mountWorker(main, { host })

  await transport.simulateIncoming(
    makeMessage({
      messageId: 'om_slow_msg',
      senderOpenId: 'ou_owner_1',
      text: '帮我查一个超时任务'
    })
  )
  assert.equal(dispatched.length, 1)
  const reqId = dispatched[0].request_id
  const initialCardId = transport.cardReplies[0].replyMessageId

  // Advance clock past 30s deadline and sweep timeouts.
  fakeNow += 31_000
  const { timedOutIds } = await worker.request('bridge.sweepTimeouts')
  assert.deepEqual(timedOutIds, [reqId])

  // Feishu card was patched with clear timeout notice (not hung indefinitely).
  const timeoutPatch = transport.cardPatches
    .filter((p) => p.messageId === initialCardId)
    .at(-1)
  assert.ok(timeoutPatch)
  assert.match(cardText(timeoutPatch.card), /TIMEOUT/)
  assert.match(cardText(timeoutPatch.card), /超时/)

  // Desktop notification surfaced to user.
  assert.ok(worker.host.callsOf('notifications.show').length >= 1)

  // Stale callback arriving after timeout is cleanly rejected as already_settled.
  const controller = getActiveBridgeController()
  assert.ok(controller)
  const late = await controller.engine.handleBotComplete({
    requestId: reqId,
    answer: '迟到的回复'
  })
  assert.equal(late.ok, false)
  assert.equal(late.code, 'already_settled')

  // Verify reply_in_thread fallback behavior when patchCard fails too.
  transport.failThreadReplyForMessageIds.add('om_fallback_msg')
  await transport.simulateIncoming(
    makeMessage({
      messageId: 'om_fallback_msg',
      chatId: 'oc_dm_owner',
      chatType: 'p2p',
      rootId: 'om_root_1',
      senderOpenId: 'ou_owner_1',
      text: '测试 thread 回退'
    })
  )
  const fbReply = transport.cardReplies.find((r) => r.targetMessageId === 'om_fallback_msg')
  assert.ok(fbReply)
  assert.equal(fbReply.replyInThread, false, 'falls back to quoted reply when thread creation rejected')

  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('enforces opt-in group allowlist, @bot /agent prefix, pairing lockout/expiry, and restart timeout recovery', async () => {
  let fakeNow = 1_795_669_000_000
  let transport = new MockLarkTransport({ botOpenId: 'ou_bot_demo' })
  const { dispatcher, dispatched } = makeMockDispatcher()

  setWorkerTestOverrides({
    createTransport: async () => transport,
    createDispatcher: () => dispatcher,
    startCallbackServer: false,
    now: () => fakeNow
  })

  const host = mockHost({
    settings: {
      appId: 'cli_team_app',
      domain: 'https://open.feishu.cn',
      targetBot: 'MyBot',
      webhookUrl: 'https://orca.local/webhook/mock',
      allowedChatIds: 'oc_allowed_group',
      requestTimeoutSec: 30,
      autoConnect: true
    },
    secrets: { [SECRET_APP_SECRET]: 'sec_test_123' }
  })

  const worker1 = await mountWorker(main, { host })

  // 1. Pairing lockout after 5 invalid attempts.
  await worker1.request('bridge.generatePairingCode')
  for (let i = 1; i <= 5; i++) {
    await transport.simulateIncoming(
      makeMessage({
        messageId: `om_bad_pair_${i}`,
        senderOpenId: 'ou_owner_1',
        text: `/pair 00000${i}`
      })
    )
  }
  assert.match(transport.textReplies.at(-1)?.text ?? '', /已达上限/)
  assert.equal((await worker1.request('bridge.getSnapshot')).ownerPairing.pendingCode, undefined)

  // 2. Pairing expiry after > 10 minutes.
  const { code: expCode } = await worker1.request('bridge.generatePairingCode')
  fakeNow += 11 * 60 * 1000
  await transport.simulateIncoming(
    makeMessage({
      messageId: 'om_expired_pair',
      senderOpenId: 'ou_owner_1',
      text: `/pair ${expCode}`
    })
  )
  assert.match(transport.textReplies.at(-1)?.text ?? '', /已过期/)

  // 3. Valid pairing succeeds.
  const { code: okCode } = await worker1.request('bridge.generatePairingCode')
  await transport.simulateIncoming(
    makeMessage({
      messageId: 'om_good_pair',
      senderOpenId: 'ou_owner_1',
      text: okCode
    })
  )
  assert.equal((await worker1.request('bridge.getSnapshot')).ownerPairing.ownerOpenId, 'ou_owner_1')

  // 4. Unlisted group is silently ignored (zero replies, zero dispatch).
  const repliesBefore = transport.textReplies.length
  await transport.simulateIncoming(
    makeMessage({
      messageId: 'om_unlisted_group',
      chatId: 'oc_random_group',
      chatType: 'group',
      senderOpenId: 'ou_owner_1',
      text: '@MyBot /agent 忽略我',
      mentions: [{ key: '@_user_1', openId: 'ou_bot_demo', name: 'MyBot' }]
    })
  )
  assert.equal(transport.textReplies.length, repliesBefore)
  assert.equal(dispatched.length, 0)

  // 5. Listed group without `/agent` prefix (or `/agents`) is silently ignored.
  await transport.simulateIncoming(
    makeMessage({
      messageId: 'om_no_prefix',
      chatId: 'oc_allowed_group',
      chatType: 'group',
      senderOpenId: 'ou_owner_1',
      text: '@MyBot /agents 列出列表',
      mentions: [{ key: '@_user_1', openId: 'ou_bot_demo', name: 'MyBot' }]
    })
  )
  assert.equal(dispatched.length, 0)

  // 6. Listed group with `@bot /agent` from non-owner is rejected without waking Bot.
  await transport.simulateIncoming(
    makeMessage({
      messageId: 'om_group_non_owner',
      chatId: 'oc_allowed_group',
      chatType: 'group',
      senderOpenId: 'ou_other_member',
      text: '@MyBot /agent 帮我删库',
      mentions: [{ key: '@_user_1', openId: 'ou_bot_demo', name: 'MyBot' }]
    })
  )
  assert.equal(dispatched.length, 0)
  assert.match(transport.textReplies.at(-1)?.text ?? '', /仅已配对的本机 Owner/)

  // 7. Listed group with `@bot /agent` from Owner dispatches; then simulate crash & restart past deadline.
  await transport.simulateIncoming(
    makeMessage({
      messageId: 'om_group_ok_restart',
      chatId: 'oc_allowed_group',
      chatType: 'group',
      senderOpenId: 'ou_owner_1',
      text: '@MyBot /agent 帮我排查构建',
      mentions: [{ key: '@_user_1', openId: 'ou_bot_demo', name: 'MyBot' }]
    })
  )
  assert.equal(dispatched.length, 1)
  const pendingReqId = dispatched[0].request_id

  await worker1.deactivate()
  // Restart 45s later (past 30s timeout): engine.initialize() should auto-reconcile to timeout -> posted!
  fakeNow += 45_000
  transport = new MockLarkTransport({ botOpenId: 'ou_bot_demo' })
  setWorkerTestOverrides({
    createTransport: async () => transport,
    createDispatcher: () => dispatcher,
    startCallbackServer: false,
    now: () => fakeNow
  })
  const worker2 = await mountWorker(main, { host })
  const ctrl = getActiveBridgeController()
  assert.ok(ctrl)
  const reconciled = ctrl.store.getRequest(pendingReqId)
  assert.equal(reconciled?.status, 'posted')
  assert.equal(reconciled?.outcome, 'timeout')
  assert.deepEqual(worker2.refusals, [])

  await worker2.deactivate()
})
