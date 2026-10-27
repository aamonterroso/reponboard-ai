import { describe, it, expect, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { formatWorkerSummaries, summarizeFilesWithWorkers } from './file-workers'
import { calculateCost } from './pricing'
import { withClosedObjects } from './llm-analysis'

function fakeClient(create: ReturnType<typeof vi.fn>): Anthropic {
  return { messages: { create } } as unknown as Anthropic
}

function textResponse(text: string) {
  return {
    content: [
      { type: 'thinking', thinking: '', signature: 's' },
      { type: 'text', text },
    ],
    usage: { input_tokens: 1000, output_tokens: 100 },
  }
}

describe('summarizeFilesWithWorkers', () => {
  it('runs one Haiku worker per file and reads text blocks by type', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(textResponse('Defines the router.'))
      .mockResolvedValueOnce(textResponse('Holds config defaults.'))

    const run = await summarizeFilesWithWorkers(
      fakeClient(create),
      new Map([
        ['src/router.ts', 'export function route() {}'],
        ['src/config.ts', 'export const defaults = {}'],
      ]),
    )

    expect(create).toHaveBeenCalledTimes(2)
    for (const [params] of create.mock.calls) {
      expect((params as { model: string }).model).toBe('claude-haiku-5-5')
    }
    expect(run.summaries).toEqual([
      { path: 'src/router.ts', summary: 'Defines the router.' },
      { path: 'src/config.ts', summary: 'Holds config defaults.' },
    ])
    expect(run.calls).toBe(2)
    expect(run.costUsd).toBeCloseTo(
      2 * calculateCost('claude-haiku-5-5', { tokensIn: 1000, tokensOut: 100 }),
    )
  })

  it('drops a failed worker instead of failing the batch', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('bad request'), { status: 400 }))
      .mockResolvedValueOnce(textResponse('Still summarized.'))

    const run = await summarizeFilesWithWorkers(
      fakeClient(create),
      new Map([
        ['a.ts', 'a'],
        ['b.ts', 'b'],
      ]),
    )
    expect(run.summaries).toEqual([{ path: 'b.ts', summary: 'Still summarized.' }])
  })

  it('formats nothing when there are no summaries', () => {
    expect(formatWorkerSummaries([])).toBe('')
  })
})

describe('calculateCost with prompt caching', () => {
  it('bills cache reads at 0.1x and cache writes at 1.25x the input rate', () => {
    // Sonnet 5.5: $2/M input, $10/M output.
    const cost = calculateCost('claude-sonnet-5-5', {
      tokensIn: 1_000_000,
      tokensOut: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    })
    expect(cost).toBeCloseTo(2 + 0.2 + 2.5)
  })
})

describe('withClosedObjects', () => {
  it('sets additionalProperties: false on every nested object schema', () => {
    const schema = withClosedObjects({
      type: 'object',
      properties: {
        list: {
          type: 'array',
          items: { type: 'object', properties: { a: { type: 'string' } } },
        },
        kind: { type: 'string', enum: ['x', 'y'] },
      },
    })
    expect(schema).toMatchObject({
      additionalProperties: false,
      properties: {
        list: { items: { additionalProperties: false } },
        kind: { enum: ['x', 'y'] },
      },
    })
    expect(schema.properties.kind).not.toHaveProperty('additionalProperties')
  })
})
