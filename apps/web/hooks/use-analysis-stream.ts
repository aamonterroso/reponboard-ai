'use client'

import { useCallback, useReducer, useRef } from 'react'
import type { FullAnalysisResult } from '@reponboard/agent-core'
import { extractErrorMessage } from '@/lib/error-message'
import { readSseEvents } from '@/lib/sse-client'
import {
  analysisStreamReducer,
  initialAnalysisStreamState,
} from '@/lib/analysis-stream'
import type { AnalysisStreamEvent, AnalysisStreamState } from '@/lib/analysis-stream'

export interface AnalysisResponseInfo {
  status: number
  remaining: number | null
}

interface UseAnalysisStream {
  state: AnalysisStreamState
  analyze: (repoUrl: string) => Promise<AnalysisResponseInfo | null>
  reset: () => void
}

// Owns the /api/analyze request: one reducer drives both the results view
// and the AI Lab, so they can never disagree about what has streamed in.
export function useAnalysisStream(): UseAnalysisStream {
  const [state, dispatch] = useReducer(analysisStreamReducer, initialAnalysisStreamState)
  const abortRef = useRef<AbortController | null>(null)

  const analyze = useCallback(
    async (repoUrl: string): Promise<AnalysisResponseInfo | null> => {
      abortRef.current?.abort()
      const abort = new AbortController()
      abortRef.current = abort
      dispatch({ type: 'start', now: Date.now() })

      try {
        const response = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoUrl }),
          signal: abort.signal,
        })

        if (!response.ok) {
          const data: unknown = await response.json().catch(() => ({}))
          dispatch({
            type: 'fail',
            error: extractErrorMessage(data, 'An unexpected error occurred.'),
            now: Date.now(),
          })
          return { status: response.status, remaining: response.status === 429 ? 0 : null }
        }

        const remainingHeader = response.headers.get('X-RateLimit-Remaining')
        const info: AnalysisResponseInfo = {
          status: response.status,
          remaining: remainingHeader !== null ? parseInt(remainingHeader, 10) : null,
        }
        const contentType = response.headers.get('Content-Type') ?? ''

        if (contentType.includes('text/event-stream') && response.body !== null) {
          let finished = false
          for await (const event of readSseEvents<AnalysisStreamEvent>(response.body)) {
            dispatch({ type: 'event', event, now: Date.now() })
            if (event.phase === 'complete' || event.phase === 'error') {
              finished = true
              break
            }
          }
          // The body can end without a terminal event (function killed,
          // proxy cut the connection); don't leave the UI spinning.
          if (!finished && !abort.signal.aborted) {
            dispatch({
              type: 'fail',
              error: 'The analysis stream ended unexpectedly. Please try again.',
              now: Date.now(),
            })
          }
        } else {
          // Heuristic-only path (no ANTHROPIC_API_KEY) answers with JSON.
          const result = (await response.json()) as FullAnalysisResult
          dispatch({ type: 'event', event: { phase: 'complete', result }, now: Date.now() })
        }
        window.dispatchEvent(new CustomEvent('reponboard:remaining-changed'))
        return info
      } catch (err) {
        if (abort.signal.aborted) return null
        console.error('[analyze] stream failed', err)
        dispatch({
          type: 'fail',
          error: 'Failed to reach the server. Please try again.',
          now: Date.now(),
        })
        return null
      }
    },
    [],
  )

  const reset = useCallback((): void => {
    abortRef.current?.abort()
    abortRef.current = null
    dispatch({ type: 'reset' })
  }, [])

  return { state, analyze, reset }
}
