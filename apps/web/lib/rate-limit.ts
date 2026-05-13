import { Redis } from '@upstash/redis'

// Vercel's Upstash Marketplace integration auto-injects its credentials
// under the unusual UPSTASH_REDIS_REST_KV_REST_API_* prefix — the Vercel
// envelope (UPSTASH_REDIS_REST_) wrapped around Upstash's internal
// variable names (KV_REST_API_*). It is intentional, not a typo, and
// Redis.fromEnv() does not recognize this shape. Read both manually and
// fail loud at import time if either is missing.
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN

if (UPSTASH_URL === undefined || UPSTASH_URL === '') {
  throw new Error(
    'UPSTASH_REDIS_REST_KV_REST_API_URL is not set. ' +
      'Run `vercel env pull apps/web/.env.local` from the repo root.',
  )
}
if (UPSTASH_TOKEN === undefined || UPSTASH_TOKEN === '') {
  throw new Error(
    'UPSTASH_REDIS_REST_KV_REST_API_TOKEN is not set. ' +
      'Run `vercel env pull apps/web/.env.local` from the repo root.',
  )
}

const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN })

export const ANALYZE_GLOBAL_DAILY_LIMIT = 30
export const ANALYZE_PER_IP_DAILY_LIMIT = 3
export const QA_GLOBAL_DAILY_LIMIT = 120
export const QA_PER_IP_DAILY_LIMIT = 12
export const DAILY_BUDGET_USD = parseFloat(
  process.env.DEMO_DAILY_BUDGET_USD ?? '20',
)

export type RateLimitScope = 'analyze' | 'qa'
export type RateLimitReason = 'global_limit' | 'ip_limit' | 'budget_exceeded'

export interface RateLimitResult {
  allowed: boolean
  reason?: RateLimitReason
  remainingGlobal: number
  remainingForIp: number
  budgetRemainingUsd: number
}

function todayUtc(): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function secondsUntilUtcMidnight(): number {
  const now = new Date()
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  )
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000))
}

function limitsFor(scope: RateLimitScope): { global: number; perIp: number } {
  return scope === 'analyze'
    ? { global: ANALYZE_GLOBAL_DAILY_LIMIT, perIp: ANALYZE_PER_IP_DAILY_LIMIT }
    : { global: QA_GLOBAL_DAILY_LIMIT, perIp: QA_PER_IP_DAILY_LIMIT }
}

function keysFor(
  scope: RateLimitScope,
  ip: string,
): { global: string; ip: string; budget: string } {
  const day = todayUtc()
  return {
    global: `ratelimit:${scope}:global:${day}`,
    ip: `ratelimit:${scope}:ip:${ip}:${day}`,
    budget: `ratelimit:budget:${day}`,
  }
}

function toNumber(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined) return 0
  if (typeof raw === 'number') return raw
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}

// Cost is recorded AFTER the analysis completes, not reserved up-front.
// Two concurrent runs can both observe budgetRemainingUsd > 0, start,
// and collectively push the daily total above DAILY_BUDGET_USD. The cap
// is a backstop for the public demo, not a hard pre-flight quota.
export async function checkRateLimit(
  ip: string,
  scope: RateLimitScope,
): Promise<RateLimitResult> {
  const { global: globalKey, ip: ipKey, budget: budgetKey } = keysFor(scope, ip)
  const [budgetRaw, globalRaw, ipRaw] = await redis.mget<
    Array<string | number | null>
  >(budgetKey, globalKey, ipKey)

  const budgetSpent = toNumber(budgetRaw)
  const globalUsed = toNumber(globalRaw)
  const ipUsed = toNumber(ipRaw)
  const { global: globalLimit, perIp: ipLimit } = limitsFor(scope)
  const budgetRemainingUsd = Math.max(0, DAILY_BUDGET_USD - budgetSpent)

  if (budgetSpent >= DAILY_BUDGET_USD) {
    return {
      allowed: false,
      reason: 'budget_exceeded',
      remainingGlobal: Math.max(0, globalLimit - globalUsed),
      remainingForIp: Math.max(0, ipLimit - ipUsed),
      budgetRemainingUsd,
    }
  }
  if (globalUsed >= globalLimit) {
    return {
      allowed: false,
      reason: 'global_limit',
      remainingGlobal: 0,
      remainingForIp: Math.max(0, ipLimit - ipUsed),
      budgetRemainingUsd,
    }
  }
  if (ipUsed >= ipLimit) {
    return {
      allowed: false,
      reason: 'ip_limit',
      remainingGlobal: Math.max(0, globalLimit - globalUsed),
      remainingForIp: 0,
      budgetRemainingUsd,
    }
  }

  return {
    allowed: true,
    remainingGlobal: Math.max(0, globalLimit - (globalUsed + 1)),
    remainingForIp: Math.max(0, ipLimit - (ipUsed + 1)),
    budgetRemainingUsd,
  }
}

