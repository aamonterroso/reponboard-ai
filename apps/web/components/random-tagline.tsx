'use client'

import { useEffect, useState } from 'react'

const taglines = [
  'Built for devs who hate reading READMEs',
  'Because nobody reads the onboarding doc',
  'Your senior dev, minus the condescension',
  'git clone && pray is not a strategy',
  'The tour you never got on day one',
  'Stack detected. Existential dread: optional',
  "No more 'just ask someone who knows the codebase'",
  'LGTM-driven development stops here',
] as const

export function RandomTagline(): React.JSX.Element {
  // Render the first tagline during SSR + initial hydration to avoid
  // hydration mismatch, then pick a random one client-side after mount.
  const [tagline, setTagline] = useState<string>(taglines[0])

  useEffect(() => {
    setTagline(taglines[Math.floor(Math.random() * taglines.length)] ?? taglines[0])
  }, [])

  return <span className="text-zinc-500 italic">{tagline}</span>
}
