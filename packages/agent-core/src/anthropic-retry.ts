// Retry helper for Anthropic SDK calls. Retries on 529 (overloaded),
// 503 (unavailable), and network errors. Does NOT retry on 4xx (auth,
// bad request) since those are not transient. Used at every SDK call
// site in agent-core to keep a single source of truth for retry policy.

interface RetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
}

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
  const maxAttempts = options?.maxAttempts ?? 3
  const baseDelayMs = options?.baseDelayMs ?? 1000
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt >= maxAttempts || !isRetryableError(err)) {
        throw err
      }
      const delay = baseDelayMs * Math.pow(3, attempt - 1)
      console.warn(
        `[anthropic-retry] attempt ${attempt}/${maxAttempts} failed; retrying in ${delay}ms`,
      )
      await new Promise((r) => setTimeout(r, delay))
    }
  }

  throw lastError
}
