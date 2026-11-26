import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assert, test } from 'orca/testing'
import { LocalCallbackServer } from './bot/callback-server'
import { OrcaWebhookDispatcher } from './bot/webhook-dispatcher'
import { parseFeishuReceiveEvent } from './lark/feishu-transport'
import {
  FRAME_METHOD_DATA,
  FrameFragmentAssembler,
  getFrameHeader,
  marshalPbbp2Frame,
  unmarshalPbbp2Frame,
  type Pbbp2Frame
} from './lark/pbbp2-frame'

test('pbbp2.Frame protobuf codec round-trips frames and reassembles split fragments', () => {
  const payload = new TextEncoder().encode('{"hello":"feishu"}')
  const frame: Pbbp2Frame = {
    seqId: 42n,
    logId: 9007199254740993n,
    service: 12345,
    method: FRAME_METHOD_DATA,
    headers: [
      { key: 'type', value: 'event' },
      { key: 'message_id', value: 'msg_part_1' },
      { key: 'sum', value: '2' },
      { key: 'seq', value: '0' }
    ],
    payloadEncoding: 'utf-8',
    payloadType: 'json',
    payload,
    logIdNew: 'log_new_1'
  }

  const encoded = marshalPbbp2Frame(frame)
  const decoded = unmarshalPbbp2Frame(encoded)
  assert.ok(decoded)
  assert.equal(decoded.seqId, 42n)
  assert.equal(decoded.logId, 9007199254740993n)
  assert.equal(decoded.service, 12345)
  assert.equal(decoded.method, FRAME_METHOD_DATA)
  assert.equal(getFrameHeader(decoded, 'type'), 'event')
  assert.equal(decoded.payloadEncoding, 'utf-8')
  assert.equal(decoded.payloadType, 'json')
  assert.equal(decoded.logIdNew, 'log_new_1')
  assert.equal(new TextDecoder().decode(decoded.payload), '{"hello":"feishu"}')

  // Multi-part reassembly (out of order arrival: seq 1 then seq 0).
  const assembler = new FrameFragmentAssembler(5000)
  const part0 = new TextEncoder().encode('{"part":"A",')
  const part1 = new TextEncoder().encode('"part2":"B"}')
  assert.equal(assembler.push('m1', 2, 1, part1, 1000), null)
  const joined = assembler.push('m1', 2, 0, part0, 1200)
  assert.ok(joined)
  assert.equal(new TextDecoder().decode(joined), '{"part":"A","part2":"B"}')

  // Parse Feishu im.message.receive_v1 event JSON.
  const incoming = parseFeishuReceiveEvent(
    JSON.stringify({
      header: { event_id: 'ev_1', event_type: 'im.message.receive_v1', create_time: '1795666800000' },
      event: {
        sender: { sender_id: { open_id: 'ou_abc' }, sender_type: 'user' },
        message: {
          message_id: 'om_123',
          chat_id: 'oc_456',
          chat_type: 'group',
          thread_id: 'omt_789',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 /MyBot hello' }),
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'MyBot' }]
        }
      }
    })
  )
  assert.ok(incoming)
  assert.equal(incoming.messageId, 'om_123')
  assert.equal(incoming.threadId, 'omt_789')
  assert.equal(incoming.mentions[0]?.openId, 'ou_bot')
})

