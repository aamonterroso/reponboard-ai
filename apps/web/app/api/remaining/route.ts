import { NextResponse } from 'next/server'
import {
  getRemainingForScope,
  RateLimitUnavailableError,
} from '@/lib/rate-limit'

export async function GET(request: Request): Promise<NextResponse> {
  const ip =
    request.headers.get('x-real-ip')?.split(',')[0]?.trim() ??
    request.headers.get('x-forwarded-for') ??
    '127.0.0.1'

  // Demo header counter only reads the analyze scope — the UI doesn't
  // expose a separate Q&A counter today.
  let counters: Awaited<ReturnType<typeof getRemainingForScope>>
  try {
    counters = await getRemainingForScope(ip, 'analyze')
  } catch (err) {
    if (!(err instanceof RateLimitUnavailableError)) throw err
    // The header counter is cosmetic; nulls hide it in the UI rather
    // than breaking page load.
    return NextResponse.json({
      globalRemaining: null,
      ipRemaining: null,
      remaining: null,
    })
  }
  const { globalRemaining, ipRemaining } = counters

  return NextResponse.json({
    globalRemaining,
    ipRemaining,
    remaining: Math.min(globalRemaining, ipRemaining),
  })
}
