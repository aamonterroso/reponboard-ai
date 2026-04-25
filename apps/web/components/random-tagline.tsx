'use client'

import { useMemo } from 'react'

const TAGLINES = [
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
  // Pick once per mount. SSR renders index 0; client may pick differently —
  // suppressHydrationWarning silences the mismatch on this single element.
  const tagline = useMemo(
    () => TAGLINES[Math.floor(Math.random() * TAGLINES.length)] ?? TAGLINES[0],
    [],
  )

  return (
    <span suppressHydrationWarning className="text-zinc-500 italic">
      {tagline}
    </span>
  )
}
