import { NextResponse } from 'next/server'
import { RateLimitUnavailableError, touchKeepalive } from '@/lib/rate-limit'

// Hit daily by the Vercel cron in vercel.json. Vercel sends
// `Authorization: Bearer $CRON_SECRET` on cron invocations; anything
// else is rejected so the endpoint can't be used to spend Redis quota.
export async function GET(request: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET
  if (
    secret === undefined ||
    secret === '' ||
    request.headers.get('authorization') !== `Bearer ${secret}`
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    await touchKeepalive()
  } catch (err) {
    if (!(err instanceof RateLimitUnavailableError)) throw err
    return NextResponse.json({ ok: false, error: err.message }, { status: 503 })
  }
  return NextResponse.json({ ok: true })
}
