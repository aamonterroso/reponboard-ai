import { EventSourceParserStream } from 'eventsource-parser/stream'

// Reads a `text/event-stream` response body (from a POST, which the
// browser EventSource API can't send) and yields each event's JSON
// payload. Events whose data isn't valid JSON are skipped.
export async function* readSseEvents<T>(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
  // TS's DOM lib types TextDecoderStream's writable side as BufferSource,
  // which a Uint8Array stream satisfies at runtime but not structurally.
  const decoder = new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>
  const reader = body
    .pipeThrough(decoder)
    .pipeThrough(new EventSourceParserStream())
    .getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      try {
        yield JSON.parse(value.data) as T
      } catch {
        // malformed event payload
      }
    }
  } finally {
    reader.releaseLock()
  }
}
