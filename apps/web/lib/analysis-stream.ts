import type {
  AnalysisMetaByPhase,
  AnalysisPhase,
  AnalysisProgressEvent,
  DiscoveryResult,
  LLMCorePartial,
  LLMGuidePartial,
  TraceLlmCall,
} from '@reponboard/agent-core'

// Every event the /api/analyze SSE stream can carry. `cache_hit` is added
// by the route when it replays a stored analysis.
export type AnalysisStreamEvent =
  | AnalysisProgressEvent
  | { phase: 'cache_hit'; cachedAt: string }

export type TraceEntry =
  | { kind: 'llm'; id: string; call: TraceLlmCall; atMs: number }
  | {
      kind: 'tool'
      id: string
      name: string
      label: string
      status: 'running' | 'ok' | 'blocked'
      durationMs: number | null
      resultChars: number | null
      atMs: number
    }

export interface TraceTotals {
  llmCalls: number
  toolCalls: number
  tokensIn: number
  tokensOut: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
}

export interface AnalysisStreamState {
  status: 'idle' | 'streaming' | 'complete' | 'error'
  error: string | null
  seenPhases: Set<AnalysisPhase>
  currentPhase: AnalysisPhase | null
  message: string
  core: LLMCorePartial | null
  guide: LLMGuidePartial | null
  discovery: DiscoveryResult | null
  analysisMeta: { id: string; repoUrl: string; meta: AnalysisMetaByPhase | null } | null
  trace: TraceEntry[]
  totals: TraceTotals
  models: string[]
  cachedAt: string | null
  startedAt: number | null
  finishedAt: number | null
}

export type AnalysisStreamAction =
  | { type: 'start'; now: number }
  | { type: 'event'; event: AnalysisStreamEvent; now: number }
  | { type: 'fail'; error: string; now: number }
  | { type: 'reset' }

const EMPTY_TOTALS: TraceTotals = {
  llmCalls: 0,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
}

export const initialAnalysisStreamState: AnalysisStreamState = {
  status: 'idle',
  error: null,
  seenPhases: new Set(),
  currentPhase: null,
  message: '',
  core: null,
  guide: null,
  discovery: null,
  analysisMeta: null,
  trace: [],
  totals: EMPTY_TOTALS,
  models: [],
  cachedAt: null,
  startedAt: null,
  finishedAt: null,
}

// Share of all input tokens served from the prompt cache.
export function cacheHitRatio(totals: TraceTotals): number {
  const input = totals.tokensIn + totals.cacheReadTokens + totals.cacheWriteTokens
  return input === 0 ? 0 : totals.cacheReadTokens / input
}

function withPhase(state: AnalysisStreamState, phase: AnalysisPhase): Set<AnalysisPhase> {
  if (state.seenPhases.has(phase)) return state.seenPhases
  const next = new Set(state.seenPhases)
  next.add(phase)
  return next
}

function elapsed(state: AnalysisStreamState, now: number): number {
  return state.startedAt === null ? 0 : now - state.startedAt
}

function applyEvent(
  state: AnalysisStreamState,
  event: AnalysisStreamEvent,
  now: number,
): AnalysisStreamState {
  if (event.phase === 'cache_hit') {
    return { ...state, cachedAt: event.cachedAt, message: 'Loaded from cache' }
  }

  const seenPhases = withPhase(state, event.phase)

  switch (event.phase) {
    case 'discovery':
    case 'analyzing':
      return { ...state, seenPhases, currentPhase: event.phase, message: event.message }
    case 'fetching':
      return { ...state, seenPhases, message: event.message }
    case 'thinking': {
      const base = {
        ...state,
        seenPhases,
        currentPhase: 'analyzing' as const,
        message: event.message,
      }
      if (event.toolUseId === undefined || event.toolCall === undefined) return base
      const label = event.message.includes(': ')
        ? event.message.slice(event.message.indexOf(': ') + 2)
        : ''
      return {
        ...base,
        trace: [
          ...state.trace,
          {
            kind: 'tool',
            id: event.toolUseId,
            name: event.toolCall,
            label,
            status: 'running',
            durationMs: null,
            resultChars: null,
            atMs: elapsed(state, now),
          },
        ],
      }
    }
    case 'llm_call': {
      const { call } = event
      const totals: TraceTotals = {
        llmCalls: state.totals.llmCalls + 1,
        toolCalls: state.totals.toolCalls,
        tokensIn: state.totals.tokensIn + call.tokensIn,
        tokensOut: state.totals.tokensOut + call.tokensOut,
        cacheReadTokens: state.totals.cacheReadTokens + call.cacheReadTokens,
        cacheWriteTokens: state.totals.cacheWriteTokens + call.cacheWriteTokens,
        costUsd: state.totals.costUsd + call.costUsd,
      }
      return {
        ...state,
        seenPhases,
        totals,
        models: state.models.includes(call.model) ? state.models : [...state.models, call.model],
        trace: [
          ...state.trace,
          {
            kind: 'llm',
            id: `llm-${state.totals.llmCalls}`,
            call,
            atMs: elapsed(state, now),
          },
        ],
      }
    }
    case 'tool_end': {
      const { tool } = event
      let matched = false
      const trace = state.trace.map((entry): TraceEntry => {
        if (entry.kind !== 'tool' || entry.id !== tool.toolUseId) return entry
        matched = true
        return {
          ...entry,
          status: tool.status,
          durationMs: tool.durationMs,
          resultChars: tool.resultChars,
        }
      })
      return {
        ...state,
        seenPhases,
        totals: matched
          ? { ...state.totals, toolCalls: state.totals.toolCalls + 1 }
          : state.totals,
        trace,
      }
    }
    case 'partial_core':
      return { ...state, seenPhases, core: event.core }
    case 'partial_guide':
      return { ...state, seenPhases, guide: event.guide }
    case 'complete': {
      const { result } = event
      const llm = result.llmAnalysis
      // A cache replay skips the intermediate phases; mark every phase the
      // result covers as done so the stepper reads complete.
      const donePhases = new Set(seenPhases)
      donePhases.add('discovery')
      donePhases.add('analyzing')
      if (llm !== null) {
        donePhases.add('partial_core')
        donePhases.add('partial_guide')
      }
      return {
        ...state,
        seenPhases: donePhases,
        status: 'complete',
        currentPhase: 'complete',
        message: '',
        discovery: result.discovery,
        analysisMeta: { id: result.id, repoUrl: result.repoUrl, meta: result.meta ?? null },
        core:
          llm !== null
            ? {
                refinedStack: llm.refinedStack,
                executiveSummary: llm.executiveSummary,
                architectureInsights: llm.architectureInsights,
              }
            : state.core,
        guide:
          llm !== null
            ? {
                keyFiles: llm.keyFiles,
                explorationPath: llm.explorationPath,
                codebaseContext: llm.codebaseContext,
              }
            : state.guide,
        finishedAt: now,
      }
    }
    case 'error':
      return { ...state, seenPhases, status: 'error', error: event.error, finishedAt: now }
  }
}

export function analysisStreamReducer(
  state: AnalysisStreamState,
  action: AnalysisStreamAction,
): AnalysisStreamState {
  switch (action.type) {
    case 'start':
      return { ...initialAnalysisStreamState, status: 'streaming', startedAt: action.now }
    case 'event':
      return applyEvent(state, action.event, action.now)
    case 'fail':
      return { ...state, status: 'error', error: action.error, finishedAt: action.now }
    case 'reset':
      return initialAnalysisStreamState
  }
}
