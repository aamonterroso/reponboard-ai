'use client'

import { lazy, Suspense, useEffect, useState } from 'react'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAnalysisStream } from '@/hooks/use-analysis-stream'
import { AnalysisProgress } from './analysis-progress'
import { AiLabPanelSkeleton } from './ai-lab/ai-lab-panel'
import { ResultsSkeleton } from './skeletons/results-skeleton'

// Code-split: the results view (and the Q&A stack under it) and the AI
// Lab only load once an analysis starts, so first paint ships just the
// input form. Suspense shows the existing skeletons while chunks load.
const loadAnalysisResult = () => import('./analysis-result')
const AnalysisResult = lazy(() =>
  loadAnalysisResult().then((m) => ({ default: m.AnalysisResult })),
)
const loadAiLab = () => import('./ai-lab/ai-lab-panel')
const AiLabPanel = lazy(() => loadAiLab().then((m) => ({ default: m.AiLabPanel })))

const GITHUB_URL_REGEX = /^https?:\/\/github\.com\/[\w][\w.-]*\/[\w][\w.-]*\/?$/i
const LAB_OPEN_STORAGE_KEY = 'reponboard:ai-lab-open'

function isValidGitHubUrl(url: string): boolean {
  return GITHUB_URL_REGEX.test(url.trim())
}

function readLabOpen(): boolean {
  try {
    return window.localStorage.getItem(LAB_OPEN_STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

function fetchRemaining(onValue: (remaining: number | null) => void): void {
  void fetch('/api/remaining')
    .then((r) => r.json())
    .then((data: { remaining: number | null }) => onValue(data.remaining))
    .catch(() => undefined)
}

export function UrlInput(): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)
  const [remaining, setRemaining] = useState<number | null>(null)
  const [labOpen, setLabOpen] = useState(true)
  const { state, analyze, reset } = useAnalysisStream()

  useEffect(() => {
    fetchRemaining(setRemaining)
    setLabOpen(readLabOpen())
  }, [])

  function toggleLab(): void {
    setLabOpen((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem(LAB_OPEN_STORAGE_KEY, String(next))
      } catch {
        /* storage unavailable */
      }
      return next
    })
  }

  // Warm the results chunks while the user is still typing.
  function prefetchResults(): void {
    void loadAnalysisResult()
    void loadAiLab()
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>): void {
    setUrl(e.target.value)
    if (inputError !== null) setInputError(null)
  }

  async function handleAnalyze(): Promise<void> {
    const trimmed = url.trim()

    if (trimmed === '') {
      setInputError('Please enter a GitHub repository URL.')
      return
    }

    if (!isValidGitHubUrl(trimmed)) {
      setInputError('Must be a valid GitHub repository URL — e.g. https://github.com/owner/repo')
      return
    }

    setInputError(null)
    const info = await analyze(trimmed)
    if (info?.remaining !== null && info?.remaining !== undefined) {
      setRemaining(info.remaining)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      void handleAnalyze()
    }
  }

  function handleReset(): void {
    setUrl('')
    setInputError(null)
    reset()
    fetchRemaining(setRemaining)
  }

  const loading = state.status === 'streaming'
  const error = inputError ?? state.error
  // A request that fails before anything streams (429, bad repo) keeps the
  // form on screen with the error under it.
  const failedBeforeStream =
    state.status === 'error' && state.core === null && state.trace.length === 0
  const showInput = state.status === 'idle' || failedBeforeStream

  if (!showInput) {
    return (
      <div
        className={
          labOpen
            ? 'w-[min(1200px,calc(100vw-2rem))] grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] items-start'
            : 'w-full'
        }
      >
        <div className="flex flex-col gap-4 min-w-0">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              {state.currentPhase !== null && (
                <AnalysisProgress
                  seenPhases={state.seenPhases}
                  currentPhase={state.currentPhase}
                  message={state.message}
                />
              )}
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={toggleLab}
              aria-pressed={labOpen}
              className="shrink-0"
            >
              {labOpen ? (
                <PanelRightClose className="h-4 w-4" aria-hidden="true" />
              ) : (
                <PanelRightOpen className="h-4 w-4" aria-hidden="true" />
              )}
              <span className="text-xs">AI Lab</span>
            </Button>
          </div>
          {error !== null && (
            <p role="alert" className="text-sm text-red-400 text-left">
              {error}
            </p>
          )}
          {labOpen && (
            <Suspense fallback={<AiLabPanelSkeleton className="lg:hidden" />}>
              <AiLabPanel state={state} className="lg:hidden max-h-[60vh]" />
            </Suspense>
          )}
          <Suspense fallback={<ResultsSkeleton />}>
            <AnalysisResult
              core={state.core}
              guide={state.guide}
              discovery={state.discovery}
              analysisMeta={state.analysisMeta}
              complete={state.status === 'complete'}
              onReset={handleReset}
            />
          </Suspense>
        </div>
        {labOpen && (
          <Suspense fallback={<AiLabPanelSkeleton className="hidden lg:flex lg:sticky lg:top-4" />}>
            <AiLabPanel
              state={state}
              className="hidden lg:flex lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)]"
            />
          </Suspense>
        )}
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
          onFocus={prefetchResults}
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
