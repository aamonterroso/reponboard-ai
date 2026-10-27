import { describe, it, expect } from 'vitest'
import type { FullAnalysisResult, TraceLlmCall } from '@reponboard/agent-core'
import {
  analysisStreamReducer,
  cacheHitRatio,
  initialAnalysisStreamState,
} from './analysis-stream'
import type { AnalysisStreamEvent, AnalysisStreamState } from './analysis-stream'

function run(events: AnalysisStreamEvent[], start = 1000): AnalysisStreamState {
  let state = analysisStreamReducer(initialAnalysisStreamState, { type: 'start', now: start })
  events.forEach((event, i) => {
    state = analysisStreamReducer(state, { type: 'event', event, now: start + (i + 1) * 100 })
  })
  return state
}

const call: TraceLlmCall = {
  step: 1,
  stage: 'core',
  model: 'claude-sonnet-5-5',
  latencyMs: 4000,
  tokensIn: 100,
  tokensOut: 500,
  cacheReadTokens: 9000,
  cacheWriteTokens: 900,
  costUsd: 0.01,
  toolUses: ['fetch_file'],
  reasoning: 'Look at the entry point first.',
}

describe('analysisStreamReducer', () => {
  it('pairs a tool start with its tool_end by toolUseId', () => {
    const state = run([
      { phase: 'llm_call', call },
      {
        phase: 'thinking',
        message: 'fetch_file: src/index.ts',
        toolCall: 'fetch_file',
        toolUseId: 'tu_1',
      },
      {
        phase: 'tool_end',
        tool: {
          toolUseId: 'tu_1',
          name: 'fetch_file',
          label: 'src/index.ts',
          durationMs: 120,
          resultChars: 3000,
          status: 'ok',
        },
      },
    ])

    expect(state.trace).toHaveLength(2)
    const tool = state.trace[1]
    expect(tool).toMatchObject({
      kind: 'tool',
      label: 'src/index.ts',
      status: 'ok',
      durationMs: 120,
      atMs: 200,
    })
    expect(state.totals).toMatchObject({ llmCalls: 1, toolCalls: 1, costUsd: 0.01 })
    expect(state.models).toEqual(['claude-sonnet-5-5'])
  })

  it('ignores status-only thinking events in the trace', () => {
    const state = run([{ phase: 'thinking', message: 'Finalizing analysis...' }])
    expect(state.trace).toHaveLength(0)
    expect(state.message).toBe('Finalizing analysis...')
  })

  it('fills core and guide from the complete result and marks the run finished', () => {
    const result = {
      id: 'a1',
      repoUrl: 'https://github.com/o/r',
      status: 'complete',
      discovery: null,
      llmAnalysis: {
        refinedStack: {},
        executiveSummary: { oneLiner: 'x' },
        architectureInsights: {},
        keyFiles: [],
        explorationPath: [],
        codebaseContext: 'ctx',
      },
      error: null,
      meta: null,
      createdAt: '',
      completedAt: '',
    } as unknown as FullAnalysisResult

    const state = run([{ phase: 'cache_hit', cachedAt: '2026-10-27T00:00:00Z' }, { phase: 'complete', result }])
    expect(state.status).toBe('complete')
    expect(state.cachedAt).toBe('2026-10-27T00:00:00Z')
    expect(state.guide?.codebaseContext).toBe('ctx')
    expect(state.finishedAt).toBe(1200)
    expect([...state.seenPhases]).toEqual(
      expect.arrayContaining(['discovery', 'analyzing', 'partial_core', 'partial_guide', 'complete']),
    )
  })

  it('computes the cache hit ratio over all input tokens', () => {
    const state = run([{ phase: 'llm_call', call }])
    expect(cacheHitRatio(state.totals)).toBeCloseTo(9000 / 10_000)
  })

  it('reset returns to the initial state', () => {
    const state = analysisStreamReducer(run([{ phase: 'llm_call', call }]), { type: 'reset' })
    expect(state).toBe(initialAnalysisStreamState)
  })
})