test('stdio MCP bridge (`scripts/mcp-bridge.mjs`) authenticates and delivers progress/complete to LocalCallbackServer', async () => {
  const receivedProgress: Array<{ requestId: string; text: string; stage?: string }> = []
  const receivedCompletes: Array<{ requestId: string; answer: string }> = []
  const runtimeFilePath = join(tmpdir(), `orca-lark-bridge-test-${process.pid}-${Date.now()}.json`)

  const server = new LocalCallbackServer({
    port: 0,
    runtimeFilePath,
    handlers: {
      async onProgress(input) {
        receivedProgress.push(input)
        return { ok: true }
      },
      async onComplete(input) {
        receivedCompletes.push(input)
        return { ok: true }
      },
      async onFail() {
        return { ok: true }
      }
    }
  })

  const { callbackUrl } = await server.start()
  try {
    // 1. Unauthorized HTTP request MUST be rejected with 401.
    const unauth = await fetch(`${callbackUrl}/callback/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: 'req_1', answer: 'nope' })
    })
    assert.equal(unauth.status, 401)

    // 2. Spawn real stdio MCP bridge (`scripts/mcp-bridge.mjs`) pointing at runtimeFilePath.
    const scriptPath = resolve('scripts/mcp-bridge.mjs')
    const child = spawn('node', [scriptPath], {
      env: { ...process.env, ORCA_LARK_BRIDGE_RUNTIME: runtimeFilePath },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const responses: Record<string, unknown>[] = []
    let buffer = ''
    const waitForCount = (expected: number): Promise<void> =>
      new Promise((resolveWait, rejectWait) => {
        const timer = setTimeout(() => rejectWait(new Error(`Timed out waiting for ${expected} MCP responses`)), 5000)
        const check = (): void => {
          if (responses.length >= expected) {
            clearTimeout(timer)
            resolveWait()
          }
        }
        child.stdout.on('data', (chunk: string) => {
          buffer += chunk
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            responses.push(JSON.parse(line) as Record<string, unknown>)
          }
          check()
        })
        check()
      })
    child.stdout.setEncoding('utf8')

    const sendRpc = (msg: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify(msg)}\n`)
    }

    const donePromise = waitForCount(4)
    sendRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    sendRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    sendRpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'lark_bridge_report_progress',
        arguments: { request_id: 'req_mcp_1', stage: 'Build', text: '正在编译校验' }
      }
    })
    sendRpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'lark_bridge_complete',
        arguments: { request_id: 'req_mcp_1', answer: '全部通过！' }
      }
    })

    await donePromise
    child.stdin.end()
    child.kill('SIGTERM')

    assert.equal(responses.length, 4)
    const toolsList = responses[1].result as { tools: Array<{ name: string }> }
    assert.deepEqual(
      toolsList.tools.map((t) => t.name),
      ['lark_bridge_report_progress', 'lark_bridge_complete', 'lark_bridge_fail']
    )
    assert.deepEqual(receivedProgress, [
      { requestId: 'req_mcp_1', stage: 'Build', text: '正在编译校验' }
    ])
    assert.deepEqual(receivedCompletes, [
      { requestId: 'req_mcp_1', answer: '全部通过！' }
    ])
  } finally {
    await server.stop()
  }
})

test('OrcaWebhookDispatcher retries fetch failed / 5xx with exponential backoff, exposes err.cause, never leaks URL, and skips retry on 4xx', async () => {
  const secretWebhookUrl = 'https://hooks.example.test/v1/wh/secret_key_should_never_leak'
  const basePayload = {
    request_id: 'req_retry_1',
    conversation_key: 'conv_1',
    chat_type: 'p2p' as const,
    message_id: 'om_retry_1',
    sender_name: 'Owner',
    target_bot: 'MyBot',
    text: 'ping',
    received_at: new Date().toISOString()
  }

  // 1. Two transient network failures (`fetch failed` with cause ECONNRESET & HTTP 503), succeeds on attempt 3.
  const observedDelays: number[] = []
  const seenRequestIds: string[] = []
  const logs: string[] = []
  let callCount = 0

  const dispatcher1 = new OrcaWebhookDispatcher({
    getWebhookUrl: () => secretWebhookUrl,
    sleepImpl: async (ms) => {
      observedDelays.push(ms)
    },
    log: (m) => logs.push(m),
    fetchImpl: (async (_url, init) => {
      callCount++
      const body = JSON.parse(String(init?.body ?? '{}')) as { request_id: string }
      seenRequestIds.push(body.request_id)
      if (callCount === 1) {
        const cause = Object.assign(new Error(`connect failed to ${secretWebhookUrl}`), {
          code: 'ECONNRESET',
          syscall: 'read'
        })
        throw Object.assign(new TypeError('fetch failed'), { cause })
      }
      if (callCount === 2) {
        return new Response('upstream busy', { status: 503 })
      }
      return new Response('ok', { status: 200 })
    }) as typeof fetch
  })

  const res1 = await dispatcher1.dispatch(basePayload)
  assert.equal(res1.accepted, true)
  assert.equal(res1.attempts, 3)
  assert.deepEqual(observedDelays, [600, 1800])
  assert.deepEqual(seenRequestIds, ['req_retry_1', 'req_retry_1', 'req_retry_1'])
  assert.equal(
    logs.some((line) => line.includes('secret_key_should_never_leak')),
    false,
    'logs must never leak webhook URL/key'
  )
  assert.equal(
    logs.some((line) => line.includes('ECONNRESET')),
    true,
    'logs must include underlying err.cause code'
  )

  // 2. All 3 attempts fail with ETIMEDOUT -> error surfaces cause without leaking webhook URL.
  const failDelays: number[] = []
  const dispatcher2 = new OrcaWebhookDispatcher({
    getWebhookUrl: () => secretWebhookUrl,
    sleepImpl: async (ms) => {
      failDelays.push(ms)
    },
    fetchImpl: (async () => {
      const cause = Object.assign(new Error(`timeout contacting ${secretWebhookUrl}`), {
        code: 'ETIMEDOUT'
      })
      throw Object.assign(new TypeError('fetch failed'), { cause })
    }) as typeof fetch
  })
  const res2 = await dispatcher2.dispatch(basePayload)
  assert.equal(res2.accepted, false)
  assert.equal(res2.attempts, 3)
  assert.deepEqual(failDelays, [600, 1800])
  assert.match(res2.error ?? '', /ETIMEDOUT/)
  assert.equal((res2.error ?? '').includes('secret_key_should_never_leak'), false)

  // 3. Non-retryable 400 fails immediately on attempt 1 without backoff retries.
  const noRetryDelays: number[] = []
  let attempts400 = 0
  const dispatcher3 = new OrcaWebhookDispatcher({
    getWebhookUrl: () => secretWebhookUrl,
    sleepImpl: async (ms) => {
      noRetryDelays.push(ms)
    },
    fetchImpl: (async () => {
      attempts400++
      return new Response('bad payload', { status: 400 })
    }) as typeof fetch
  })
  const res3 = await dispatcher3.dispatch(basePayload)
  assert.equal(res3.accepted, false)
  assert.equal(res3.statusCode, 400)
  assert.equal(res3.attempts, 1)
  assert.equal(attempts400, 1)
  assert.deepEqual(noRetryDelays, [])
})

