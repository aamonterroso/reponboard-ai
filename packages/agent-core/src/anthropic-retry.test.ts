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

  it('resolves on attempt 4 after 3 consecutive 529s, with strictly growing jittered delays', async () => {
    // Default policy = maxAttempts:4 / base:1000 / factor:2 / cap:8000 / jitter:true.
    // We use fake timers + spy on setTimeout to observe the scheduled
    // delays without actually waiting. We confirm:
    //   (a) the call resolves on attempt 4
    //   (b) three setTimeout calls are scheduled (one between each pair
    //       of attempts)
    //   (c) each scheduled delay falls inside the exponential+jitter
    //       envelope [base*factor^i, 2*base*factor^i], capped at 8000ms
    vi.useFakeTimers()

    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')

    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 529, message: 'overloaded' })
      .mockRejectedValueOnce({ status: 529, message: 'overloaded' })
      .mockRejectedValueOnce({ status: 529, message: 'overloaded' })
      .mockResolvedValueOnce('ok')

    const promise = withAnthropicRetry(fn) // use defaults
    // Advance through every scheduled timer so awaited setTimeouts resolve.
    await vi.runAllTimersAsync()

    const result = await promise
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(4)

    // First-arg of setTimeout calls scheduled by the retry helper.
    // (vi.runAllTimersAsync may schedule its own internals; filter to
    // numeric-delay calls in the expected envelope.)
    const scheduledDelays = setTimeoutSpy.mock.calls
      .map((c) => c[1])
      .filter((d): d is number => typeof d === 'number')

    // Expect at least 3 retry waits (attempts 1→2, 2→3, 3→4).
    expect(scheduledDelays.length).toBeGreaterThanOrEqual(3)

    // The first three retry delays should fall inside their exp+jitter
    // envelopes: [1000,2000], [2000,4000], [4000,8000].
    const [d1, d2, d3] = scheduledDelays
    expect(d1).toBeGreaterThanOrEqual(1000)
    expect(d1).toBeLessThanOrEqual(2000)
    expect(d2).toBeGreaterThanOrEqual(2000)
    expect(d2).toBeLessThanOrEqual(4000)
    expect(d3).toBeGreaterThanOrEqual(4000)
    expect(d3).toBeLessThanOrEqual(8000)

    setTimeoutSpy.mockRestore()
    vi.useRealTimers()
  })

  it('caps a single wait at capDelayMs even when exp+jitter would exceed it', async () => {
    // base=5000, factor=2, cap=3000. Even attempt 1's exp delay (5000)
    // is already above the cap, so the scheduled wait must equal cap.
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')

    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 529 })
      .mockResolvedValueOnce('ok')

    const promise = withAnthropicRetry(fn, {
      baseDelayMs: 5000,
      capDelayMs: 3000,
      maxAttempts: 2,
    })
    await vi.runAllTimersAsync()
    expect(await promise).toBe('ok')

    const scheduledDelays = setTimeoutSpy.mock.calls
      .map((c) => c[1])
      .filter((d): d is number => typeof d === 'number')
    expect(scheduledDelays[0]).toBeLessThanOrEqual(3000)

    setTimeoutSpy.mockRestore()
    vi.useRealTimers()
  })

  it('uses deterministic exponential delay when jitter=false', async () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')

    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 529 })
      .mockRejectedValueOnce({ status: 529 })
      .mockResolvedValueOnce('ok')

    const promise = withAnthropicRetry(fn, {
      baseDelayMs: 100,
      factor: 2,
      jitter: false,
      maxAttempts: 3,
    })
    await vi.runAllTimersAsync()
    expect(await promise).toBe('ok')

    const delays = setTimeoutSpy.mock.calls
      .map((c) => c[1])
      .filter((d): d is number => typeof d === 'number')
    expect(delays[0]).toBe(100)
    expect(delays[1]).toBe(200)

    setTimeoutSpy.mockRestore()
    vi.useRealTimers()
  })
})
