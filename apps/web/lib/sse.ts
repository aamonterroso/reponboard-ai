// Server-Sent Events framing for the streaming API routes. Every event
// the agent pipeline emits carries a `phase`, which becomes the SSE
// `event:` name so clients can dispatch on it without parsing first.
// Each event gets a monotonically increasing `id:`.

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  // no-transform stops proxies from buffering or compressing the stream.
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
}

// Comment line. Keeps the connection alive through idle proxies during
// long model calls without producing a client-visible event.
const HEARTBEAT = ': ping\n\n'
export const SSE_HEARTBEAT_MS = 15_000

const textEncoder = new TextEncoder()

export function formatSseEvent(event: string, data: unknown, id?: number): string {
  // JSON.stringify never emits raw newlines, so the payload fits on one
  // `data:` line.
  const idLine = id !== undefined ? `id: ${id}\n` : ''
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export interface SseWriter {
  send: <T extends { phase: string }>(payload: T) => void
  close: () => void
  readonly closed: boolean
}

// Wraps a ReadableStream controller with SSE framing, ids, and a
// heartbeat. `send` and `close` are safe to call after the stream ends.
export function createSseWriter(
  controller: ReadableStreamDefaultController<Uint8Array>,
): SseWriter {
  let nextId = 1
  let closed = false

  // Every path that ends the stream goes through here so the heartbeat
  // timer can't outlive it (a cancelled stream makes enqueue throw).
  const markClosed = (): void => {
    closed = true
    clearInterval(heartbeat)
  }

  const enqueue = (chunk: string): void => {
    if (closed) return
    try {
      controller.enqueue(textEncoder.encode(chunk))
    } catch {
      markClosed()
    }
  }

  const heartbeat = setInterval(() => enqueue(HEARTBEAT), SSE_HEARTBEAT_MS)

  return {
    send(payload) {
      enqueue(formatSseEvent(payload.phase, payload, nextId++))
    },
    close() {
      if (closed) return
      markClosed()
      try {
        controller.close()
      } catch {
        /* already closed */
      }
    },
    get closed() {
      return closed
    },
  }
}

// One-off encoder for routes that manage their own controller.
export function encodeSseEvent<T extends { phase: string }>(payload: T): Uint8Array {
  return textEncoder.encode(formatSseEvent(payload.phase, payload))
}
