import { UrlInput } from '@/components/url-input'

export default function HomePage(): React.JSX.Element {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <main className="flex-1 flex flex-col items-center justify-center px-4">
        <div className="w-full max-w-2xl flex flex-col items-center gap-6 text-center">
          <div className="flex flex-col items-center gap-3">
            <span className="text-5xl" aria-hidden="true">🧭</span>
            <h1 className="text-4xl font-bold tracking-tight text-zinc-50">
              reponboard-ai
            </h1>
            <p className="text-lg text-zinc-400">
              Reponboard any codebase in 5 minutes
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
