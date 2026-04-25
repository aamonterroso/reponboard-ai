'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  FullAnalysisResult,
  QAMessage,
  QAResult,
} from '@reponboard/agent-core'
import { Button } from '@/components/ui/button'

interface QaChatProps {
  result: FullAnalysisResult
}

interface ToolActivity {
  toolCall?: string
  label?: string
}

const COLLAPSE_CHAR_THRESHOLD = 220

function nowIso(): string {
  return new Date().toISOString()
}

function parseOwnerRepo(
  repoUrl: string,
): { owner: string; repo: string } | null {
  const m = /github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(repoUrl)
  if (m === null || m[1] === undefined || m[2] === undefined) return null
  return { owner: m[1], repo: m[2] }
}

function buildGitHubFileUrl(
  owner: string,
  repo: string,
  branch: string,
  path: string,
): string {
  return `https://github.com/${owner}/${repo}/blob/${branch}/${path}`
}

export function QaChat({ result }: QaChatProps): React.JSX.Element | null {
  const codebaseContext = result.llmAnalysis?.codebaseContext
  const repoUrl = result.repoUrl

  const ownerRepo = useMemo(() => parseOwnerRepo(repoUrl), [repoUrl])
  const branch = result.discovery?.repoInfo.defaultBranch ?? 'main'

  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<QAMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [activity, setActivity] = useState<ToolActivity | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [manuallyExpanded, setManuallyExpanded] = useState<Set<number>>(
    () => new Set(),
  )
  const listEndRef = useRef<HTMLDivElement | null>(null)

  // Most recent assistant message is always fully expanded
  const lastAssistantIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant') return i
    }
    return -1
  }, [messages])

  // ESC to close
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // Auto-scroll messages to the bottom as they update
  useEffect(() => {
    if (!open) return
    listEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, activity, loading, open])

  const sendQuestion = useCallback(
    async (question: string): Promise<void> => {
      if (codebaseContext === undefined) return
      const userMessage: QAMessage = {
        role: 'user',
        content: question,
        filesReferenced: [],
        timestamp: nowIso(),
      }
      setMessages((prev) => [...prev, userMessage])
      setLoading(true)
      setError(null)
      setActivity({ label: 'Thinking...' })

      try {
        const response = await fetch('/api/qa', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question,
            repoUrl,
            codebaseContext,
            history: messages,
          }),
        })

        if (!response.ok) {
          const data: unknown = await response.json().catch(() => ({}))
          const msg =
            (data as { error?: string }).error ??
            `Request failed (${response.status})`
          setError(msg)
          return
        }

        if (response.body === null) {
          setError('Empty response body')
          return
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let finalResult: QAResult | null = null

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
                message?: string
                toolCall?: string
                toolInput?: Record<string, unknown>
                tool?: string
                summary?: string
                result?: QAResult
                error?: string
              }
              if (event.phase === 'thinking') {
                const inp = event.toolInput ?? {}
                const label =
                  typeof inp.path === 'string'
                    ? inp.path
                    : typeof inp.query === 'string'
                      ? inp.query
                      : (event.message ?? '')
                const nextActivity: ToolActivity = {}
                if (event.toolCall !== undefined)
                  nextActivity.toolCall = event.toolCall
                if (label !== '') nextActivity.label = label
                setActivity(nextActivity)
              } else if (
                event.phase === 'complete' &&
                event.result !== undefined
              ) {
                finalResult = event.result
              } else if (
                event.phase === 'error' &&
                event.error !== undefined
              ) {
                setError(event.error)
                return
              }
            } catch {
              // skip malformed lines
            }
          }
        }

        if (finalResult !== null) {
          const assistantMessage: QAMessage = {
            role: 'assistant',
            content: finalResult.answer,
            filesReferenced: finalResult.filesReferenced,
            timestamp: nowIso(),
          }
          setMessages((prev) => [...prev, assistantMessage])
        } else {
          setError('No answer was produced.')
        }
      } catch {
        setError('Failed to reach the server. Please try again.')
      } finally {
        setLoading(false)
        setActivity(null)
      }
    },
    [codebaseContext, messages, repoUrl],
  )

  function handleSend(): void {
    const trimmed = input.trim()
    if (trimmed === '' || loading) return
    setInput('')
    void sendQuestion(trimmed)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function toggleMessageExpanded(index: number): void {
    setManuallyExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  function isAssistantExpanded(index: number, content: string): boolean {
    if (content.length <= COLLAPSE_CHAR_THRESHOLD) return true
    if (index === lastAssistantIndex) return !manuallyExpanded.has(-index - 1)
    return manuallyExpanded.has(index)
  }

  if (codebaseContext === undefined) return null

  return (
    <>
      {/* Floating action button */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Ask the agent"
        aria-expanded={open}
        className={`fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full bg-emerald-500 text-zinc-950 px-5 py-3 text-sm font-semibold shadow-lg shadow-emerald-950/40 transition-all duration-200 hover:bg-emerald-400 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
          open ? 'opacity-0 pointer-events-none translate-y-2' : 'opacity-100'
        }`}
      >
        <span>Ask the agent</span>
        <span aria-hidden="true" className="text-base leading-none">
          ✦
        </span>
      </button>

      {/* Drawer */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Ask the agent"
        className={`fixed inset-y-0 right-0 z-50 w-full sm:w-[420px] bg-zinc-950 border-l border-zinc-800 shadow-2xl transform transition-transform duration-300 ease-out flex flex-col ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 shrink-0">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">
            Ask the agent
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="h-8 w-8 inline-flex items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M3 3L13 13M13 3L3 13"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-0">
          {messages.length === 0 && (
            <p className="text-sm text-zinc-400 leading-relaxed pb-2">
              I&apos;ve analyzed this repo. Ask me anything — I&apos;ll read
              relevant files and answer with context.
            </p>
          )}

          {messages.map((msg, i) => {
            const isFirstOfPair = msg.role === 'user' && i > 0
            const expanded =
              msg.role === 'assistant'
                ? isAssistantExpanded(i, msg.content)
                : true
            const shouldShowToggle =
              msg.role === 'assistant' &&
              msg.content.length > COLLAPSE_CHAR_THRESHOLD
            const isLatestAssistant =
              msg.role === 'assistant' && i === lastAssistantIndex

            return (
              <div
                key={i}
                className={`flex flex-col gap-2 py-3 ${
                  isFirstOfPair ? 'border-t border-zinc-800/60' : ''
                } ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[90%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-zinc-800 text-zinc-100'
                      : 'bg-zinc-900 border border-zinc-800 text-zinc-100'
                  } ${
                    msg.role === 'assistant' && !expanded
                      ? 'line-clamp-3'
                      : ''
                  }`}
                >
                  {msg.content}
                </div>

                {shouldShowToggle && (
                  <button
                    type="button"
                    onClick={() =>
                      isLatestAssistant
                        ? toggleMessageExpanded(-i - 1)
                        : toggleMessageExpanded(i)
                    }
                    className="text-xs text-emerald-500 hover:text-emerald-400 transition-colors"
                  >
                    {expanded ? 'Show less' : 'Show more'}
                  </button>
                )}

                {msg.role === 'assistant' && msg.filesReferenced.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 max-w-[90%]">
                    {msg.filesReferenced.map((file) => {
                      const href =
                        ownerRepo !== null
                          ? buildGitHubFileUrl(
                              ownerRepo.owner,
                              ownerRepo.repo,
                              branch,
                              file,
                            )
                          : null
                      return href !== null ? (
                        <a
                          key={file}
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-mono text-zinc-300 bg-zinc-800/70 border border-zinc-700 px-1.5 py-0.5 rounded hover:bg-zinc-700 hover:text-zinc-100 transition-colors"
                        >
                          {file}
                        </a>
                      ) : (
                        <span
                          key={file}
                          className="text-xs font-mono text-zinc-400 bg-zinc-800/70 border border-zinc-700 px-1.5 py-0.5 rounded"
                        >
                          {file}
                        </span>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}

          {loading && (
            <div className="flex items-center gap-2 text-xs text-zinc-500 py-2">
              <svg
                className="animate-spin h-3.5 w-3.5 shrink-0"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              <span>
                {activity?.toolCall !== undefined
                  ? `${activity.toolCall}${activity.label !== undefined && activity.label !== '' ? `: ${activity.label}` : ''}`
                  : (activity?.label ?? 'Thinking...')}
              </span>
            </div>
          )}

          {error !== null && (
            <p role="alert" className="text-sm text-red-400 py-2">
              {error}
            </p>
          )}

          <div ref={listEndRef} />
        </div>

        {/* Input */}
        <div className="border-t border-zinc-800 p-3 shrink-0">
          <div className="flex gap-2 items-end">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={loading}
              placeholder="Ask a question about this repo..."
              rows={2}
              className="flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:border-transparent disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Question"
            />
            <Button
              type="button"
              onClick={handleSend}
              disabled={loading || input.trim() === ''}
              className="shrink-0 h-[52px]"
            >
              Send
            </Button>
          </div>
          <p className="text-[11px] text-zinc-600 mt-1.5">
            Enter to send · Shift+Enter for newline · Esc to close
          </p>
        </div>
      </div>
    </>
  )
}
