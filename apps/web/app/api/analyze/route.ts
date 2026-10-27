export const maxDuration = 300

import {
  GitHubClient,
  parseGitHubUrl,
  runDiscovery,
  runFullAnalysisStream,
} from '@reponboard/agent-core'
import type { LLMMode, LLMModelIntent } from '@reponboard/agent-core'
import { NextResponse } from 'next/server'
import {
  checkRateLimit,
  RATE_LIMITER_UNAVAILABLE_MESSAGE,
  RateLimitUnavailableError,
  recordAnalysisCost,
  recordRequestStart,
} from '@/lib/rate-limit'
import type { RateLimitResult } from '@/lib/rate-limit'
import {
  analysisCacheKey,
  readCachedAnalysis,
  writeCachedAnalysis,
} from '@/lib/analysis-cache'
import type { CachedAnalysis, CachedTraceEvent } from '@/lib/analysis-cache'
import { createSseWriter, SSE_HEADERS } from '@/lib/sse'
import type { SseWriter } from '@/lib/sse'

const GITHUB_URL_REGEX = /^https?:\/\/github\.com\/[\w][\w.-]*\/[\w][\w.-]*\/?$/i
// Code-level cap on the analysis, well under the 300s maxDuration of
// the Node.js (Fluid Compute) function. 120s gives Sonnet enough
// headroom for large repos while still bounding worst-case behavior.
const TIMEOUT_MS = 120_000

function getClientIp(request: Request): string {
  return (
    request.headers.get('x-real-ip')?.split(',')[0]?.trim() ??
    request.headers.get('x-forwarded-for') ??
    '127.0.0.1'
  )
}

function sanitizeGitHubUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl)
  const cleanPath = parsed.pathname.replace(/\/+$/, '')
  return `https://github.com${cleanPath}`
}

function resolveIntent(): {
  intent: LLMModelIntent | undefined
  llmMode: LLMMode
  resolvedIntent: LLMModelIntent
} {
  const rawIntent = process.env.LLM_MODEL_INTENT
  const rawMode = process.env.LLM_MODE
  let intent: LLMModelIntent | undefined
  let llmMode: LLMMode = 'production'

  if (rawIntent === 'fast' || rawIntent === 'quality') {
    intent = rawIntent
  } else if (rawMode === 'development' || rawMode === 'production') {
    console.warn(
      '[env] LLM_MODE is deprecated. Set LLM_MODEL_INTENT to ' +
        '"fast" | "quality" instead.',
    )
    llmMode = rawMode
  }
  // Mirrors the resolution inside agent-core so the cache key names the
  // model tier that will actually run.
  const resolvedIntent = intent ?? (llmMode === 'development' ? 'fast' : 'quality')
  return { intent, llmMode, resolvedIntent }
}

// Null when the HEAD SHA can't be read (rate-limited GitHub, missing
// repo): the request then runs uncached and the real error, if any,
// surfaces from discovery.
async function resolveCacheKey(
  repoUrl: string,
  githubToken: string | undefined,
  intent: LLMModelIntent,
): Promise<string | null> {
  try {
    const { owner, repo, branch } = parseGitHubUrl(repoUrl)
    const sha = await new GitHubClient(githubToken).getHeadSha(
      owner,
      repo,
      branch ?? undefined,
    )
    return analysisCacheKey({ owner, repo, sha, intent })
  } catch (err) {
    console.warn('[analysis-cache] could not resolve HEAD sha', err)
    return null
  }
}

function replayCachedAnalysis(cached: CachedAnalysis): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sse = createSseWriter(controller)
      sse.send({ phase: 'cache_hit', cachedAt: cached.cachedAt })
      for (const event of cached.trace) sse.send(event)
      sse.send({ phase: 'complete', result: cached.result })
      sse.close()
    },
  })
  return new Response(stream, {
    headers: { ...SSE_HEADERS, 'X-Analysis-Cache': 'HIT' },
  })
}

