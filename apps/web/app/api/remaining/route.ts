export const runtime = 'edge'

import { NextResponse } from 'next/server'
import { getRemainingForScope } from '@/lib/rate-limit'

export async function GET(request: Request): Promise<NextResponse> {
  const ip =
    request.headers.get('x-real-ip')?.split(',')[0]?.trim() ??
    request.headers.get('x-forwarded-for') ??
    '127.0.0.1'

  // Demo header counter only reads the analyze scope — the UI doesn't
  // expose a separate Q&A counter today.
  const { globalRemaining, ipRemaining } = await getRemainingForScope(
    ip,
    'analyze',
  )

  return NextResponse.json({
    globalRemaining,
    ipRemaining,
    remaining: Math.min(globalRemaining, ipRemaining),
  })
}
