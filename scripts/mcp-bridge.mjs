#!/usr/bin/env node
/**
 * Zero-dependency stdio MCP server for Orca Bot (`orca bot tools add`).
 *
 * Register once per Bot:
 *   orca bot tools add "node /abs/path/to/orca-lark-bot/scripts/mcp-bridge.mjs" \
 *     --name lark-bridge --bot MyBot
 *
 * On each tool call, reads the live loopback endpoint & bearer token from
 * `~/.orca-lark-bot-bridge/runtime.json` (or `ORCA_LARK_BRIDGE_RUNTIME`) so plugin
 * worker restarts and ephemeral port changes are completely transparent to the Bot.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const RUNTIME_PATH =
  process.env.ORCA_LARK_BRIDGE_RUNTIME ||
  join(homedir(), '.orca-lark-bot-bridge', 'runtime.json')

const TOOLS = [
  {
    name: 'lark_bridge_report_progress',
    description:
      'Report interim progress for an active Feishu request by its opaque request_id.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'Opaque request_id from the Feishu webhook payload.' },
        text: { type: 'string', description: 'Concise progress update to display on the Feishu card.' },
        stage: { type: 'string', description: 'Optional short stage label (e.g. Analyzing, Running tests).' }
      },
      required: ['request_id', 'text']
    }
  },
  {
    name: 'lark_bridge_complete',
    description:
      'Deliver the final Markdown answer back to the exact Feishu message/thread bound to request_id.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'Opaque request_id from the Feishu webhook payload.' },
        answer: { type: 'string', description: 'Final Markdown answer to send to Feishu.' }
      },
      required: ['request_id', 'answer']
    }
  },
  {
    name: 'lark_bridge_fail',
    description:
      'Mark a Feishu request as failed and surface the error on its bound Feishu card.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'Opaque request_id from the Feishu webhook payload.' },
        error: { type: 'string', description: 'Clear failure description for the user.' }
      },
      required: ['request_id', 'error']
    }
  }
]

const ROUTE_BY_TOOL = {
  lark_bridge_report_progress: '/callback/progress',
  lark_bridge_complete: '/callback/complete',
  lark_bridge_fail: '/callback/fail'
}

function writeResponse(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function loadRuntimeDescriptor() {
  try {
    const raw = await readFile(RUNTIME_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.callbackUrl !== 'string' || typeof parsed.token !== 'string') {
      throw new Error('Malformed runtime descriptor')
    }
    return parsed
  } catch (err) {
    throw new Error(
      `Orca Lark Bot Bridge plugin worker is not running or runtime file is missing (${RUNTIME_PATH}): ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

async function handleToolCall(toolName, args) {
  const route = ROUTE_BY_TOOL[toolName]
  if (!route) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `Unknown tool: ${toolName}` }) }]
    }
  }

  try {
    const runtime = await loadRuntimeDescriptor()
    const res = await fetch(`${runtime.callbackUrl}${route}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${runtime.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(args ?? {})
    })
    const text = await res.text()
    return {
      isError: !res.ok,
      content: [{ type: 'text', text }]
    }
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      ]
    }
  }
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return
  const { id, method, params } = msg

  // Notifications have no id and expect no response.
  if (id === undefined) return

  if (method === 'initialize') {
    writeResponse({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'orca-lark-bot-bridge-stdio', version: '0.1.0' }
      }
    })
    return
  }

  if (method === 'ping') {
    writeResponse({ jsonrpc: '2.0', id, result: {} })
    return
  }

  if (method === 'tools/list') {
    writeResponse({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }

  if (method === 'tools/call') {
    const toolName = params && typeof params.name === 'string' ? params.name : ''
    const toolArgs = params && typeof params.arguments === 'object' ? params.arguments : {}
    const result = await handleToolCall(toolName, toolArgs)
    writeResponse({ jsonrpc: '2.0', id, result })
    return
  }

  writeResponse({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${String(method)}` }
  })
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return
  }
  void handleMessage(parsed)
})
