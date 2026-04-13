'use client'

import { useState } from 'react'

function isValidGitHubUrl(url: string): boolean {
  return /^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+/.test(url.trim())
}

export function UrlInput(): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  function handleChange(e: React.ChangeEvent<HTMLInputElement>): void {
    setUrl(e.target.value)
    if (error !== null) setError(null)
  }

  async function handleAnalyze(): Promise<void> {
    const trimmed = url.trim()

    if (trimmed === '') {
      setError('Please enter a GitHub repository URL.')
      return
    }

    if (!isValidGitHubUrl(trimmed)) {
      setError('Must be a valid GitHub URL — e.g. https://github.com/owner/repo')
      return
    }

    setError(null)
    setLoading(true)
    console.log('Analyzing:', trimmed)

    await new Promise<void>((resolve) => setTimeout(resolve, 2000))

    setLoading(false)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      void handleAnalyze()
    }
  }

  return (
    <div className="w-full flex flex-col gap-3">
      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="https://github.com/owner/repo"
          disabled={loading}
          aria-label="GitHub repository URL"
          aria-invalid={error !== null}
          className="
            flex-1 h-12 px-4
            bg-zinc-900 border border-zinc-700
            text-zinc-100 placeholder-zinc-500
            rounded-lg text-base font-mono
            focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent
            disabled:opacity-50 disabled:cursor-not-allowed
            transition-colors
          "
        />
        <button
          type="button"
          onClick={() => void handleAnalyze()}
          disabled={loading}
          className="
            h-12 px-6
            bg-emerald-600 hover:bg-emerald-500
            text-white font-medium
            rounded-lg
            disabled:opacity-50 disabled:cursor-not-allowed
            focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-zinc-950
            transition-colors
            flex items-center gap-2
            shrink-0
          "
        >
          {loading ? (
            <>
              <svg
                className="animate-spin h-4 w-4 text-white"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              <span>Analyzing…</span>
            </>
          ) : (
            'Analyze'
          )}
        </button>
      </div>

      {error !== null && (
        <p role="alert" className="text-sm text-red-400 text-left">
          {error}
        </p>
      )}
    </div>
  )
}
