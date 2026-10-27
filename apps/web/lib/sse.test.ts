import { describe, it, expect } from 'vitest'
import { createSseWriter, formatSseEvent } from './sse'
import { readSseEvents } from './sse-client'

describe('formatSseEvent', () => {
  it('frames an event with id, event name, and one JSON data line', () => {
    expect(formatSseEvent('thinking', { phase: 'thinking', message: 'a\nb' }, 3)).toBe(
      'id: 3\nevent: thinking\ndata: {"phase":"thinking","message":"a\\nb"}\n\n',
    )
  })
})

describe('SSE round trip', () => {
  it('reads back every event the writer sent, in order, across chunk splits', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const sse = createSseWriter(controller)
        sse.send({ phase: 'discovery', message: 'scan' })
        sse.send({ phase: 'complete', result: { id: 'x' } })
        sse.close()
        sse.send({ phase: 'late' }) // ignored after close
      },
    })

    const events: Array<{ phase: string }> = []
    for await (const event of readSseEvents<{ phase: string }>(stream)) events.push(event)

    expect(events).toEqual([
      { phase: 'discovery', message: 'scan' },
      { phase: 'complete', result: { id: 'x' } },
    ])
  })
})
