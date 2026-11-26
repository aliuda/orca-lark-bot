// Minimal Node.js built-in ambient types for the trusted-worker runtime.
// Orca's generated .orca/types/tsconfig.json omits @types/node by default so plugins stay
// self-contained without requiring node_modules.

declare const process: {
  readonly pid: number
  readonly env: Record<string, string | undefined>
}

interface BufferConstructor {
  from(input: string, encoding?: 'utf8' | 'base64' | 'hex'): Uint8Array & { toString(encoding?: 'utf8' | 'base64' | 'hex'): string }
  from(input: Uint8Array | ArrayBuffer | readonly number[]): Uint8Array & { toString(encoding?: 'utf8' | 'base64' | 'hex'): string }
  concat(list: readonly Uint8Array[]): Uint8Array & { toString(encoding?: 'utf8' | 'base64' | 'hex'): string }
}

declare const Buffer: BufferConstructor

declare module 'node:crypto' {
  export function randomBytes(size: number): Uint8Array & { toString(encoding: 'hex' | 'base64'): string }
  export function randomInt(min: number, max: number): number
  export function randomUUID(): string
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean
}

declare module 'node:http' {
  export interface IncomingHttpHeaders {
    authorization?: string
    'content-type'?: string
    [key: string]: string | string[] | undefined
  }
  export interface IncomingMessage {
    method?: string
    url?: string
    headers: IncomingHttpHeaders
    on(event: 'data', listener: (chunk: Uint8Array) => void): this
    on(event: 'end', listener: () => void): this
    on(event: 'error', listener: (err: Error) => void): this
    destroy(): void
  }
  export interface ServerResponse {
    statusCode: number
    setHeader(name: string, value: string): void
    end(body?: string): void
  }
  export interface AddressInfo {
    address: string
    family: string
    port: number
  }
  export interface Server {
    listen(port: number, host: string, cb?: () => void): this
    close(cb?: (err?: Error) => void): this
    address(): AddressInfo | string | null
    unref(): this
    on(event: 'error', listener: (err: Error) => void): this
  }
  export function createServer(
    listener: (req: IncomingMessage, res: ServerResponse) => void
  ): Server
}

declare module 'node:fs/promises' {
  export function mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<string | undefined>
  export function writeFile(
    path: string,
    data: string,
    options?: { encoding?: 'utf8'; mode?: number }
  ): Promise<void>
  export function chmod(path: string, mode: number): Promise<void>
  export function rename(oldPath: string, newPath: string): Promise<void>
  export function unlink(path: string): Promise<void>
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
}

declare module 'node:path' {
  export function dirname(p: string): string
  export function join(...paths: string[]): string
  export function resolve(...paths: string[]): string
}

declare module 'node:child_process' {
  export interface ChildProcessWithoutNullStreams {
    stdin: { write(chunk: string): boolean; end(): void }
    stdout: {
      setEncoding(enc: 'utf8'): void
      on(event: 'data', listener: (chunk: string) => void): void
    }
    stderr: {
      setEncoding(enc: 'utf8'): void
      on(event: 'data', listener: (chunk: string) => void): void
    }
    on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void
    on(event: 'error', listener: (err: Error) => void): void
    kill(signal?: string): boolean
  }
  export function spawn(
    command: string,
    args: readonly string[],
    options?: { env?: Record<string, string | undefined>; cwd?: string; stdio?: ['pipe', 'pipe', 'pipe'] }
  ): ChildProcessWithoutNullStreams
}
