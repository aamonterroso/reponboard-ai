import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: mockCreate,
      },
    })),
  }
})

vi.mock('./github', () => {
  return {
    GitHubClient: vi.fn().mockImplementation(() => ({
      getTree: vi.fn().mockResolvedValue([
        { path: 'src/a.ts', type: 'blob' },
        { path: 'src/b.ts', type: 'blob' },
        { path: 'src/c.ts', type: 'blob' },
        { path: 'src/d.ts', type: 'blob' },
        { path: 'src/e.ts', type: 'blob' },
        { path: 'src/f.ts', type: 'blob' },
      ]),
    })),
  }
})

vi.mock('./llm-analysis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./llm-analysis')>()
  return {
    ...actual,
    executeExplorationTool: vi
      .fn()
      .mockImplementation(async (_name: string, input: unknown) => {
        const inp = input as { path?: string }
        return `mock contents of ${inp.path ?? '<no path>'}`
      }),
  }
})

import { answerQuestion } from './qa'
import { buildInitialTelemetry } from './qa-telemetry'

type Anthropic = typeof import('@anthropic-ai/sdk')

function fetchFileResponse(id: string, path: string) {
  return {
    content: [
      {
        type: 'tool_use' as const,
        id,
        name: 'fetch_file',
        input: { path },
      },
    ],
    usage: { input_tokens: 100, output_tokens: 80 },
  }
}

function respondResponse(answer: string, filesReferenced: string[]) {
  return {
    content: [
      {
        type: 'tool_use' as const,
        id: 'respond-1',
        name: 'respond',
        input: { answer, filesReferenced },
      },
    ],
    usage: { input_tokens: 150, output_tokens: 120 },
  }
}

beforeEach(() => {
  mockCreate.mockReset()
})

describe('answerQuestion — QA_MAX_TOOL_CALLS budget', () => {
  it('stops exploration at 4 tool calls and forces tool_choice=respond on the next iteration', async () => {
    // Greedy agent: would have fetched 6 files if allowed. The budget
    // hits after the 4th fetch_file, then iter 5 is run with
    // tool_choice forcing respond.
    mockCreate
      .mockResolvedValueOnce(fetchFileResponse('t1', 'src/a.ts'))
      .mockResolvedValueOnce(fetchFileResponse('t2', 'src/b.ts'))
      .mockResolvedValueOnce(fetchFileResponse('t3', 'src/c.ts'))
      .mockResolvedValueOnce(fetchFileResponse('t4', 'src/d.ts'))
      // 5th call would happen with tool_choice forced; mock returns respond.
      .mockResolvedValueOnce(
        respondResponse('Here is what I found across 4 files.', [
          'src/a.ts',
          'src/b.ts',
          'src/c.ts',
          'src/d.ts',
        ]),
      )

    const telemetry = buildInitialTelemetry({
      requestId: 'test-req-1',
      repoUrl: 'https://github.com/example/repo',
      question: 'Trace the request lifecycle through this codebase.',
      historyLength: 0,
    })

    const events: unknown[] = []
    const gen = answerQuestion(
      'Trace the request lifecycle through this codebase.',
      { owner: 'example', repo: 'repo', branch: 'main' },
      'Sample analysis context',
      [],
      'test-api-key',
      undefined,
      'production',
      'fast',
      telemetry,
    )
    for await (const ev of gen) {
      events.push(ev)
    }

    // 1. Exactly 5 SDK calls: 4 exploration + 1 forced respond.
    expect(mockCreate).toHaveBeenCalledTimes(5)

    // 2. First 4 calls MUST set tool_choice = auto with parallel tool
    // use disabled. This is what turns QA_MAX_TOOL_CALLS into a real
    // per-file hard cap: the model can emit at most one tool_use per
    // response, so toolCallCount cannot overshoot the threshold via
    // parallel tool use.
    const calls = mockCreate.mock.calls.map((c) => c[0] as Record<string, unknown>)
    for (let i = 0; i < 4; i++) {
      const call = calls[i]
      if (call === undefined) throw new Error(`missing SDK call ${i}`)
      expect(call.tool_choice).toEqual({
        type: 'auto',
        disable_parallel_tool_use: true,
      })
    }

    // 3. 5th call MUST include tool_choice forcing 'respond'.
    const forcedCall = calls[4]
    if (forcedCall === undefined) throw new Error('missing forced SDK call')
    expect(forcedCall.tool_choice).toEqual({ type: 'tool', name: 'respond' })

    // 4. Generator emitted a single complete event with the forced answer.
    const complete = events.find(
      (e): e is { phase: 'complete'; result: { answer: string; filesReferenced: string[]; costUsd: number } } =>
        typeof e === 'object' && e !== null && (e as { phase?: string }).phase === 'complete',
    )
    if (complete === undefined) throw new Error('expected complete event')
    expect(complete.result.answer).toContain('Here is what I found')
    expect(complete.result.filesReferenced).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/d.ts',
    ])

    // 5. Telemetry: budget exhausted, count = 4.
    expect(telemetry.toolBudgetExhausted).toBe(true)
    expect(telemetry.toolCallsUsed).toBe(4)

    // 6. hallucinatedFileReferences should stay empty — the agent only
    // cites the 4 files it actually fetched within the budget. The
    // route-level validator computes this separately, but here we
    // verify the precondition holds at the agent boundary.
    const fetchedPaths = new Set<string>()
    for (const ev of events) {
      if (
        typeof ev === 'object' &&
        ev !== null &&
        (ev as { phase?: string }).phase === 'thinking' &&
        (ev as { toolCall?: string }).toolCall === 'fetch_file'
      ) {
        const inp = (ev as { toolInput?: { path?: unknown } }).toolInput
        if (typeof inp?.path === 'string') fetchedPaths.add(inp.path)
      }
    }
    for (const cited of complete.result.filesReferenced) {
      expect(fetchedPaths.has(cited)).toBe(true)
    }
  })

  it('does NOT force tool_choice when the agent finishes naturally before the budget', async () => {
    // Agent only needs 2 fetches and then responds — budget never hit.
    mockCreate
      .mockResolvedValueOnce(fetchFileResponse('t1', 'src/a.ts'))
      .mockResolvedValueOnce(fetchFileResponse('t2', 'src/b.ts'))
      .mockResolvedValueOnce(
        respondResponse('Short answer using 2 files.', ['src/a.ts', 'src/b.ts']),
      )

    const telemetry = buildInitialTelemetry({
      requestId: 'test-req-2',
      repoUrl: 'https://github.com/example/repo',
      question: 'What does a.ts do?',
      historyLength: 0,
    })

    const gen = answerQuestion(
      'What does a.ts do?',
      { owner: 'example', repo: 'repo', branch: 'main' },
      'ctx',
      [],
      'test-api-key',
      undefined,
      'production',
      'fast',
      telemetry,
    )
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of gen) {
      /* drain */
    }

    expect(mockCreate).toHaveBeenCalledTimes(3)
    const calls = mockCreate.mock.calls.map((c) => c[0] as Record<string, unknown>)
    // All non-forced calls should set tool_choice = auto with parallel
    // tool use disabled. None should be forced to 'respond' since the
    // budget was never hit.
    for (const c of calls) {
      expect(c.tool_choice).toEqual({
        type: 'auto',
        disable_parallel_tool_use: true,
      })
    }
    expect(telemetry.toolBudgetExhausted).toBe(false)
    expect(telemetry.toolCallsUsed).toBe(2)
  })
})
