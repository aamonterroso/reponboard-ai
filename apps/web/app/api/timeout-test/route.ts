export const runtime = 'edge'

export async function GET(): Promise<Response> {
  const encoder = new TextEncoder()
  const startedAt = Date.now()

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for (let i = 1; i <= 90; i++) {
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2)
          const event = { tick: i, elapsedSeconds: Number(elapsed) }
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
        const finalElapsed = ((Date.now() - startedAt) / 1000).toFixed(2)
        controller.enqueue(
          encoder.encode(
            JSON.stringify({ done: true, totalSeconds: Number(finalElapsed) }) + '\n'
          )
        )
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({ error: String(err) }) + '\n'
          )
        )
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}
