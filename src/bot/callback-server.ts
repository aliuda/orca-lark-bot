import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface CallbackOutcome {
  ok: boolean
  code?: 'not_found' | 'already_settled' | 'invalid_params'
  message?: string
}

export interface CallbackHandlers {
  onProgress(input: { requestId: string; text: string; stage?: string }): Promise<CallbackOutcome>
  onComplete(input: { requestId: string; answer: string }): Promise<CallbackOutcome>
  onFail(input: { requestId: string; error: string }): Promise<CallbackOutcome>
}

export interface CallbackServerOptions {
  port?: number
  token?: string
  runtimeFilePath?: string | null
  handlers: CallbackHandlers
  log?: (msg: string) => void
}

export interface CallbackRuntimeDescriptor {
  callbackUrl: string
  token: string
  pid: number
  updatedAt: number
}

const MAX_BODY_BYTES = 1024 * 1024 // 1 MiB

export function defaultRuntimeDescriptorPath(): string {
  return join(homedir(), '.orca-lark-bot-bridge', 'runtime.json')
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('payload_too_large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw) as unknown
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          reject(new Error('invalid_json'))
          return
        }
        resolve(parsed as Record<string, unknown>)
      } catch {
        reject(new Error('invalid_json'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function verifyBearer(header: string | undefined, expectedToken: string): boolean {
  if (!header || !header.startsWith('Bearer ')) return false
  const supplied = header.slice('Bearer '.length).trim()
  const a = Buffer.from(supplied, 'utf8')
  const b = Buffer.from(expectedToken, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const MCP_TOOLS = [
  {
    name: 'lark_bridge_report_progress',
    description:
      'Report an interim progress update back to the Feishu card bound to `request_id`.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'Opaque request_id from the Feishu webhook payload.' },
        text: { type: 'string', description: 'Concise progress update shown on the Feishu card.' },
        stage: { type: 'string', description: 'Optional short stage label (e.g. Analyzing, Testing).' }
      },
      required: ['request_id', 'text']
    }
  },
  {
    name: 'lark_bridge_complete',
    description:
      'Finish a Feishu request by delivering the final answer to the original Feishu message/thread bound to `request_id`.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'Opaque request_id from the Feishu webhook payload.' },
        answer: { type: 'string', description: 'Final Markdown answer to post back to Feishu.' }
      },
      required: ['request_id', 'answer']
    }
  },
  {
    name: 'lark_bridge_fail',
    description:
      'Mark a Feishu request as failed and show a clear error state on the Feishu card bound to `request_id`.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'Opaque request_id from the Feishu webhook payload.' },
        error: { type: 'string', description: 'Human-readable failure reason.' }
      },
      required: ['request_id', 'error']
    }
  }
]

/**
 * Authenticated loopback-only (`127.0.0.1`) callback & Streamable HTTP MCP server.
 * Receives deterministic `request_id`-scoped callbacks from the local Orca Bot via
 * `scripts/mcp-bridge.mjs` (stdio MCP) or direct authenticated HTTP POST.
 */
export class LocalCallbackServer {
  private readonly requestedPort: number
  private readonly token: string
  private readonly runtimeFilePath: string | null
  private readonly handlers: CallbackHandlers
  private readonly log: (msg: string) => void

  private server: Server | null = null
  private callbackUrl: string | null = null

  constructor(options: CallbackServerOptions) {
    this.requestedPort = options.port ?? 0
    this.token = options.token ?? randomBytes(32).toString('hex')
    this.runtimeFilePath =
      options.runtimeFilePath === undefined
        ? defaultRuntimeDescriptorPath()
        : options.runtimeFilePath
    this.handlers = options.handlers
    this.log = options.log ?? (() => undefined)
  }

  getCallbackUrl(): string | null {
    return this.callbackUrl
  }

  getToken(): string {
    return this.token
  }

  getRuntimeFilePath(): string | null {
    return this.runtimeFilePath
  }

  async start(): Promise<{ callbackUrl: string; token: string; runtimeFilePath: string | null }> {
    if (this.server && this.callbackUrl) {
      return {
        callbackUrl: this.callbackUrl,
        token: this.token,
        runtimeFilePath: this.runtimeFilePath
      }
    }

    const server = createServer((req, res) => {
      void this.handleHttp(req, res)
    })

    await new Promise<void>((resolve, reject) => {
      server.on('error', reject)
      server.listen(this.requestedPort, '127.0.0.1', () => {
        resolve()
      })
    })

    server.unref()
    this.server = server
    const addr = server.address()
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to bind local callback server to 127.0.0.1')
    }
    this.callbackUrl = `http://127.0.0.1:${addr.port}`

    if (this.runtimeFilePath) {
      await this.writeRuntimeDescriptor(this.runtimeFilePath, {
        callbackUrl: this.callbackUrl,
        token: this.token,
        pid: process.pid,
        updatedAt: Date.now()
      })
    }

