'use client'

import { useState } from 'react'
import type {
  FullAnalysisResult,
  LLMAnalysisResult,
  DiscoveryResult,
  RepoType,
  RepoTypeResult,
} from '@reponboard/agent-core'

interface AnalysisResultProps {
  result: FullAnalysisResult
  onReset: () => void
}

// ─── Shared primitives ────────────────────────────────────────────────────────

const importanceStyles: Record<string, string> = {
  critical: 'text-red-400 bg-red-950 border-red-800',
  high: 'text-orange-400 bg-orange-950 border-orange-800',
  medium: 'text-yellow-400 bg-yellow-950 border-yellow-800',
  low: 'text-zinc-400 bg-zinc-800 border-zinc-700',
}

function Badge({
  label,
  variant,
}: {
  label: string
  variant: 'blue' | 'violet' | 'emerald' | 'zinc' | 'amber'
}): React.JSX.Element {
  const styles = {
    blue: 'bg-blue-950 text-blue-300 border-blue-800',
    violet: 'bg-violet-950 text-violet-300 border-violet-800',
    emerald: 'bg-emerald-950 text-emerald-300 border-emerald-800',
    zinc: 'bg-zinc-800 text-zinc-300 border-zinc-700',
    amber: 'bg-amber-950 text-amber-300 border-amber-800',
  }
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono border ${styles[variant]}`}
    >
      {label}
    </span>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">{title}</h2>
      {children}
    </div>
  )
}

// ─── Repo type alert ──────────────────────────────────────────────────────────

const repoTypeLabels: Record<
  Exclude<RepoType, 'code'>,
  { icon: string; title: string; message: string }
> = {
  'awesome-list': {
    icon: '📋',
    title: 'Awesome List',
    message: 'This is a curated awesome-list. Stack detection is not applicable.',
  },
  dotfiles: {
    icon: '⚙️',
    title: 'Dotfiles',
    message: 'This repository contains personal configuration files (dotfiles).',
  },
  docs: {
    icon: '📄',
    title: 'Documentation',
    message: 'This is a documentation-focused repository.',
  },
  data: {
    icon: '🗃️',
    title: 'Data Repository',
    message: 'This repository contains primarily data files.',
  },
  config: {
    icon: '🔧',
    title: 'Configuration',
    message: 'This repository contains configuration files only.',
  },
}

function RepoTypeAlert({ repoType }: { repoType: RepoTypeResult }): React.JSX.Element | null {
  if (repoType.type === 'code') return null
  const cfg = repoTypeLabels[repoType.type]
  return (
    <div className="bg-blue-950/50 border border-blue-800/50 rounded-xl p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span aria-hidden="true">{cfg.icon}</span>
        <span className="text-sm font-medium text-blue-200">{cfg.title}</span>
      </div>
      <p className="text-sm text-blue-300/80">{cfg.message}</p>
      <p className="text-xs text-blue-400/50">
        {Math.round(repoType.confidence * 100)}% confidence — {repoType.reason}
      </p>
    </div>
  )
}

// ─── Repo header ──────────────────────────────────────────────────────────────

function RepoHeader({ repoInfo }: { repoInfo: DiscoveryResult['repoInfo'] }): React.JSX.Element {
  return (
    <Section title="Repository">
      <div className="p-4 bg-zinc-900 border border-zinc-700 rounded-xl flex flex-col gap-2">
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-base font-semibold text-zinc-100 font-mono">{repoInfo.fullName}</h3>
          <div className="flex items-center gap-1.5 shrink-0 text-sm text-zinc-400">
            <svg
              className="h-4 w-4 text-yellow-400"
              fill="currentColor"
              viewBox="0 0 20 20"
              aria-hidden="true"
            >
              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
            </svg>
            {repoInfo.stars.toLocaleString()}
          </div>
        </div>
        {repoInfo.description !== null && (
          <p className="text-sm text-zinc-400">{repoInfo.description}</p>
        )}
        <div className="flex flex-wrap gap-2 mt-1">
          {repoInfo.language !== null && <Badge label={repoInfo.language} variant="zinc" />}
          {repoInfo.topics.slice(0, 6).map((topic) => (
            <Badge key={topic} label={topic} variant="zinc" />
          ))}
        </div>
      </div>
    </Section>
  )
}

// ─── LLM sections ─────────────────────────────────────────────────────────────

function ExecutiveSummarySection({
  summary,
}: {
  summary: LLMAnalysisResult['executiveSummary']
}): React.JSX.Element {
  return (
    <Section title="Overview - TL;DR">
      <div className="p-4 bg-zinc-900 border border-zinc-700 rounded-xl flex flex-col gap-3">
        <p className="text-base font-semibold text-emerald-300 leading-snug">
          {summary.oneLiner}
        </p>
        <div className="text-sm text-zinc-300 leading-relaxed whitespace-pre-line">
          {summary.overview}
        </div>
        <div className="flex items-start gap-2 pt-2 border-t border-zinc-800">
          <span className="text-xs text-zinc-500 shrink-0 mt-0.5">Audience:</span>
          <span className="text-xs text-zinc-400">{summary.targetAudience}</span>
        </div>
      </div>
    </Section>
  )
}

function StackSection({
  refinedStack,
  isNonCode,
}: {
  refinedStack: LLMAnalysisResult['refinedStack']
  isNonCode: boolean
}): React.JSX.Element {
  return (
    <Section title="Stack">
      <div
        className={`p-4 bg-zinc-900 border border-zinc-700 rounded-xl flex flex-col gap-4 ${isNonCode ? 'opacity-60' : ''}`}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {refinedStack.runtime !== 'unknown' && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500">Runtime</span>
              <Badge label={refinedStack.runtime} variant="blue" />
            </div>
          )}
          {refinedStack.framework !== 'unknown' && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500">Framework</span>
              <Badge label={refinedStack.framework} variant="violet" />
            </div>
          )}
          {refinedStack.category !== 'unknown' && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500">Category</span>
              <Badge label={refinedStack.category} variant="emerald" />
            </div>
          )}
          {refinedStack.language !== 'unknown' && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500">Language</span>
              <Badge label={refinedStack.language} variant="zinc" />
            </div>
          )}
          {refinedStack.packageManager !== 'unknown' && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500">Package Manager</span>
              <Badge label={refinedStack.packageManager} variant="zinc" />
            </div>
          )}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Confidence</span>
            <span className="text-sm font-mono text-zinc-200">
              {Math.round(refinedStack.confidence * 100)}%
            </span>
          </div>
        </div>
        <div className="pt-2 border-t border-zinc-800">
          <p className="text-xs text-zinc-500 leading-relaxed">{refinedStack.reasoning}</p>
        </div>
      </div>
      {isNonCode && (
        <p className="text-xs text-zinc-600 mt-1">(limited detection for non-code repos)</p>
      )}
    </Section>
  )
}

const patternIcon: Record<string, string> = {
  monolith: '🧱',
  microservices: '🔀',
  monorepo: '📦',
  mvc: '🔁',
  layered: '🏗️',
  'event-driven': '⚡',
  serverless: '☁️',
  jamstack: '🌐',
  library: '📚',
  unknown: '❓',
}

function ArchitectureSection({
  insights,
}: {
  insights: LLMAnalysisResult['architectureInsights']
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const icon = patternIcon[insights.pattern] ?? '❓'

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">
        Architecture
      </h2>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl overflow-hidden">
        {/* Collapsible header */}
        <button
          type="button"
          onClick={() => setExpanded((v: boolean) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 hover:bg-zinc-800/50 transition-colors"
        >
          <div className="flex items-center gap-3">
            <span className="text-xl" aria-hidden="true">{icon}</span>
            <div className="flex flex-col items-start gap-0.5">
              <span className="text-sm font-semibold text-violet-300 capitalize">
                {insights.pattern}
              </span>
              <span className="text-xs text-zinc-500">architecture pattern</span>
            </div>
          </div>
          <svg
            className={`h-4 w-4 text-zinc-500 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {expanded && (
          <div className="flex flex-col gap-0 border-t border-zinc-800">
            {insights.keyDirectories.length > 0 && (
              <div className="px-4 pt-4 pb-3 flex flex-col gap-2">
                <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide">
                  Key Directories
                </span>
                <div className="flex flex-col gap-1">
                  {insights.keyDirectories.map((dir) => (
                    <div key={dir.path} className="flex items-baseline gap-2">
                      <span className="text-sm font-mono text-zinc-300 shrink-0 leading-relaxed">
                        {dir.path}/
                      </span>
                      <span className="text-xs text-zinc-600 leading-relaxed">{dir.purpose}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {insights.designDecisions.length > 0 && (
              <div className="px-4 pt-3 pb-4 flex flex-col gap-2 border-t border-zinc-800/60">
                <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide">
                  Design Decisions
                </span>
                <ul className="flex flex-col gap-2">
                  {insights.designDecisions.map((dd, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-zinc-600 shrink-0" aria-hidden="true" />
                      <div>
                        <span className="text-sm text-zinc-300">{dd.title}</span>
                        <span className="text-xs text-zinc-500"> — {dd.description}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function LLMKeyFilesSection({
  keyFiles,
}: {
  keyFiles: LLMAnalysisResult['keyFiles']
}): React.JSX.Element {
  return (
    <Section title="Key Files">
      <div className="flex flex-col divide-y divide-zinc-800 bg-zinc-900 border border-zinc-700 rounded-xl overflow-hidden">
        {keyFiles.length === 0 ? (
          <p className="p-4 text-sm text-zinc-500">No key files identified.</p>
        ) : (
          keyFiles.map((file) => (
            <div key={file.path} className="px-4 py-3 flex flex-col gap-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-mono text-zinc-100">{file.path}</span>
                <Badge label={file.category} variant="amber" />
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">{file.whatItDoes}</p>
              <p className="text-xs text-emerald-600/80 leading-relaxed">{file.whyImportant}</p>
            </div>
          ))
        )}
      </div>
    </Section>
  )
}

function ExplorationPathSection({
  steps,
}: {
  steps: LLMAnalysisResult['explorationPath']
}): React.JSX.Element {
  const totalMinutes = steps.reduce((sum, s) => sum + s.estimatedMinutes, 0)
  return (
    <Section title="Exploration Path">
      <div className="flex flex-col gap-3">
        {steps.map((step) => (
          <div
            key={step.order}
            className="flex gap-4 p-4 bg-zinc-900 border border-zinc-700 rounded-xl"
          >
            <div className="shrink-0 w-7 h-7 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-xs font-mono text-zinc-400 mt-0.5">
              {step.order}
            </div>
            <div className="flex flex-col gap-1.5 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-zinc-100">{step.title}</span>
                <span className="text-xs text-zinc-500 shrink-0">~{step.estimatedMinutes}m</span>
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">{step.description}</p>
              {step.files.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {step.files.map((f) => (
                    <span
                      key={f}
                      className="text-xs font-mono text-zinc-300 bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 rounded"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        <p className="text-xs text-zinc-600 text-right">
          Total estimated time: ~{totalMinutes} minutes
        </p>
      </div>
    </Section>
  )
}

// ─── Discovery fallback sections ──────────────────────────────────────────────

function DiscoveryStackSection({
  stack,
  isNonCode,
}: {
  stack: DiscoveryResult['stack']
  isNonCode: boolean
}): React.JSX.Element {
  return (
    <Section title="Stack">
      <div
        className={`p-4 bg-zinc-900 border border-zinc-700 rounded-xl grid grid-cols-2 gap-3 sm:grid-cols-3 ${isNonCode ? 'opacity-60' : ''}`}
      >
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
          <span className="text-sm font-mono text-zinc-200">
            {Math.round(stack.confidence * 100)}%
          </span>
        </div>
      </div>
      {isNonCode && (
        <p className="text-xs text-zinc-600 mt-1">(limited detection for non-code repos)</p>
      )}
    </Section>
  )
}

function DiscoveryKeyFilesSection({
  keyFiles,
}: {
  keyFiles: DiscoveryResult['keyFiles']
}): React.JSX.Element {
  return (
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
                <span className="text-xs text-zinc-500">
                  {file.role} — {file.reason}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
      {keyFiles.length >= 12 && (
        <p className="text-xs text-zinc-600 mt-2 text-right">Showing top 12 key files</p>
      )}
    </Section>
  )
}

function DiscoveryEntryPointsSection({
  entryPoints,
}: {
  entryPoints: DiscoveryResult['entryPoints']
}): React.JSX.Element {
  return (
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
  )
}

// ─── Root component ───────────────────────────────────────────────────────────

export function AnalysisResult({ result, onReset }: AnalysisResultProps): React.JSX.Element {
  const { discovery, llmAnalysis } = result

  if (discovery === null) {
    return (
      <div className="w-full flex flex-col gap-4">
        <p className="text-sm text-red-400">Analysis failed: no discovery data available.</p>
        <button
          type="button"
          onClick={onReset}
          className="self-start h-10 px-5 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-sm font-medium rounded-lg border border-zinc-700 transition-colors"
        >
          Try again
        </button>
      </div>
    )
  }

  const { repoInfo, stack, repoType, keyFiles, entryPoints, totalFiles, totalDirectories } =
    discovery
  const isNonCode = repoType.type !== 'code'

  return (
    <div className="w-full flex flex-col gap-6">
      <RepoHeader repoInfo={repoInfo} />

      <RepoTypeAlert repoType={repoType} />

      {llmAnalysis !== null ? (
        <>
          <ExecutiveSummarySection summary={llmAnalysis.executiveSummary} />
          <StackSection refinedStack={llmAnalysis.refinedStack} isNonCode={isNonCode} />
          <ArchitectureSection insights={llmAnalysis.architectureInsights} />
          <LLMKeyFilesSection keyFiles={llmAnalysis.keyFiles} />
          <ExplorationPathSection steps={llmAnalysis.explorationPath} />
        </>
      ) : (
        <>
          <DiscoveryStackSection stack={stack} isNonCode={isNonCode} />
          <DiscoveryKeyFilesSection keyFiles={keyFiles} />
          <DiscoveryEntryPointsSection entryPoints={entryPoints} />
        </>
      )}

      {/* Stats */}
      <Section title="Stats">
        <div className="p-4 bg-zinc-900 border border-zinc-700 rounded-xl grid grid-cols-3 gap-4 text-center">
          <div className="flex flex-col gap-1">
            <span className="text-2xl font-bold text-zinc-100">
              {totalFiles.toLocaleString()}
            </span>
            <span className="text-xs text-zinc-500">Files</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-2xl font-bold text-zinc-100">
              {totalDirectories.toLocaleString()}
            </span>
            <span className="text-xs text-zinc-500">Directories</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-2xl font-bold text-zinc-100">
              {Math.round((llmAnalysis?.refinedStack.confidence ?? stack.confidence) * 100)}%
            </span>
            <span className="text-xs text-zinc-500">Stack confidence</span>
          </div>
        </div>
      </Section>

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
