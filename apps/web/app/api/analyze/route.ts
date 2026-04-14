import { runDiscovery } from '@reponboard/agent-core'
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

  try {
    const result = await runDiscovery(
      repoUrl,
      process.env.GITHUB_TOKEN ?? undefined,
    )
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'

    // Treat URL parse errors as bad input
    if (
      message.includes('Invalid GitHub URL') ||
      message.includes('parse') ||
      message.includes('URL')
    ) {
      return NextResponse.json({ error: message }, { status: 400 })
    }

    return NextResponse.json({ error: message }, { status: 500 })
  }
}