test('LocalCallbackServer owner-checked stop preserves newer instance runtime.json during overlapping reloads', async () => {
  const runtimeFilePath = join(
    tmpdir(),
    `orca-lark-bridge-reload-race-${process.pid}-${Date.now()}.json`
  )
  const completedByB: Array<{ requestId: string; answer: string }> = []

  const serverA = new LocalCallbackServer({
    port: 0,
    runtimeFilePath,
    handlers: {
      async onProgress() {
        return { ok: true }
      },
      async onComplete() {
        return { ok: true }
      },
      async onFail() {
        return { ok: true }
      }
    }
  })

  const serverB = new LocalCallbackServer({
    port: 0,
    runtimeFilePath,
    handlers: {
      async onProgress() {
        return { ok: true }
      },
      async onComplete(input) {
        completedByB.push(input)
        return { ok: true }
      },
      async onFail() {
        return { ok: true }
      }
    }
  })

  try {
    // 1. Instance A starts and writes runtime.json.
    const infoA = await serverA.start()
    const rawAfterA = JSON.parse(await readFile(runtimeFilePath, 'utf8')) as {
      callbackUrl: string
      token: string
      pid: number
    }
    assert.equal(rawAfterA.callbackUrl, infoA.callbackUrl)
    assert.equal(rawAfterA.token, infoA.token)

    // 2. Instance B starts on the same runtimeFilePath and atomically overwrites runtime.json.
    const infoB = await serverB.start()
    assert.notEqual(infoB.callbackUrl, infoA.callbackUrl)
    assert.notEqual(infoB.token, infoA.token)

    // 3. Old instance A stops AFTER B started -> must NOT unlink B's runtime.json!
    await serverA.stop()
    const rawAfterAStop = JSON.parse(await readFile(runtimeFilePath, 'utf8')) as {
      callbackUrl: string
      token: string
      pid: number
    }
    assert.equal(rawAfterAStop.callbackUrl, infoB.callbackUrl)
    assert.equal(rawAfterAStop.token, infoB.token)
    assert.equal(rawAfterAStop.pid, process.pid)

    // 4. Callback using runtime.json still reaches instance B with 200 OK.
    const res = await fetch(`${rawAfterAStop.callbackUrl}/callback/complete`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${rawAfterAStop.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ request_id: 'req_reload_ok', answer: 'delivered to B' })
    })
    assert.equal(res.status, 200)
    assert.deepEqual(completedByB, [{ requestId: 'req_reload_ok', answer: 'delivered to B' }])

    // 5. Instance B stops -> now runtime.json matches B and is cleanly removed.
    await serverB.stop()
    let readAfterBStopFailed = false
    try {
      await readFile(runtimeFilePath, 'utf8')
    } catch {
      readAfterBStopFailed = true
    }
    assert.equal(readAfterBStopFailed, true, 'runtime.json should be unlinked when owner B stops')
  } finally {
    await serverA.stop()
    await serverB.stop()
  }
})
