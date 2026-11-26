import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assert, test } from 'orca/testing'
import { LocalCallbackServer } from './bot/callback-server'
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
          content: JSON.stringify({ text: '@_user_1 /agent hello' }),
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
