import { runDiscovery, runFullAnalysisStream } from '@reponboard/agent-core'
import { randomUUID } from 'crypto'
import { NextResponse } from 'next/server'

export async function POST(request: Request): Promise<NextResponse | Response> {
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

  const { repoUrl } = body as { repoUrl: string }

  if (repoUrl.trim() === '') {
    return NextResponse.json(
      { error: 'repoUrl must not be empty' },
      { status: 400 },
    )
  }

  const githubToken = process.env.GITHUB_TOKEN ?? undefined
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY
  console.log('[analyze] ANTHROPIC_API_KEY present:', !!anthropicApiKey)

  if (anthropicApiKey !== undefined && anthropicApiKey !== '') {
    // Full analysis: streaming NDJSON
    console.log('[analyze] Calling runFullAnalysisStream...')
    const llmMode = (process.env.LLM_MODE ?? 'production') as 'development' | 'production'
    const generator = runFullAnalysisStream(repoUrl, githubToken, anthropicApiKey, llmMode)
    const encoder = new TextEncoder()

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of generator) {
            controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
          }
        } finally {
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
      },
    })
  }

  // Fallback: heuristics only (ANTHROPIC_API_KEY not configured)
  try {
    const createdAt = new Date().toISOString()
    const discovery = await runDiscovery(repoUrl, githubToken)
    return NextResponse.json({
      id: randomUUID(),
      repoUrl,
      status: 'complete',
      discovery,
      llmAnalysis: null,
      error: null,
      createdAt,
      completedAt: new Date().toISOString(),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'

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
