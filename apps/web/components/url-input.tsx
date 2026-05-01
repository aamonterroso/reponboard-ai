'use client'

import { useState, useEffect } from 'react'
import type {
  AnalysisMeta,
  AnalysisPhase,
  DiscoveryResult,
  FullAnalysisResult,
  LLMCorePartial,
  LLMGuidePartial,
} from '@reponboard/agent-core'
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
  const [core, setCore] = useState<LLMCorePartial | null>(null)
  const [guide, setGuide] = useState<LLMGuidePartial | null>(null)
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null)
  const [analysisMeta, setAnalysisMeta] = useState<{
    id: string
    repoUrl: string
    meta: AnalysisMeta | null
  } | null>(null)
  const [complete, setComplete] = useState(false)
  const [seenPhases, setSeenPhases] = useState<Set<AnalysisPhase>>(new Set())
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
        if (response.status === 429) {
          setRemaining(0)
        }
        return
      }

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
                phase: AnalysisPhase
                result?: FullAnalysisResult
                error?: string
                message?: string
                core?: LLMCorePartial
                guide?: LLMGuidePartial
                progress?: unknown
              }

              setSeenPhases((prev) => {
                const next = new Set(prev)
                next.add(event.phase)
                return next
              })

              if (event.phase === 'discovery') {
                setCurrentPhase('discovery')
                setStreamMessage(event.message ?? '')
              } else if (event.phase === 'analyzing') {
                setCurrentPhase('analyzing')
                setStreamMessage(event.message ?? '')
              } else if (event.phase === 'thinking') {
                setCurrentPhase('analyzing')
                setStreamMessage(event.message ?? 'Agent is thinking...')
              } else if (event.phase === 'partial_core' && event.core !== undefined) {
                setCore(event.core)
              } else if (event.phase === 'partial_guide' && event.guide !== undefined) {
                setGuide(event.guide)
              } else if (event.phase === 'complete' && event.result !== undefined) {
                setDiscovery(event.result.discovery)
                setAnalysisMeta({
                  id: event.result.id,
                  repoUrl: event.result.repoUrl,
                  meta: event.result.meta ?? null,
                })
                setComplete(true)
                if (event.result.llmAnalysis !== null) {
                  setCore({
                    refinedStack: event.result.llmAnalysis.refinedStack,
                    executiveSummary: event.result.llmAnalysis.executiveSummary,
                    architectureInsights: event.result.llmAnalysis.architectureInsights,
                  })
                  setGuide({
                    keyFiles: event.result.llmAnalysis.keyFiles,
                    explorationPath: event.result.llmAnalysis.explorationPath,
                    codebaseContext: event.result.llmAnalysis.codebaseContext,
                  })
                }
                setCurrentPhase('complete')
                setStreamMessage('')
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
        // Fallback: non-streaming JSON response (e.g. heuristic-only path)
        const data: unknown = await response.json()
        const fallback = data as FullAnalysisResult
        setDiscovery(fallback.discovery)
        setAnalysisMeta({
          id: fallback.id,
          repoUrl: fallback.repoUrl,
          meta: fallback.meta ?? null,
        })
        setComplete(true)
        if (fallback.llmAnalysis !== null) {
          setCore({
            refinedStack: fallback.llmAnalysis.refinedStack,
            executiveSummary: fallback.llmAnalysis.executiveSummary,
            architectureInsights: fallback.llmAnalysis.architectureInsights,
          })
          setGuide({
            keyFiles: fallback.llmAnalysis.keyFiles,
            explorationPath: fallback.llmAnalysis.explorationPath,
            codebaseContext: fallback.llmAnalysis.codebaseContext,
          })
        }
        setCurrentPhase('complete')
        setStreamMessage('')
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
    setCore(null)
    setGuide(null)
    setDiscovery(null)
    setAnalysisMeta(null)
    setComplete(false)
    setSeenPhases(new Set())
    setCurrentPhase(null)
    setProgress(null)
    setStreamMessage('')
    void fetch('/api/remaining')
      .then((r) => r.json())
      .then((data: { remaining: number }) => {
        setRemaining(data.remaining)
      })
      .catch(() => undefined)
  }

  const showInput = !loading && !complete && core === null

  if (!showInput) {
    return (
      <div className="w-full flex flex-col gap-4">
        {currentPhase !== null && (
          <AnalysisProgress
            seenPhases={seenPhases}
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
        <AnalysisResult
          core={core}
          guide={guide}
          discovery={discovery}
          analysisMeta={analysisMeta}
          complete={complete}
          onReset={handleReset}
        />
      </div>
    )
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

      {error !== null && (
        <p role="alert" className="text-sm text-red-400 text-left">
          {error}
        </p>
      )}
    </div>
  )
}
