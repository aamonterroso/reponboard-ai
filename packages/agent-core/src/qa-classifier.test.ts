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

import { classifyQuestion } from './qa-classifier'

const BASE_INPUT = {
  question: 'How is authentication handled?',
  repoUrl: 'https://github.com/example/repo',
  repoSummary: 'A sample repo.',
  anthropicApiKey: 'test-key',
}

function makeResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 50, output_tokens: 80 },
  }
}

beforeEach(() => {
  mockCreate.mockReset()
})

describe('classifyQuestion', () => {
  it('returns degraded fail-open when SDK throws', async () => {
    mockCreate.mockRejectedValueOnce(new Error('network error'))

    const output = await classifyQuestion(BASE_INPUT)

    expect(output.degradedMode).toBe(true)
    expect(output.result.classification).toBe('on_topic')
    expect(output.result.confidence).toBe(0.5)
    expect(output.costUsd).toBe(0)
  })

  it('returns degraded fail-open when SDK returns non-JSON text', async () => {
    mockCreate.mockResolvedValueOnce(makeResponse('not valid json at all'))

    const output = await classifyQuestion(BASE_INPUT)

    expect(output.degradedMode).toBe(true)
    expect(output.result.classification).toBe('on_topic')
    expect(output.result.confidence).toBe(0.5)
    expect(output.costUsd).toBe(0)
  })

  it('returns on_topic result with no suggestions field and positive costUsd', async () => {
    const json = JSON.stringify({
      classification: 'on_topic',
      confidence: 0.95,
      reasoning: 'The question is about authentication in the repo.',
    })
    mockCreate.mockResolvedValueOnce(makeResponse(json))

    const output = await classifyQuestion(BASE_INPUT)

    expect(output.degradedMode).toBe(false)
    expect(output.result.classification).toBe('on_topic')
    expect(output.result.confidence).toBe(0.95)
    expect(output.result.suggestions).toBeUndefined()
    expect(output.costUsd).toBeGreaterThan(0)
  })

  it('returns off_topic with suggestions array of length 3', async () => {
    const json = JSON.stringify({
      classification: 'off_topic',
      confidence: 0.9,
      reasoning: 'The question is about an unrelated framework.',
      suggestions: [
        'How is the project structured?',
        'What dependencies does this repo use?',
        'Where is the entry point?',
      ],
    })
    mockCreate.mockResolvedValueOnce(makeResponse(json))

    const output = await classifyQuestion({
      ...BASE_INPUT,
      question: 'What do you think about Django vs Rails?',
    })

    expect(output.result.classification).toBe('off_topic')
    expect(output.result.suggestions).toHaveLength(3)
    expect(output.degradedMode).toBe(false)
  })

  it('parses JSON wrapped in markdown code fences (Haiku quirk)', async () => {
    const inner = JSON.stringify({
      classification: 'off_topic',
      confidence: 0.95,
      reasoning: 'Question is about Rust frameworks, not this repo.',
      suggestions: ['What is the entry point?', 'How are commands defined?', 'Where are the tests?'],
    })
    const fenced = '```json\n' + inner + '\n```'
    mockCreate.mockResolvedValueOnce(makeResponse(fenced))

    const output = await classifyQuestion(BASE_INPUT)

    expect(output.degradedMode).toBe(false)
    expect(output.result.classification).toBe('off_topic')
    expect(output.result.confidence).toBe(0.95)
    expect(output.result.suggestions).toHaveLength(3)
  })

  it('retries on first failure and succeeds on second attempt', async () => {
    mockCreate
      .mockRejectedValueOnce({ status: 529, message: 'overloaded' })
      .mockResolvedValueOnce(makeResponse(JSON.stringify({
        classification: 'on_topic', confidence: 0.9, reasoning: 'ok',
      })))

    const output = await classifyQuestion(BASE_INPUT)
    expect(output.degradedMode).toBe(false)
    expect(output.result.classification).toBe('on_topic')
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it('fails closed to off_topic when classifier dies AND question matches "best ... in 20XX"', async () => {
    mockCreate.mockRejectedValue({ status: 529, message: 'overloaded' })

    const output = await classifyQuestion({
      ...BASE_INPUT,
      question: 'What is the best CLI framework for Rust in 2026?',
    })

    expect(output.degradedMode).toBe(true)
    expect(output.result.classification).toBe('off_topic')
    expect(output.result.confidence).toBe(0.5)
    expect(output.result.suggestions).toEqual([])
    expect(output.costUsd).toBe(0)
  })

  it('fails closed to off_topic on "top N ... platform" pattern', async () => {
    mockCreate.mockRejectedValue({ status: 503 })
    const output = await classifyQuestion({
      ...BASE_INPUT,
      question: 'What are the top 5 deployment platforms in 2026?',
    })
    expect(output.degradedMode).toBe(true)
    expect(output.result.classification).toBe('off_topic')
  })

  it('fails open to on_topic when classifier dies and question has no heuristic match', async () => {
    mockCreate.mockRejectedValue({ status: 529 })
    const output = await classifyQuestion({
      ...BASE_INPUT,
      question: 'How does the parser handle escape characters?',
    })
    expect(output.degradedMode).toBe(true)
    expect(output.result.classification).toBe('on_topic')
    expect(output.result.confidence).toBe(0.5)
  })
})
