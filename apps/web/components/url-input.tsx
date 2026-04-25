'use client'

import { useState, useEffect } from 'react'
import type { FullAnalysisResult, AnalysisPhase } from '@reponboard/agent-core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AnalysisResult } from './analysis-result'
import { AnalysisProgress } from './analysis-progress'

const GITHUB_URL_REGEX = /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+(\/)?$/

function isValidGitHubUrl(url: string): boolean {
  return GITHUB_URL_REGEX.test(url.trim())
}

export function UrlInput(): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<FullAnalysisResult | null>(null)
  const [currentPhase, setCurrentPhase] = useState<AnalysisPhase | null>(null)
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null)
  const [streamMessage, setStreamMessage] = useState('')
  const [remaining, setRemaining] = useState<number | null>(null)

  useEffect(() => {
    void fetch('/api/remaining')
      .then((r) => r.json())
      .then((data: { remaining: number }) => {
        setRemaining(data.remaining)
      })
      .catch(() => undefined)
  }, [])

  function handleChange(e: React.ChangeEvent<HTMLInputElement>): void {
    setUrl(e.target.value)
    if (error !== null) setError(null)
  }

  async function handleAnalyze(): Promise<void> {
    const trimmed = url.trim()

    if (trimmed === '') {
      setError('Please enter a GitHub repository URL.')
      return
    }

    if (!isValidGitHubUrl(trimmed)) {
      setError('Must be a valid GitHub repository URL — e.g. https://github.com/owner/repo')
      return
    }

    setError(null)
    setLoading(true)

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: trimmed }),
      })

      if (!response.ok) {
        const data: unknown = await response.json()
        const errorData = data as { error?: string }
        setError(errorData.error ?? 'An unexpected error occurred.')
        // Refresh remaining count on rate limit error
        if (response.status === 429) {
          setRemaining(0)
        }
        return
      }

      // Update remaining from response header
      const remainingHeader = response.headers.get('X-RateLimit-Remaining')
      if (remainingHeader !== null) {
        setRemaining(parseInt(remainingHeader, 10))
      }

      const contentType = response.headers.get('Content-Type') ?? ''

      if (contentType.includes('application/x-ndjson') && response.body !== null) {
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (line.trim() === '') continue
            try {
              const event = JSON.parse(line) as {
                phase: string
                result?: FullAnalysisResult
                error?: string
                message?: string
                progress?: unknown
              }
              if (event.phase === 'discovery') {
                setCurrentPhase('discovery')
                setStreamMessage(event.message ?? '')
              } else if (event.phase === 'fetching') {
                setCurrentPhase('fetching')
                setStreamMessage(event.message ?? '')
                if (event.progress) setProgress(event.progress as { current: number; total: number })
              } else if (event.phase === 'analyzing') {
                setCurrentPhase('analyzing')
                setStreamMessage(event.message ?? '')
              } else if (event.phase === 'thinking') {
                // Agent tool_use events — stay in 'analyzing' step for the
                // progress UI but surface the tool activity in the message
                setCurrentPhase('analyzing')
                setStreamMessage(event.message ?? 'Agent is thinking...')
              } else if (event.phase === 'complete' && event.result !== undefined) {
                setCurrentPhase('complete')
                setResult(event.result)
                return
              } else if (event.phase === 'error' && event.error !== undefined) {
                setError(event.error)
                return
              }
            } catch {
              // skip malformed lines
            }
          }
        }
      } else {
        // Fallback: non-streaming JSON response
        const data: unknown = await response.json()
        setResult(data as FullAnalysisResult)
      }
    } catch {
      setError('Failed to reach the server. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      void handleAnalyze()
    }
  }

  function handleReset(): void {
    setUrl('')
    setError(null)
    setResult(null)
    setCurrentPhase(null)
    setProgress(null)
    setStreamMessage('')
    // Refresh remaining count after reset
    void fetch('/api/remaining')
      .then((r) => r.json())
      .then((data: { remaining: number }) => {
        setRemaining(data.remaining)
      })
      .catch(() => undefined)
  }

  if (result !== null) {
    return <AnalysisResult result={result} onReset={handleReset} />
  }

  return (
    <div className="w-full flex flex-col gap-3">
      <div className="flex gap-2">
        <Input
          type="url"
          value={url}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="https://github.com/owner/repo"
          disabled={loading}
          aria-label="GitHub repository URL"
          aria-invalid={error !== null}
          className="flex-1 h-12 font-mono text-base"
        />
        <Button
          type="button"
          onClick={() => void handleAnalyze()}
          disabled={loading}
          size="lg"
          className="shrink-0"
        >
          {loading ? (
            <>
              <svg className="animate-spin h-4 w-4 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="text-sm">Analyzing...</span>
            </>
          ) : (
            'Analyze'
          )}
        </Button>
      </div>

      {remaining !== null && remaining <= 3 && !loading && (
        <p className="text-xs text-zinc-500 text-left">
          {remaining === 0
            ? 'No analyses remaining today. Check back tomorrow.'
            : `${remaining} ${remaining === 1 ? 'analysis' : 'analyses'} remaining today`}
        </p>
      )}

      {loading && currentPhase !== null && (
        <AnalysisProgress
          currentPhase={currentPhase}
          progress={progress ?? undefined}
          message={streamMessage}
        />
      )}

      {error !== null && (
        <p role="alert" className="text-sm text-red-400 text-left">
          {error}
        </p>
      )}
    </div>
  )
}
