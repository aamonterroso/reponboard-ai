'use client'

import { useState } from 'react'

interface Tick {
  tick?: number
  elapsedSeconds?: number
  done?: boolean
  totalSeconds?: number
  error?: string
}

export default function TimeoutTestPage(): React.JSX.Element {
  const [ticks, setTicks] = useState<Tick[]>([])
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  async function run(): Promise<void> {
    setTicks([])
    setStatus('running')
    setErrorMsg(null)

    let terminal: 'done' | 'error' | null = null

    try {
      const res = await fetch('/api/timeout-test')
      if (!res.body) throw new Error('No response body')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line) as Tick
            setTicks((prev) => [...prev, event])
            if (event.done) {
              terminal = 'done'
              setStatus('done')
            }
            if (event.error) {
              terminal = 'error'
              setStatus('error')
              setErrorMsg(event.error)
            }
          } catch {
            // ignore parse errors
          }
        }
      }

      if (terminal === null) {
        setStatus('done')
      }
    } catch (err) {
      setStatus('error')
      setErrorMsg(err instanceof Error ? err.message : String(err))
    }
  }

  const lastTick = ticks[ticks.length - 1]
  const lastElapsed = lastTick?.elapsedSeconds ?? lastTick?.totalSeconds ?? 0

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8 font-mono">
      <div className="max-w-2xl mx-auto flex flex-col gap-6">
        <h1 className="text-2xl font-bold">Vercel Edge Timeout Test</h1>
        <p className="text-sm text-zinc-400">
          Streams NDJSON ticks every 1s for up to 90s. If it reaches tick 85+,
          there is no 30s cap. If it dies earlier, the cap is real.
        </p>

        <button
          onClick={() => void run()}
          disabled={status === 'running'}
          className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-zinc-700 px-4 py-2 rounded font-semibold w-fit"
        >
          {status === 'running' ? 'Running...' : 'Start test'}
        </button>

        <div className="border border-zinc-800 rounded p-4 bg-zinc-900">
          <div className="text-sm text-zinc-400 mb-2">Status</div>
          <div className="text-emerald-400">{status}</div>
          {errorMsg && (
            <div className="text-red-400 text-sm mt-2">{errorMsg}</div>
          )}
          <div className="text-zinc-300 text-sm mt-3">
            Ticks received: {ticks.length}
          </div>
          <div className="text-zinc-300 text-sm">
            Last elapsed: {lastElapsed}s
          </div>
        </div>

        <details className="border border-zinc-800 rounded p-4 bg-zinc-900">
          <summary className="cursor-pointer text-sm text-zinc-400">
            All events ({ticks.length})
          </summary>
          <pre className="text-xs mt-3 max-h-96 overflow-auto">
            {ticks.map((t, i) => (
              <div key={i} className="text-zinc-300">
                {JSON.stringify(t)}
              </div>
            ))}
          </pre>
        </details>
      </div>
    </main>
  )
}
