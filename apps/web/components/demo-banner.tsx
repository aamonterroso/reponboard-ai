'use client'

import { useEffect, useState } from 'react'

interface RemainingResponse {
  remaining: number
  globalRemaining: number
  ipRemaining: number
}

// Demo banner that reports today's live rate-limit headroom. Renders as a
// dim strip at the top of the page on the public demo deploy (gated by
// NEXT_PUBLIC_IS_DEMO at the page level). Mounts a single fetch to
// /api/remaining and reads it again whenever a successful analysis
// completes (signaled by the `repongboard:remaining-changed` window event).
export function DemoBanner(): React.JSX.Element {
  const [remaining, setRemaining] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void fetch('/api/remaining')
        .then((r) => r.json() as Promise<RemainingResponse>)
        .then((data) => {
          if (!cancelled) setRemaining(data.ipRemaining)
        })
        .catch(() => undefined)
    }
    load()
    const onChange = (): void => load()
    window.addEventListener('reponboard:remaining-changed', onChange)
    return () => {
      cancelled = true
      window.removeEventListener('reponboard:remaining-changed', onChange)
    }
  }, [])

  return (
    <div className="w-full bg-zinc-900/80 border-b border-zinc-800 text-center py-2 px-4">
      <p className="text-sm text-zinc-400">
        ⚡ Demo — 3 analyses/day per visitor, 30/day globally
        {remaining !== null && (
          <span className="ml-2 text-zinc-500">
            ({remaining} left for you today)
          </span>
        )}
      </p>
    </div>
  )
}
