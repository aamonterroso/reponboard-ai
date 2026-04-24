import { NextResponse } from 'next/server'
import { getRemainingCount } from '@/lib/rate-limit'

export async function GET(request: Request): Promise<NextResponse> {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    '127.0.0.1'

  const { globalRemaining, ipRemaining } = getRemainingCount(ip)

  return NextResponse.json({
    globalRemaining,
    ipRemaining,
    remaining: Math.min(globalRemaining, ipRemaining),
  })
}
