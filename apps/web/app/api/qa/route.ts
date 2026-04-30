export const runtime = 'edge'

import { NextResponse } from 'next/server'
import {
  GitHubClient,
  answerQuestion,
  parseGitHubUrl,
  type LLMModelIntent,
  type QAMessage,
} from '@reponboard/agent-core'
import { checkRateLimit, incrementRateLimit } from '@/lib/rate-limit'

const GITHUB_URL_REGEX = /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+(\/)?$/
// Code-level cap on the analysis. Verified empirically that
// Vercel Edge on the Hobby plan supports up to ~300s when the
// response is streamed (test endpoint /timeout-test ran 89.91s
// to completion). 120s gives Sonnet enough headroom for large
// repos while still bounding worst-case behavior.
const TIMEOUT_MS = 120_000
const MAX_QUESTION_LEN = 500
const MAX_HISTORY_ITEMS = 20

function getClientIp(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    '127.0.0.1'
  )
}

interface QARequestBody {
  question: string
  repoUrl: string
  codebaseContext: string
  history: QAMessage[]
}

function parseBody(body: unknown): QARequestBody | string {
  if (typeof body !== 'object' || body === null) return 'Body must be an object'
  const b = body as Record<string, unknown>

  if (typeof b.question !== 'string' || b.question.trim() === '') {
    return 'question is required and must be a non-empty string'
  }
  if (b.question.length > MAX_QUESTION_LEN) {
    return `question must be ${MAX_QUESTION_LEN} characters or fewer`
  }
  if (typeof b.repoUrl !== 'string' || b.repoUrl.trim() === '') {
    return 'repoUrl is required and must be a non-empty string'
  }
  if (typeof b.codebaseContext !== 'string') {
    return 'codebaseContext is required and must be a string'
  }
  if (!Array.isArray(b.history)) {
    return 'history must be an array'
  }

  const history: QAMessage[] = []
  for (const item of b.history.slice(-MAX_HISTORY_ITEMS)) {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('role' in item) ||
      !('content' in item)
    ) {
      return 'history items must have role and content'
    }
    const it = item as Record<string, unknown>
    if (it.role !== 'user' && it.role !== 'assistant') {
      return 'history role must be "user" or "assistant"'
    }
    if (typeof it.content !== 'string') {
      return 'history content must be a string'
    }
    history.push({
      role: it.role,
      content: it.content,
      filesReferenced: Array.isArray(it.filesReferenced)
        ? it.filesReferenced.filter((f): f is string => typeof f === 'string')
        : [],
      timestamp: typeof it.timestamp === 'string' ? it.timestamp : '',
    })
  }

  return {
    question: b.question.trim(),
    repoUrl: b.repoUrl.trim(),
    codebaseContext: b.codebaseContext,
    history,
  }
}

export async function POST(request: Request): Promise<NextResponse | Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = parseBody(body)
  if (typeof parsed === 'string') {
    return NextResponse.json({ error: parsed }, { status: 400 })
  }

  if (!GITHUB_URL_REGEX.test(parsed.repoUrl)) {
    return NextResponse.json(
      {
        error:
          'Please provide a valid GitHub repository URL — e.g. https://github.com/owner/repo',
      },
      { status: 400 },
    )
  }

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY
  if (anthropicApiKey === undefined || anthropicApiKey === '') {
    return NextResponse.json(
      { error: 'Q&A is not available (ANTHROPIC_API_KEY not configured).' },
      { status: 503 },
    )
  }

  // Rate limit CHECK only — increment happens after the Q&A successfully
  // emits a 'complete' event so failed/timed-out questions don't consume
  // the user's daily quota. Shared daily counter with /api/analyze.
  const ip = getClientIp(request)
  const rateLimit = checkRateLimit(ip)
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Demo limit reached for today. Check back tomorrow.' },
      { status: 429 },
    )
  }

  let owner: string
  let repo: string
  let branch: string | null
  try {
    const parsedUrl = parseGitHubUrl(parsed.repoUrl)
    owner = parsedUrl.owner
    repo = parsedUrl.repo
    branch = parsedUrl.branch
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid repo URL' },
      { status: 400 },
    )
  }

  // Resolve default branch if none specified
  const githubToken = process.env.GITHUB_TOKEN ?? undefined
  let resolvedBranch = branch
  if (resolvedBranch === null) {
    try {
      const github = new GitHubClient(githubToken)
      const info = await github.getRepoInfo(owner, repo)
      resolvedBranch = info.defaultBranch
    } catch (err) {
      return NextResponse.json(
        {
          error:
            err instanceof Error
              ? err.message
              : 'Failed to resolve default branch',
        },
        { status: 502 },
      )
    }
  }

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

  const generator = answerQuestion(
    parsed.question,
    { owner, repo, branch: resolvedBranch },
    parsed.codebaseContext,
    parsed.history,
    anthropicApiKey,
    githubToken,
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
              encoder.encode(
                JSON.stringify({ phase: 'error', error: errorMsg }) + '\n',
              ),
            )
          } catch {
            /* ignore */
          }
        }
        try {
          controller.close()
        } catch {
          /* ignore */
        }
      }

      const timeout = setTimeout(
        () =>
          closeStream(
            'Q&A timed out. Try rephrasing or asking a more specific question.',
          ),
        TIMEOUT_MS,
      )

      try {
        for await (const event of generator) {
          if (closed) break
          // Charge the daily quota only when the Q&A actually produces a
          // result. Errors and the timeout path skip this.
          if (event.phase === 'complete') {
            incrementRateLimit(ip)
          }
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
        }
      } catch (err) {
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
