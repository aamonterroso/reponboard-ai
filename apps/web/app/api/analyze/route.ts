export const runtime = 'edge'

import { runDiscovery, runFullAnalysisStream } from '@reponboard/agent-core'
import type { LLMModelIntent } from '@reponboard/agent-core'
import { NextResponse } from 'next/server'
import { checkRateLimit, incrementRateLimit } from '@/lib/rate-limit'

const GITHUB_URL_REGEX = /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+(\/)?$/
// Code-level cap on the analysis. Verified empirically that
// Vercel Edge on the Hobby plan supports up to ~300s when the
// response is streamed (test endpoint /timeout-test ran 89.91s
// to completion). 120s gives Sonnet enough headroom for large
// repos while still bounding worst-case behavior.
const TIMEOUT_MS = 120_000

function getClientIp(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    '127.0.0.1'
  )
}

function sanitizeGitHubUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl)
  const cleanPath = parsed.pathname.replace(/\/+$/, '')
  return `https://github.com${cleanPath}`
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

  // Rate limit CHECK only — increment happens after a successful 'complete'
  // event so failed/timed-out analyses don't consume the user's daily quota.
  const ip = getClientIp(request)
  const rateLimit = checkRateLimit(ip)
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Demo limit reached for today. Check back tomorrow.' },
      { status: 429 },
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

  if (anthropicApiKey !== undefined && anthropicApiKey !== '') {
    const rawIntent = process.env.LLM_MODEL_INTENT
    const rawMode = process.env.LLM_MODE
    let intent: LLMModelIntent | undefined
    let llmMode: 'development' | 'production' = 'production'

    if (rawIntent === 'fast' || rawIntent === 'quality' || rawIntent === 'parity') {
      intent = rawIntent
    } else if (rawMode === 'development' || rawMode === 'production') {
      console.warn(
        '[env] LLM_MODE is deprecated. Set LLM_MODEL_INTENT to ' +
          '"fast" | "quality" | "parity" instead.',
      )
      llmMode = rawMode
    }

    const generator = runFullAnalysisStream(
      repoUrl,
      githubToken,
      anthropicApiKey,
      llmMode,
      intent,
    )
    const encoder = new TextEncoder()

    const stream = new ReadableStream({
      async start(controller) {
        let closed = false

        const closeStream = (errorMsg?: string): void => {
          if (closed) return
          closed = true
          if (errorMsg !== undefined) {
            try {
              controller.enqueue(
                encoder.encode(JSON.stringify({ phase: 'error', error: errorMsg }) + '\n'),
              )
            } catch { /* ignore */ }
          }
          try { controller.close() } catch { /* ignore */ }
        }

        const timeout = setTimeout(
          () => {
            console.log(`[timing] timeout reached at ${Date.now() - reqStart}ms`)
            closeStream(
              'Analysis timed out. The repository may be too large — please try a smaller repo.',
            )
          },
          TIMEOUT_MS,
        )

        try {
          for await (const event of generator) {
            if (closed) break
            // Charge the user's daily quota only when the analysis actually
            // produces a result. Errors and the timeout path skip this.
            if (event.phase === 'complete') {
              incrementRateLimit(ip)
            }
            if (event.phase === 'complete' || event.phase === 'error') {
              console.log(`[timing] route done at ${Date.now() - reqStart}ms`)
            }
            controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
          }
        } catch (err) {
          console.log(`[timing] route done at ${Date.now() - reqStart}ms`)
          closeStream(err instanceof Error ? err.message : 'Stream error')
        } finally {
          clearTimeout(timeout)
          closeStream()
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        'X-RateLimit-Remaining': String(rateLimit.globalRemaining),
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