    return {
      callbackUrl: this.callbackUrl,
      token: this.token,
      runtimeFilePath: this.runtimeFilePath
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    const ownedCallbackUrl = this.callbackUrl
    this.server = null
    this.callbackUrl = null
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }
    if (this.runtimeFilePath && ownedCallbackUrl) {
      await this.removeOwnedRuntimeDescriptor(this.runtimeFilePath, ownedCallbackUrl)
    }
  }

  private async removeOwnedRuntimeDescriptor(
    filePath: string,
    ownedCallbackUrl: string
  ): Promise<void> {
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return
    }
    const rec = parsed as Record<string, unknown>
    if (
      rec.token === this.token &&
      rec.pid === process.pid &&
      rec.callbackUrl === ownedCallbackUrl
    ) {
      await unlink(filePath).catch(() => undefined)
    }
  }

  private async writeRuntimeDescriptor(
    filePath: string,
    descriptor: CallbackRuntimeDescriptor
  ): Promise<void> {
    const dir = dirname(filePath)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const tmpPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`
    try {
      await writeFile(tmpPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      })
      await chmod(tmpPath, 0o600)
      await rename(tmpPath, filePath)
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined)
      throw err
    }
  }

  private async dispatchCallback(
    kind: 'progress' | 'complete' | 'fail',
    body: Record<string, unknown>
  ): Promise<CallbackOutcome> {
    const requestId = typeof body.request_id === 'string' ? body.request_id.trim() : ''
    if (!requestId) {
      return { ok: false, code: 'invalid_params', message: 'Missing required string field: request_id' }
    }
    if (kind === 'progress') {
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text) {
        return { ok: false, code: 'invalid_params', message: 'Missing required string field: text' }
      }
      const stage = typeof body.stage === 'string' ? body.stage.trim() : undefined
      return this.handlers.onProgress({ requestId, text, stage })
    }
    if (kind === 'complete') {
      const answer = typeof body.answer === 'string' ? body.answer : ''
      if (!answer.trim()) {
        return { ok: false, code: 'invalid_params', message: 'Missing required string field: answer' }
      }
      return this.handlers.onComplete({ requestId, answer })
    }
    const error = typeof body.error === 'string' && body.error.trim() ? body.error.trim() : 'Unknown error'
    return this.handlers.onFail({ requestId, error })
  }

  private mapOutcomeStatus(outcome: CallbackOutcome): number {
    if (outcome.ok) return 200
    if (outcome.code === 'not_found') return 404
    if (outcome.code === 'already_settled') return 409
    return 400
  }

  private async handleMcpJsonRpc(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = body.id ?? null
    const method = typeof body.method === 'string' ? body.method : ''
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'orca-lark-bot-bridge', version: '0.1.0' }
        }
      }
    }
    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} }
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } }
    }
    if (method === 'tools/call') {
      const params =
        typeof body.params === 'object' && body.params !== null
          ? (body.params as Record<string, unknown>)
          : {}
      const toolName = typeof params.name === 'string' ? params.name : ''
      const args =
        typeof params.arguments === 'object' && params.arguments !== null
          ? (params.arguments as Record<string, unknown>)
          : {}

      let outcome: CallbackOutcome
      if (toolName === 'lark_bridge_report_progress') {
        outcome = await this.dispatchCallback('progress', args)
      } else if (toolName === 'lark_bridge_complete') {
        outcome = await this.dispatchCallback('complete', args)
      } else if (toolName === 'lark_bridge_fail') {
        outcome = await this.dispatchCallback('fail', args)
      } else {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown tool: ${toolName}` }
        }
      }

      return {
        jsonrpc: '2.0',
        id,
        result: {
          isError: !outcome.ok,
          content: [{ type: 'text', text: JSON.stringify(outcome) }]
        }
      }
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unsupported MCP method: ${method}` }
    }
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const urlPath = (req.url ?? '/').split('?')[0]

    if (method === 'GET' && urlPath === '/health') {
      sendJson(res, 200, { ok: true, pid: process.pid })
      return
    }

    if (!verifyBearer(req.headers.authorization, this.token)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' })
      return
    }

    if (method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
      return
    }

    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (err) {
      const code = err instanceof Error ? err.message : 'invalid_json'
      sendJson(res, code === 'payload_too_large' ? 413 : 400, { ok: false, error: code })
      return
    }

    try {
      if (urlPath === '/callback/progress') {
        const outcome = await this.dispatchCallback('progress', body)
        sendJson(res, this.mapOutcomeStatus(outcome), outcome as unknown as Record<string, unknown>)
        return
      }
      if (urlPath === '/callback/complete') {
        const outcome = await this.dispatchCallback('complete', body)
        sendJson(res, this.mapOutcomeStatus(outcome), outcome as unknown as Record<string, unknown>)
        return
      }
      if (urlPath === '/callback/fail') {
        const outcome = await this.dispatchCallback('fail', body)
        sendJson(res, this.mapOutcomeStatus(outcome), outcome as unknown as Record<string, unknown>)
        return
      }
      if (urlPath === '/mcp') {
        const rpcResponse = await this.handleMcpJsonRpc(body)
        sendJson(res, 200, rpcResponse)
        return
      }
      sendJson(res, 404, { ok: false, error: 'not_found' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log(`callback server error on ${urlPath}: ${msg}`)
      sendJson(res, 500, { ok: false, error: msg })
    }
  }
}
