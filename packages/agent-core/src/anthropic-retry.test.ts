import { describe, it, expect, vi } from 'vitest'
import { withAnthropicRetry } from './anthropic-retry'

describe('withAnthropicRetry', () => {
  it('returns the value on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withAnthropicRetry(fn)
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on 529 overloaded and succeeds on second attempt', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 529, message: 'overloaded' })
      .mockResolvedValueOnce('recovered')
    const result = await withAnthropicRetry(fn, { baseDelayMs: 1 })
    expect(result).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('retries on 503 service unavailable', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValueOnce('ok')
    const result = await withAnthropicRetry(fn, { baseDelayMs: 1 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('retries on network errors (ECONNRESET)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ code: 'ECONNRESET' })
      .mockResolvedValueOnce('ok')
    const result = await withAnthropicRetry(fn, { baseDelayMs: 1 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry on 400 bad request', async () => {
    const fn = vi.fn().mockRejectedValueOnce({ status: 400, message: 'bad' })
    await expect(
      withAnthropicRetry(fn, { baseDelayMs: 1 }),
    ).rejects.toMatchObject({ status: 400 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry on 401 auth error', async () => {
    const fn = vi.fn().mockRejectedValueOnce({ status: 401 })
    await expect(
      withAnthropicRetry(fn, { baseDelayMs: 1 }),
    ).rejects.toMatchObject({ status: 401 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('throws after exhausting maxAttempts', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 529, message: 'overloaded' })
    await expect(
      withAnthropicRetry(fn, { maxAttempts: 3, baseDelayMs: 1 }),
    ).rejects.toMatchObject({ status: 529 })
    expect(fn).toHaveBeenCalledTimes(3)
  })
})
