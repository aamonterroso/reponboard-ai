'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Ban,
  Check,
  ChevronDown,
  Coins,
  Database,
  FileText,
  FlaskConical,
  FolderTree,
  LoaderCircle,
  Search,
  Sparkles,
  Timer,
  Users,
  Zap,
} from 'lucide-react'
import { cacheHitRatio } from '@/lib/analysis-stream'
import type { AnalysisStreamState, TraceEntry } from '@/lib/analysis-stream'

interface AiLabPanelProps {
  state: AnalysisStreamState
  className?: string
}

const STAGE_LABEL: Record<string, string> = {
  workers: 'Worker',
  core: 'Core',
  guide: 'Guide',
  qa: 'Q&A',
}

// claude-sonnet-5-5 -> Sonnet 5.5
export function shortModelName(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model)
  if (match === null) return model
  const [, family = '', major = '', minor] = match
  const name = family.charAt(0).toUpperCase() + family.slice(1)
  return minor !== undefined && minor.length <= 2 ? `${name} ${major}.${minor}` : `${name} ${major}`
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function formatUsd(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`
}

function useElapsed(state: AnalysisStreamState): number {
  const [now, setNow] = useState(() => Date.now())
  const streaming = state.status === 'streaming'
  useEffect(() => {
    if (!streaming) return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [streaming])
  if (state.startedAt === null) return 0
  return (state.finishedAt ?? now) - state.startedAt
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Timer
  label: string
  value: string
  hint?: string
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-zinc-500">
        <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
        {label}
      </div>
      <div className="mt-0.5 font-mono text-sm text-zinc-100 tabular-nums truncate">{value}</div>
      {hint !== undefined && (
        <div className="text-[11px] text-zinc-500 font-mono truncate">{hint}</div>
      )}
    </div>
  )
}

function toolIcon(name: string): typeof FileText {
  if (name === 'fetch_file') return FileText
  if (name === 'list_directory') return FolderTree
  if (name === 'search_code') return Search
  return Zap
}

function LlmRow({ entry }: { entry: Extract<TraceEntry, { kind: 'llm' }> }): React.JSX.Element {
  const { call } = entry
  const input = call.tokensIn + call.cacheReadTokens + call.cacheWriteTokens
  const cachedPct = input === 0 ? 0 : Math.round((call.cacheReadTokens / input) * 100)
  const isWorker = call.stage === 'workers'

  return (
    <li className="relative pl-6">
      <span
        className={`absolute left-0 top-1 flex h-4 w-4 items-center justify-center rounded-full ${
          isWorker ? 'bg-sky-950 text-sky-400' : 'bg-emerald-950 text-emerald-400'
        }`}
        aria-hidden="true"
      >
        {isWorker ? <Users className="h-2.5 w-2.5" /> : <Sparkles className="h-2.5 w-2.5" />}
      </span>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-zinc-200">
          <span className="font-medium">{STAGE_LABEL[call.stage] ?? call.stage}</span>
          <span className="text-zinc-500"> · {shortModelName(call.model)}</span>
        </span>
        <span className="font-mono text-[11px] text-zinc-500 tabular-nums shrink-0">
          {formatMs(call.latencyMs)}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-zinc-500 tabular-nums">
        <span>
          {formatTokens(input)} in · {formatTokens(call.tokensOut)} out
        </span>
        {call.cacheReadTokens > 0 && <span className="text-emerald-500">{cachedPct}% cached</span>}
        <span>{formatUsd(call.costUsd)}</span>
      </div>
      {call.toolUses.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {call.toolUses.map((name, i) => (
            <span
              key={`${name}-${i}`}
              className="rounded border border-zinc-800 bg-zinc-900 px-1 py-px font-mono text-[10px] text-zinc-400"
            >
              {name}
            </span>
          ))}
        </div>
      )}
      {call.reasoning !== null && (
        <details className="group mt-1">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300">
            <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" aria-hidden="true" />
            Reasoning summary
          </summary>
          <p className="mt-1 whitespace-pre-wrap rounded bg-zinc-950 p-2 text-[11px] leading-relaxed text-zinc-400">
            {call.reasoning}
          </p>
        </details>
      )}
    </li>
  )
}

function ToolRow({ entry }: { entry: Extract<TraceEntry, { kind: 'tool' }> }): React.JSX.Element {
  const Icon = toolIcon(entry.name)
  return (
    <li className="relative pl-6">
      <span
        className="absolute left-0 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-zinc-800 text-zinc-400"
        aria-hidden="true"
      >
        <Icon className="h-2.5 w-2.5" />
      </span>
      <div className="flex items-center justify-between gap-2 min-w-0">
        <span className="min-w-0 truncate font-mono text-[11px] text-zinc-300">
          {entry.name}
          {entry.label !== '' && <span className="text-zinc-500"> {entry.label}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-zinc-500 tabular-nums">
          {entry.status === 'running' && (
            <LoaderCircle className="h-3 w-3 animate-spin text-emerald-400" aria-label="running" />
          )}
          {entry.status === 'ok' && <Check className="h-3 w-3 text-emerald-500" aria-label="done" />}
          {entry.status === 'blocked' && (
            <Ban className="h-3 w-3 text-amber-500" aria-label="blocked by tool budget" />
          )}
          {entry.durationMs !== null && formatMs(entry.durationMs)}
        </span>
      </div>
    </li>
  )
}

// Live view of the agent run: every model call (tokens, cache reuse,
// cost, reasoning summary) and every tool call, streamed over SSE as it
// happens. On a cache hit it replays the original run's trace.
export function AiLabPanel({ state, className = '' }: AiLabPanelProps): React.JSX.Element {
  const elapsedMs = useElapsed(state)
  const listEndRef = useRef<HTMLLIElement>(null)
  const { totals } = state
  const streaming = state.status === 'streaming'

  useEffect(() => {
    if (!streaming) return
    listEndRef.current?.scrollIntoView({ block: 'nearest' })
  }, [state.trace.length, streaming])

  const statusBadge =
    state.cachedAt !== null ? (
      <span className="rounded-full border border-sky-800 bg-sky-950 px-2 py-0.5 text-[11px] text-sky-300">
        cache hit
      </span>
    ) : streaming ? (
      <span className="flex items-center gap-1.5 rounded-full border border-emerald-800 bg-emerald-950 px-2 py-0.5 text-[11px] text-emerald-300">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
        live
      </span>
    ) : state.status === 'error' ? (
      <span className="rounded-full border border-red-900 bg-red-950 px-2 py-0.5 text-[11px] text-red-300">
        error
      </span>
    ) : (
      <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-400">
        done
      </span>
    )

  return (
    <aside
      aria-label="AI Lab: live agent trace"
      className={`flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900/80 p-3 text-left ${className}`}
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
          <FlaskConical className="h-4 w-4 text-emerald-400" aria-hidden="true" />
          AI Lab
        </h2>
        {statusBadge}
      </header>

      <div className="grid grid-cols-3 gap-2">
        <Stat icon={Timer} label="Elapsed" value={formatMs(elapsedMs)} />
        {state.cachedAt !== null ? (
          <Stat icon={Coins} label="Cost" value="$0" hint={`orig ${formatUsd(totals.costUsd)}`} />
        ) : (
          <Stat icon={Coins} label="Cost" value={formatUsd(totals.costUsd)} />
        )}
        <Stat
          icon={Database}
          label="Cached"
          value={`${Math.round(cacheHitRatio(totals) * 100)}%`}
          hint="of input"
        />
        <Stat
          icon={Zap}
          label="Tokens"
          value={formatTokens(totals.tokensIn + totals.cacheReadTokens + totals.cacheWriteTokens)}
          hint={`${formatTokens(totals.tokensOut)} out`}
        />
        <Stat icon={Sparkles} label="LLM calls" value={String(totals.llmCalls)} />
        <Stat icon={FileText} label="Tools" value={String(totals.toolCalls)} />
      </div>

      {state.models.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {state.models.map((model) => (
            <span
              key={model}
              className="rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300"
            >
              {shortModelName(model)}
            </span>
          ))}
        </div>
      )}

      {state.cachedAt !== null && (
        <p className="text-[11px] text-zinc-500">
          Replayed from a run on {new Date(state.cachedAt).toLocaleString()} for this commit — no
          tokens spent.
        </p>
      )}

      {/* Bottom padding keeps the last row clear of the floating Q&A button. */}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1 pb-14">
        {state.trace.length === 0 ? (
          <p className="py-6 text-center text-xs text-zinc-500">
            {streaming ? 'Scanning the repository…' : 'No agent steps recorded.'}
          </p>
        ) : (
          <ol className="flex flex-col gap-3 border-l border-zinc-800 pl-2">
            {state.trace.map((entry) =>
              entry.kind === 'llm' ? (
                <LlmRow key={entry.id} entry={entry} />
              ) : (
                <ToolRow key={entry.id} entry={entry} />
              ),
            )}
            <li ref={listEndRef} aria-hidden="true" />
          </ol>
        )}
      </div>
    </aside>
  )
}

export function AiLabPanelSkeleton({ className = '' }: { className?: string }): React.JSX.Element {
  return (
    <div
      className={`flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900/80 p-3 ${className}`}
      aria-hidden="true"
    >
      <div className="h-4 w-20 rounded bg-zinc-800 animate-pulse-subtle" />
      <div className="grid grid-cols-3 gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-12 rounded-md bg-zinc-800/60 animate-pulse-subtle" />
        ))}
      </div>
      <div className="h-40 rounded bg-zinc-800/40 animate-pulse-subtle" />
    </div>
  )
}
