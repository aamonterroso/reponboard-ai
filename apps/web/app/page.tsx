import { UrlInput } from '@/components/url-input'

export default function HomePage(): React.JSX.Element {
  return (
    <div className="min-h-screen bg-zinc-950 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(16,185,129,0.06),transparent)] text-zinc-100 flex flex-col">
      <main className="flex-1 flex flex-col items-center justify-center px-4 pt-8">
        <div className="w-full max-w-3xl flex flex-col items-center gap-6 text-center">
          <div className="flex flex-col items-center gap-3">
            <span className="text-5xl" aria-hidden="true">🧭</span>
            <h1 className="text-4xl font-bold tracking-tight bg-gradient-to-b from-zinc-50 to-zinc-300 bg-clip-text text-transparent">
              reponboard-ai
            </h1>
            <p className="text-base text-zinc-500">
              Onboard any codebase in 5 minutes
            </p>
          </div>

          <UrlInput />
        </div>
      </main>

      <footer className="py-4 text-center text-sm text-zinc-600">
        Built for devs who hate onboarding docs
      </footer>
    </div>
  )
}
