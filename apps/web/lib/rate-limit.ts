interface RateCounter {
  count: number
  resetAt: number
}

const GLOBAL_DAILY_LIMIT = 5
const IP_DAILY_LIMIT = 3

function nextMidnightUTC(): number {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
}

function resetIfStale(counter: RateCounter): void {
  if (Date.now() >= counter.resetAt) {
    counter.count = 0
    counter.resetAt = nextMidnightUTC()
  }
}

// Module-level counters — best-effort in serverless (resets on cold start)
const globalCounter: RateCounter = { count: 0, resetAt: nextMidnightUTC() }
const ipCounters = new Map<string, RateCounter>()

export interface RateLimitResult {
  allowed: boolean
  globalRemaining: number
  ipRemaining: number
}

export function checkAndIncrementRateLimit(ip: string): RateLimitResult {
  resetIfStale(globalCounter)

  let ipCounter = ipCounters.get(ip)
  if (ipCounter === undefined) {
    ipCounter = { count: 0, resetAt: nextMidnightUTC() }
    ipCounters.set(ip, ipCounter)
  } else {
    resetIfStale(ipCounter)
  }

  const globalRemaining = Math.max(0, GLOBAL_DAILY_LIMIT - globalCounter.count)
  const ipRemaining = Math.max(0, IP_DAILY_LIMIT - ipCounter.count)

  if (globalCounter.count >= GLOBAL_DAILY_LIMIT || ipCounter.count >= IP_DAILY_LIMIT) {
    return { allowed: false, globalRemaining, ipRemaining }
  }

  globalCounter.count++
  ipCounter.count++

  return {
    allowed: true,
    globalRemaining: Math.max(0, GLOBAL_DAILY_LIMIT - globalCounter.count),
    ipRemaining: Math.max(0, IP_DAILY_LIMIT - ipCounter.count),
  }
}

export function getRemainingCount(ip: string): { globalRemaining: number; ipRemaining: number } {
  resetIfStale(globalCounter)

  const ipCounter = ipCounters.get(ip)
  if (ipCounter === undefined) {
    return { globalRemaining: GLOBAL_DAILY_LIMIT, ipRemaining: IP_DAILY_LIMIT }
  }
  resetIfStale(ipCounter)

  return {
    globalRemaining: Math.max(0, GLOBAL_DAILY_LIMIT - globalCounter.count),
    ipRemaining: Math.max(0, IP_DAILY_LIMIT - ipCounter.count),
  }
}
