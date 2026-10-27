import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FullAnalysisResult } from '@reponboard/agent-core'

const store = new Map<string, unknown>()
const set = vi.fn(async (key: string, value: unknown) => {
  store.set(key, value)
  return 'OK'
})
const get = vi.fn(async (key: string) => store.get(key) ?? null)

vi.mock('./rate-limit', () => ({
  prefixKey: (key: string) => `test:${key}`,
  redis: { get: (k: string) => get(k), set: (k: string, v: unknown) => set(k, v) },
}))

const { analysisCacheKey, readCachedAnalysis, writeCachedAnalysis } = await import('./analysis-cache')

beforeEach(() => {
  store.clear()
  get.mockClear()
  set.mockClear()
})

describe('analysis cache', () => {
  it('keys on lower-cased repo, commit sha, and intent', () => {
    expect(analysisCacheKey({ owner: 'Colin', repo: 'Zod', sha: 'abc', intent: 'quality' })).toBe(
      'test:analysis:v1:colin/zod@abc:quality',
    )
  })

  it('drops the discovery tree before storing and reads the entry back', async () => {
    const result = {
      id: 'a',
      discovery: { tree: [{ path: 'x', type: 'blob' }], totalFiles: 1 },
      llmAnalysis: {},
    } as unknown as FullAnalysisResult

    await writeCachedAnalysis('k', result, [])
    const cached = await readCachedAnalysis('k')

    expect(cached?.result.discovery?.tree).toEqual([])
    expect(cached?.result.discovery?.totalFiles).toBe(1)
    expect(result.discovery?.tree).toHaveLength(1)
  })

  it('treats a Redis failure as a miss', async () => {
    get.mockRejectedValueOnce(new Error('archived'))
    await expect(readCachedAnalysis('k')).resolves.toBeNull()
  })
})
