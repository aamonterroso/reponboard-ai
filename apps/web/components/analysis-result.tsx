'use client'

import type { DiscoveryResult } from '@reponboard/agent-core'

interface AnalysisResultProps {
  result: DiscoveryResult
  onReset: () => void
}

const importanceStyles: Record<string, string> = {
  critical: 'text-red-400 bg-red-950 border-red-800',
  high: 'text-orange-400 bg-orange-950 border-orange-800',
  medium: 'text-yellow-400 bg-yellow-950 border-yellow-800',
  low: 'text-zinc-400 bg-zinc-800 border-zinc-700',
}

function Badge({ label, variant }: { label: string; variant: 'blue' | 'violet' | 'emerald' | 'zinc' }): React.JSX.Element {
  const styles = {
    blue: 'bg-blue-950 text-blue-300 border-blue-800',
    violet: 'bg-violet-950 text-violet-300 border-violet-800',
    emerald: 'bg-emerald-950 text-emerald-300 border-emerald-800',
    zinc: 'bg-zinc-800 text-zinc-300 border-zinc-700',
  }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono border ${styles[variant]}`}>
      {label}
    </span>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">{title}</h2>
      {children}
    </div>
  )
}

export function AnalysisResult({ result, onReset }: AnalysisResultProps): React.JSX.Element {
  const { repoInfo, stack, keyFiles, entryPoints, totalFiles, totalDirectories } = result

  return (
    <div className="w-full flex flex-col gap-6">

      {/* Repository */}
      <Section title="Repository">
        <div className="p-4 bg-zinc-900 border border-zinc-700 rounded-xl flex flex-col gap-2">
          <div className="flex items-start justify-between gap-4">
            <h3 className="text-base font-semibold text-zinc-100 font-mono">{repoInfo.fullName}</h3>
            <div className="flex items-center gap-1.5 shrink-0 text-sm text-zinc-400">
              <svg className="h-4 w-4 text-yellow-400" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
              {repoInfo.stars.toLocaleString()}
            </div>
          </div>
          {repoInfo.description !== null && (
            <p className="text-sm text-zinc-400">{repoInfo.description}</p>
          )}
          <div className="flex flex-wrap gap-2 mt-1">
            {repoInfo.language !== null && (
              <Badge label={repoInfo.language} variant="zinc" />
            )}
            {repoInfo.topics.slice(0, 6).map((topic) => (
              <Badge key={topic} label={topic} variant="zinc" />
            ))}
          </div>
        </div>
      </Section>

      {/* Stack */}
      <Section title="Stack">
        <div className="p-4 bg-zinc-900 border border-zinc-700 rounded-xl grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Runtime</span>
            <Badge label={stack.runtime} variant="blue" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Framework</span>
            <Badge label={stack.framework} variant="violet" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Category</span>
            <Badge label={stack.category} variant="emerald" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Language</span>
            <Badge label={stack.language} variant="zinc" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Package Manager</span>
            <Badge label={stack.packageManager} variant="zinc" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Confidence</span>
            <span className="text-sm font-mono text-zinc-200">{Math.round(stack.confidence * 100)}%</span>
          </div>
        </div>
      </Section>

      {/* Key Files */}
      <Section title="Key Files">
        <div className="flex flex-col divide-y divide-zinc-800 bg-zinc-900 border border-zinc-700 rounded-xl overflow-hidden">
          {keyFiles.length === 0 ? (
            <p className="p-4 text-sm text-zinc-500">No key files identified.</p>
          ) : (
            keyFiles.map((file) => (
              <div key={file.path} className="flex items-start gap-3 px-4 py-3">
                <span
                  className={`mt-0.5 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-mono border shrink-0 ${importanceStyles[file.importance] ?? importanceStyles.low}`}
                >
                  {file.importance}
                </span>
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm font-mono text-zinc-100 truncate">{file.path}</span>
                  <span className="text-xs text-zinc-500">{file.role} — {file.reason}</span>
                </div>
              </div>
            ))
          )}
        </div>
        {keyFiles.length >= 12 && (
          <p className="text-xs text-zinc-600 mt-2 text-right">Showing top 12 key files</p>
        )}
      </Section>

      {/* Entry Points */}
      <Section title="Entry Points">
        <div className="flex flex-col divide-y divide-zinc-800 bg-zinc-900 border border-zinc-700 rounded-xl overflow-hidden">
          {entryPoints.length === 0 ? (
            <p className="p-4 text-sm text-zinc-500">No entry points detected.</p>
          ) : (
            entryPoints.map((ep) => (
              <div key={ep.path} className="flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-mono border bg-blue-950 text-blue-300 border-blue-800 shrink-0">
                  {ep.kind}
                </span>
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm font-mono text-zinc-100 truncate">{ep.path}</span>
                  <span className="text-xs text-zinc-500">{ep.reason}</span>
                </div>
                <span className="ml-auto text-xs text-zinc-600 shrink-0">p{ep.priority}</span>
              </div>
            ))
          )}
        </div>
      </Section>

      {/* Stats */}
      <Section title="Stats">
        <div className="p-4 bg-zinc-900 border border-zinc-700 rounded-xl grid grid-cols-3 gap-4 text-center">
          <div className="flex flex-col gap-1">
            <span className="text-2xl font-bold text-zinc-100">{totalFiles.toLocaleString()}</span>
            <span className="text-xs text-zinc-500">Files</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-2xl font-bold text-zinc-100">{totalDirectories.toLocaleString()}</span>
            <span className="text-xs text-zinc-500">Directories</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-2xl font-bold text-zinc-100">{Math.round(stack.confidence * 100)}%</span>
            <span className="text-xs text-zinc-500">Stack confidence</span>
          </div>
        </div>
      </Section>

      {/* Reset */}
      <button
        type="button"
        onClick={onReset}
        className="
          self-start h-10 px-5
          bg-zinc-800 hover:bg-zinc-700
          text-zinc-100 text-sm font-medium
          rounded-lg border border-zinc-700
          focus:outline-none focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 focus:ring-offset-zinc-950
          transition-colors
        "
      >
        Analyze another repo
      </button>
    </div>
  )
}
