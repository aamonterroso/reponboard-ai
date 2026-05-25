// Retry helper for Anthropic SDK calls. Retries on 529 (overloaded),
// 503 (unavailable), and network errors. Does NOT retry on 4xx (auth,
// bad request) since those are not transient. Used at every SDK call
// site in agent-core to keep a single source of truth for retry policy.
//
// Backoff: exponential with full jitter. wait = exp + uniform(0, exp),
// capped at capDelayMs. With defaults (base=1000, factor=2, cap=8000),
// waits are sampled from [1s,2s], [2s,4s], [4s,8s] across attempts.

interface RetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  factor?: number
  capDelayMs?: number
  jitter?: boolean
}

const DEFAULT_MAX_ATTEMPTS = 4
const DEFAULT_BASE_DELAY_MS = 1000
const DEFAULT_FACTOR = 2
const DEFAULT_CAP_DELAY_MS = 8000
const DEFAULT_JITTER = true

function isRetryableError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { status?: unknown; code?: unknown; message?: unknown }

  if (typeof e.status === 'number') {
    if (e.status === 529 || e.status === 503) return true
    if (e.status >= 400 && e.status < 500) return false
  }

  if (typeof e.code === 'string') {
    if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'ECONNREFUSED') {
      return true
    }
  }

  if (typeof e.message === 'string') {
    const msg = e.message.toLowerCase()
    if (
      msg.includes('overloaded') ||
      msg.includes('fetch failed') ||
      msg.includes('network')
    ) {
      return true
    }
  }

  return false
}

export async function withAnthropicRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const factor = options?.factor ?? DEFAULT_FACTOR
  const capDelayMs = options?.capDelayMs ?? DEFAULT_CAP_DELAY_MS
  const useJitter = options?.jitter ?? DEFAULT_JITTER
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt >= maxAttempts || !isRetryableError(err)) {
        throw err
      }
      const exp = baseDelayMs * Math.pow(factor, attempt - 1)
      const jitter = useJitter ? Math.random() * exp : 0
      const delay = Math.min(exp + jitter, capDelayMs)
      console.warn(
        `[anthropic-retry] attempt ${attempt}/${maxAttempts} failed; retrying in ${Math.round(delay)}ms`,
      )
      await new Promise((r) => setTimeout(r, delay))
    }
  }

  throw lastError
}