export async function POST(request: Request): Promise<NextResponse | Response> {
  const reqStart = Date.now()
  console.log(`[timing] request received`)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    !('repoUrl' in body) ||
    typeof (body as Record<string, unknown>).repoUrl !== 'string'
  ) {
    return NextResponse.json(
      { error: 'repoUrl is required and must be a string' },
      { status: 400 },
    )
  }

  const rawUrl = (body as { repoUrl: string }).repoUrl.trim()

  if (rawUrl === '') {
    return NextResponse.json({ error: 'repoUrl must not be empty' }, { status: 400 })
  }

  if (!GITHUB_URL_REGEX.test(rawUrl)) {
    return NextResponse.json(
      {
        error:
          'Please enter a valid GitHub repository URL — e.g. https://github.com/owner/repo',
      },
      { status: 400 },
    )
  }

  let repoUrl: string
  try {
    repoUrl = sanitizeGitHubUrl(rawUrl)
  } catch {
    return NextResponse.json(
      {
        error:
          'Please enter a valid GitHub repository URL — e.g. https://github.com/owner/repo',
      },
      { status: 400 },
    )
  }

  const githubToken = process.env.GITHUB_TOKEN ?? undefined
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY
  const hasLlm = anthropicApiKey !== undefined && anthropicApiKey !== ''
  const { intent, llmMode, resolvedIntent } = resolveIntent()

  // Rate limit: check up-front against the shared Redis state. Fail
  // closed when Redis is unreachable: the daily budget cap lives there, so
  // serving without it would leave LLM spend uncapped.
  const ip = getClientIp(request)
  let rateLimit: RateLimitResult
  try {
    rateLimit = await checkRateLimit(ip, 'analyze')
  } catch (err) {
    if (!(err instanceof RateLimitUnavailableError)) throw err
    return NextResponse.json(
      { error: RATE_LIMITER_UNAVAILABLE_MESSAGE, reason: 'rate_limiter_unavailable' },
      { status: 503 },
    )
  }
  if (!rateLimit.allowed) {
    const message =
      rateLimit.reason === 'budget_exceeded'
        ? 'Demo budget exhausted for today. Try again tomorrow or run locally with your own API key.'
        : rateLimit.reason === 'global_limit'
          ? 'Demo daily limit reached. Try again tomorrow or run locally.'
          : "You've used your daily allowance. Try again tomorrow or run locally."
    return NextResponse.json(
      { error: message, reason: rateLimit.reason },
      { status: 429 },
    )
  }

  // Cache lookup sits behind the rate-limit check (the HEAD SHA lookup
  // spends shared GitHub quota) but before the slot is recorded: a hit
  // costs no LLM spend, so it doesn't consume the visitor's allowance.
  let cacheKey: string | null = null
  if (hasLlm) {
    cacheKey = await resolveCacheKey(repoUrl, githubToken, resolvedIntent)
    const cached = cacheKey !== null ? await readCachedAnalysis(cacheKey) : null
    if (cached !== null) {
      console.log(`[analysis-cache] HIT ${cacheKey}`)
      return replayCachedAnalysis(cached)
    }
  }

  // Reserve the slot before the analysis runs so it counts even if the
  // stream is aborted. Cost is added to the budget key only after a
  // successful 'complete' event.
  try {
    await recordRequestStart(ip, 'analyze')
  } catch (err) {
    if (!(err instanceof RateLimitUnavailableError)) throw err
    return NextResponse.json(
      { error: RATE_LIMITER_UNAVAILABLE_MESSAGE, reason: 'rate_limiter_unavailable' },
      { status: 503 },
    )
  }

  if (hasLlm) {
    const generator = runFullAnalysisStream(
      repoUrl,
      githubToken,
      anthropicApiKey,
      llmMode,
      intent,
    )

    // Hoisted so cancel() can reach it: when the client disconnects, the
    // writer closes and the loop below stops pulling from the agent after
    // the in-flight step, instead of paying for the rest of the run.
    let sse: SseWriter | null = null
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        console.log(`[timing] client disconnected at ${Date.now() - reqStart}ms`)
        sse?.close()
      },
      async start(controller) {
        const writer = createSseWriter(controller)
        sse = writer
        // Trace events are kept so a successful run can be cached and
        // replayed into the AI Lab on a later hit.
        const trace: CachedTraceEvent[] = []

        const timeout = setTimeout(
          () => {
            console.log(`[timing] timeout reached at ${Date.now() - reqStart}ms`)
            writer.send({
              phase: 'error',
              error:
                'Analysis timed out. The repository may be too large — please try a smaller repo.',
            })
            writer.close()
          },
          TIMEOUT_MS,
        )

        try {
          for await (const event of generator) {
            if (writer.closed) break
            if (
              event.phase === 'llm_call' ||
              event.phase === 'tool_end' ||
              event.phase === 'thinking'
            ) {
              trace.push(event)
            }
            if (event.phase === 'complete') {
              // Charge the shared budget cap only on successful completion.
              // Errors and the timeout path skip this so they don't dilute
              // the cost-per-success accounting on the budget key.
              const coreCost = event.result.meta?.core?.costUsd ?? 0
              const guideCost = event.result.meta?.guide?.costUsd ?? 0
              const costUsd = coreCost + guideCost
              if (costUsd > 0) {
                void recordAnalysisCost(costUsd).catch((err) => {
                  console.warn('[rate-limit] recordAnalysisCost failed', err)
                })
              }
              if (
                cacheKey !== null &&
                event.result.llmAnalysis !== null &&
                event.result.error === null
              ) {
                void writeCachedAnalysis(cacheKey, event.result, trace)
              }
            }
            if (event.phase === 'complete' || event.phase === 'error') {
              console.log(`[timing] route done at ${Date.now() - reqStart}ms`)
            }
            writer.send(event)
          }
        } catch (err) {
          console.log(`[timing] route done at ${Date.now() - reqStart}ms`)
          writer.send({
            phase: 'error',
            error: err instanceof Error ? err.message : 'Stream error',
          })
        } finally {
          clearTimeout(timeout)
          writer.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        ...SSE_HEADERS,
        'X-Analysis-Cache': cacheKey !== null ? 'MISS' : 'BYPASS',
        'X-RateLimit-Remaining': String(rateLimit.remainingForIp),
      },
    })
  }

  // Fallback: heuristics only (no ANTHROPIC_API_KEY)
  try {
    const analysisPromise = (async (): Promise<NextResponse> => {
      const createdAt = new Date().toISOString()
      const discovery = await runDiscovery(repoUrl, githubToken)
      return NextResponse.json({
        id: crypto.randomUUID(),
        repoUrl,
        status: 'complete',
        discovery,
        llmAnalysis: null,
        error: null,
        createdAt,
        completedAt: new Date().toISOString(),
      })
    })()

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('TIMED_OUT')), TIMEOUT_MS),
    )

    return await Promise.race([analysisPromise, timeoutPromise])
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'

    if (message === 'TIMED_OUT') {
      return NextResponse.json(
        {
          error:
            'Analysis timed out. The repository may be too large — please try a smaller repo.',
        },
        { status: 504 },
      )
    }

    if (
      message.includes('Invalid GitHub URL') ||
      message.includes('Not a valid GitHub') ||
      message.includes('INVALID_URL')
    ) {
      return NextResponse.json({ error: message }, { status: 400 })
    }

    if (message.includes('NOT_FOUND') || message.includes('not found')) {
      return NextResponse.json({ error: message }, { status: 404 })
    }

    if (message.includes('RATE_LIMITED') || message.includes('rate limit')) {
      return NextResponse.json({ error: message }, { status: 429 })
    }

    return NextResponse.json({ error: message }, { status: 500 })
  }
}
