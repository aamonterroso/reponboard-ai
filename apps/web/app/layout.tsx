import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Reponboard AI',
  description: 'Onboard any codebase in 5 minutes',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
