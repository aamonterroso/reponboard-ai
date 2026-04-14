import { runDiscovery, runFullAnalysis } from '@reponboard/agent-core'
import { randomUUID } from 'crypto'
import { NextResponse } from 'next/server'

export async function POST(request: Request): Promise<NextResponse> {
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

  try {
    if (anthropicApiKey !== undefined && anthropicApiKey !== '') {
      // Full analysis: Layer 1 heuristics + Layer 2 LLM
      console.log('[analyze] Calling runFullAnalysis...')
      const result = await runFullAnalysis(repoUrl, githubToken, anthropicApiKey)
      return NextResponse.json(result)
    }

    // Fallback: heuristics only (ANTHROPIC_API_KEY not configured)
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