export async function recordRequestStart(
  ip: string,
  scope: RateLimitScope,
): Promise<void> {
  const { global: globalKey, ip: ipKey } = keysFor(scope, ip)
  const ttl = secondsUntilUtcMidnight()
  // Pipeline guarantees INCR-before-EXPIRE order in a single round-trip.
  // EXPIRE ... NX leaves an existing TTL untouched, so two writers can't
  // extend each other's expiry by re-issuing the call.
  const pipeline = redis.pipeline()
  pipeline.incr(globalKey)
  pipeline.expire(globalKey, ttl, 'NX')
  pipeline.incr(ipKey)
  pipeline.expire(ipKey, ttl, 'NX')
  await pipeline.exec()
}

export async function recordAnalysisCost(costUsd: number): Promise<void> {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return
  const { budget: budgetKey } = keysFor('analyze', 'unused')
  const ttl = secondsUntilUtcMidnight()
  const pipeline = redis.pipeline()
  pipeline.incrbyfloat(budgetKey, costUsd)
  pipeline.expire(budgetKey, ttl, 'NX')
  await pipeline.exec()
}

// Peek-only counter read for the /api/remaining endpoint that powers
// the UI header. Does NOT increment.
export async function getRemainingForScope(
  ip: string,
  scope: RateLimitScope,
): Promise<{
  globalRemaining: number
  ipRemaining: number
  budgetRemainingUsd: number
}> {
  const { global: globalKey, ip: ipKey, budget: budgetKey } = keysFor(scope, ip)
  const [budgetRaw, globalRaw, ipRaw] = await redis.mget<
    Array<string | number | null>
  >(budgetKey, globalKey, ipKey)
  const { global: globalLimit, perIp: ipLimit } = limitsFor(scope)
  return {
    globalRemaining: Math.max(0, globalLimit - toNumber(globalRaw)),
    ipRemaining: Math.max(0, ipLimit - toNumber(ipRaw)),
    budgetRemainingUsd: Math.max(0, DAILY_BUDGET_USD - toNumber(budgetRaw)),
  }
}

/**
 * Test/dev-only Redis cleanup. The double-underscore prefix marks this
 * as non-public API — production code must never call it. Throws loudly
 * when NODE_ENV === 'production' so a misplaced import in a route handler
 * blows up at runtime instead of silently nuking live quotas.
 *
 * Typical usage during local smoke tests:
 *   await __resetRateLimitForTesting()                        // both globals
 *   await __resetRateLimitForTesting({ scope: 'analyze' })    // one global
 *   await __resetRateLimitForTesting({ scope: 'qa', ip: '::1' })  // scope + ip
 *   await __resetRateLimitForTesting({ includeBudget: true }) // also reset budget
 *
 * Intentionally does NOT support "delete every IP key for a scope" — that
 * would require Redis SCAN, which is O(N) over the keyspace and unsafe to
 * run from an app process. Callers who need that should clean up via the
 * Upstash console or by passing specific IPs they know about.
 */
export async function __resetRateLimitForTesting(options?: {
  scope?: RateLimitScope
  ip?: string
  includeBudget?: boolean
}): Promise<{ deleted: string[] }> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '__resetRateLimitForTesting() must not be called in production. ' +
        'It is a dev/test helper and will tear down live rate-limit state.',
    )
  }

  const day = todayUtc()
  const keys: string[] = []

  if (options?.scope !== undefined) {
    keys.push(`ratelimit:${options.scope}:global:${day}`)
    if (options.ip !== undefined) {
      keys.push(`ratelimit:${options.scope}:ip:${options.ip}:${day}`)
    }
  } else {
    keys.push(`ratelimit:analyze:global:${day}`)
    keys.push(`ratelimit:qa:global:${day}`)
  }

  if (options?.includeBudget === true) {
    keys.push(`ratelimit:budget:${day}`)
  }

  if (keys.length > 0) {
    await redis.del(...keys)
  }
  return { deleted: keys }
}
