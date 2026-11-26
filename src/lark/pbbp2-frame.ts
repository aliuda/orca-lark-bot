// Minimal wire-compatible protobuf codec for Feishu Open Platform long-connection frames
// (`pbbp2.Frame`), matching the official Feishu SDKs with zero external dependencies.

export const FRAME_METHOD_CONTROL = 0
export const FRAME_METHOD_DATA = 1

export interface FrameHeader {
  key: string
  value: string
}

export interface Pbbp2Frame {
  seqId: bigint
  logId: bigint
  service: number
  method: number
  headers: FrameHeader[]
  payloadEncoding: string
  payloadType: string
  payload?: Uint8Array
  logIdNew: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function getFrameHeader(frame: Pbbp2Frame, key: string): string {
  const found = frame.headers.find((h) => h.key === key)
  return found ? found.value : ''
}

function encodeVarint(value: bigint): number[] {
  const out: number[] = []
  let v = BigInt.asUintN(64, value)
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n))
    v >>= 7n
  }
  out.push(Number(v))
  return out
}

function appendVarintField(target: number[], fieldNum: number, value: bigint): void {
  target.push(...encodeVarint(BigInt(fieldNum) << 3n))
  target.push(...encodeVarint(value))
}

function appendBytesField(target: number[], fieldNum: number, data: Uint8Array): void {
  target.push(...encodeVarint((BigInt(fieldNum) << 3n) | 2n))
  target.push(...encodeVarint(BigInt(data.length)))
  for (let i = 0; i < data.length; i++) {
    target.push(data[i])
  }
}

export function marshalPbbp2Frame(frame: Pbbp2Frame): Uint8Array {
  const out: number[] = []
  appendVarintField(out, 1, frame.seqId)
  appendVarintField(out, 2, frame.logId)
  appendVarintField(out, 3, BigInt(frame.service))
  appendVarintField(out, 4, BigInt(frame.method))
  for (const h of frame.headers) {
    const hb: number[] = []
    appendBytesField(hb, 1, encoder.encode(h.key))
    appendBytesField(hb, 2, encoder.encode(h.value))
    appendBytesField(out, 5, new Uint8Array(hb))
  }
  appendBytesField(out, 6, encoder.encode(frame.payloadEncoding))
  appendBytesField(out, 7, encoder.encode(frame.payloadType))
  if (frame.payload !== undefined) {
    appendBytesField(out, 8, frame.payload)
  }
  appendBytesField(out, 9, encoder.encode(frame.logIdNew))
  return new Uint8Array(out)
}

function readVarint(buf: Uint8Array, offset: number): { value: bigint; nextOffset: number } | null {
  let result = 0n
  let shift = 0n
  for (let i = 0; i < 10 && offset + i < buf.length; i++) {
    const byte = buf[offset + i]
    result |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: offset + i + 1 }
    }
    shift += 7n
  }
  return null
}

function walkFields(
  buf: Uint8Array,
  visitor: (fieldNum: number, varintVal: bigint, bytesVal: Uint8Array | null) => void
): boolean {
  let offset = 0
  while (offset < buf.length) {
    const keyRes = readVarint(buf, offset)
    if (!keyRes) return false
    offset = keyRes.nextOffset
    const fieldNum = Number(keyRes.value >> 3n)
    const wireType = Number(keyRes.value & 7n)
    if (wireType === 0) {
      const valRes = readVarint(buf, offset)
      if (!valRes) return false
      offset = valRes.nextOffset
      visitor(fieldNum, valRes.value, null)
    } else if (wireType === 2) {
      const lenRes = readVarint(buf, offset)
      if (!lenRes) return false
      const len = Number(lenRes.value)
      offset = lenRes.nextOffset
      if (len < 0 || offset + len > buf.length) return false
      visitor(fieldNum, 0n, buf.subarray(offset, offset + len))
      offset += len
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) return false
      offset += 8
    } else if (wireType === 5) {
      if (offset + 4 > buf.length) return false
      offset += 4
    } else {
      return false
    }
  }
  return true
}

export function unmarshalPbbp2Frame(buf: Uint8Array): Pbbp2Frame | null {
  const frame: Pbbp2Frame = {
    seqId: 0n,
    logId: 0n,
    service: 0,
    method: 0,
    headers: [],
    payloadEncoding: '',
    payloadType: '',
    payload: undefined,
    logIdNew: ''
  }

  const ok = walkFields(buf, (fieldNum, varintVal, bytesVal) => {
    switch (fieldNum) {
      case 1:
        frame.seqId = varintVal
        break
      case 2:
        frame.logId = varintVal
        break
      case 3:
        frame.service = Number(BigInt.asIntN(32, varintVal))
        break
      case 4:
        frame.method = Number(BigInt.asIntN(32, varintVal))
        break
      case 5: {
        if (!bytesVal) break
        const header: FrameHeader = { key: '', value: '' }
        walkFields(bytesVal, (hNum, _v, hBytes) => {
          if (!hBytes) return
          if (hNum === 1) header.key = decoder.decode(hBytes)
          else if (hNum === 2) header.value = decoder.decode(hBytes)
        })
        frame.headers.push(header)
        break
      }
      case 6:
        if (bytesVal) frame.payloadEncoding = decoder.decode(bytesVal)
        break
      case 7:
        if (bytesVal) frame.payloadType = decoder.decode(bytesVal)
        break
      case 8:
        if (bytesVal) frame.payload = new Uint8Array(bytesVal)
        break
      case 9:
        if (bytesVal) frame.logIdNew = decoder.decode(bytesVal)
        break
    }
  })

  return ok ? frame : null
}

/** Reassembles multi-part Feishu WebSocket data frames (`sum` / `seq` headers). */
export class FrameFragmentAssembler {
  private readonly partials = new Map<string, { parts: (Uint8Array | null)[]; updatedAt: number }>()
  private readonly ttlMs: number

  constructor(ttlMs = 10_000) {
    this.ttlMs = ttlMs
  }

  push(messageId: string, sum: number, seq: number, chunk: Uint8Array, now: number): Uint8Array | null {
    if (sum <= 1) return chunk
    if (seq < 0 || seq >= sum) return null

    let entry = this.partials.get(messageId)
    if (!entry || entry.parts.length !== sum) {
      entry = { parts: new Array<Uint8Array | null>(sum).fill(null), updatedAt: now }
      this.partials.set(messageId, entry)
    }
    entry.updatedAt = now
    entry.parts[seq] = chunk

    this.sweep(now, messageId)

    if (entry.parts.some((p) => p === null)) {
      return null
    }

    const totalLen = entry.parts.reduce((acc, part) => acc + (part?.length ?? 0), 0)
    const combined = new Uint8Array(totalLen)
    let offset = 0
    for (const part of entry.parts) {
      if (!part) return null
      combined.set(part, offset)
      offset += part.length
    }
    this.partials.delete(messageId)
    return combined
  }

  sweep(now: number, keepId?: string): void {
    for (const [id, entry] of this.partials.entries()) {
      if (id !== keepId && now - entry.updatedAt > this.ttlMs) {
        this.partials.delete(id)
      }
    }
  }
}
