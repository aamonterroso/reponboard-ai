// ─── GitHub API Types ────────────────────────────────────────────────────────

export interface GitHubRepoInfo {
  owner: string
  name: string
  fullName: string
  description: string | null
  defaultBranch: string
  stars: number
  forks: number
  language: string | null
  topics: string[]
  size: number
  createdAt: string
  updatedAt: string
  license: string | null
  isPrivate: boolean
}

export type GitHubTreeNodeType = 'blob' | 'tree' | 'commit'

export interface GitHubTreeNode {
  path: string
  mode: string
  type: GitHubTreeNodeType
  sha: string
  size?: number
  url: string
}

export interface GitHubFileContent {
  path: string
  content: string
  encoding: 'base64' | 'utf-8'
  size: number
  sha: string
}

// ─── Stack Detection Types ───────────────────────────────────────────────────

export type StackCategory =
  | 'frontend'
  | 'backend'
  | 'fullstack'
  | 'mobile'
  | 'cli'
  | 'library'
  | 'monorepo'
  | 'unknown'

export type RuntimeId =
  | 'nodejs'
  | 'deno'
  | 'bun'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'dotnet'
  | 'ruby'
  | 'php'
  | 'unknown'

export type FrameworkId =
  | 'nextjs'
  | 'react'
  | 'vue'
  | 'svelte'
  | 'angular'
  | 'nuxt'
  | 'astro'
  | 'remix'
  | 'express'
  | 'fastify'
  | 'nestjs'
  | 'hono'
  | 'django'
  | 'fastapi'
  | 'flask'
  | 'gin'
  | 'echo'
  | 'axum'
  | 'spring'
  | 'unknown'

export interface DetectedStack {
  runtime: RuntimeId
  framework: FrameworkId
  category: StackCategory
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'pip' | 'cargo' | 'go' | 'maven' | 'gradle' | 'unknown'
  language: 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'java' | 'csharp' | 'ruby' | 'php' | 'unknown'
  hasTests: boolean
  hasDocker: boolean
  hasCi: boolean
  additionalLibraries: string[]
  confidence: number
}

// ─── Discovery Phase Types ───────────────────────────────────────────────────

export type EntryPointKind =
  | 'main'
  | 'server'
  | 'cli'
  | 'app'
  | 'index'
  | 'config'
  | 'test'

export interface EntryPoint {
  path: string
  kind: EntryPointKind
  reason: string
  priority: number
}

export type KeyFileRole =
  | 'config'
  | 'schema'
  | 'router'
  | 'model'
  | 'service'
  | 'utility'
  | 'types'
  | 'test'
  | 'documentation'

export interface KeyFile {
  path: string
  role: KeyFileRole
  importance: 'critical' | 'high' | 'medium' | 'low'
  reason: string
  size: number
}

// ─── Repo Type Detection ─────────────────────────────────────────────────────

export type RepoType = 'code' | 'docs' | 'awesome-list' | 'dotfiles' | 'data' | 'config'

export interface RepoTypeResult {
  type: RepoType
  confidence: number
  reason: string
}

export interface DiscoveryResult {
  repoInfo: GitHubRepoInfo
  tree: GitHubTreeNode[]
  stack: DetectedStack
  repoType: RepoTypeResult
  entryPoints: EntryPoint[]
  keyFiles: KeyFile[]
  totalFiles: number
  totalDirectories: number
  detectedAt: string
}

// ─── Analysis Phase Types ────────────────────────────────────────────────────

export type ArchitecturePattern =
  | 'monolith'
  | 'microservices'
  | 'monorepo'
  | 'mvc'
  | 'layered'
  | 'event-driven'
  | 'serverless'
  | 'jamstack'
  | 'library'
  | 'unknown'

export interface DependencyNode {
  path: string
  imports: string[]
  importedBy: string[]
  isExternal: boolean
}

export interface Convention {
  name: string
  description: string
  examples: string[]
}

export interface ComplexityHotspot {
  path: string
  reason: string
  score: number
}

export interface AnalysisResult {
  pattern: ArchitecturePattern
  dependencyGraph: DependencyNode[]
  conventions: Convention[]
  hotspots: ComplexityHotspot[]
  analyzedFiles: string[]
  analyzedAt: string
}

// ─── Guide Generation Types ──────────────────────────────────────────────────

export interface StartHereFile {
  path: string
  reason: string
  estimatedReadTime: number
}

export type ExplorationStepCategory =
  | 'understand'
  | 'trace'
  | 'run'
  | 'modify'
  | 'test'

export interface ExplorationStep {
  order: number
  title: string
  description: string
  files: string[]
  category: ExplorationStepCategory
  estimatedMinutes: number
}

export interface OnboardingGuide {
  summary: string
  diagram: string
  startHere: StartHereFile[]
  explorationPath: ExplorationStep[]
  totalEstimatedMinutes: number
  generatedAt: string
}

// ─── Q&A Types ───────────────────────────────────────────────────────────────

export type QARole = 'user' | 'assistant'

export interface QAMessage {
  role: QARole
  content: string
  filesReferenced: string[]
  timestamp: string
}

export interface QAContext {
  analysisId: string
  repoInfo: GitHubRepoInfo
  stack: DetectedStack
  guide: OnboardingGuide
  history: QAMessage[]
}

export interface QAResult {
  answer: string
  filesReferenced: string[]
}

export type QAProgressEvent =
  | {
      phase: 'thinking'
      message: string
      toolCall?: string
      toolInput?: Record<string, unknown>
    }
  | { phase: 'tool_result'; tool: string; summary: string }
  | { phase: 'complete'; result: QAResult }
  | { phase: 'error'; error: string }

// ─── LLM Analysis Types ──────────────────────────────────────────────────────

export interface RefinedStack extends DetectedStack {
  reasoning: string
}

export interface ExecutiveSummary {
  oneLiner: string
  overview: string
  targetAudience: string
}

export interface KeyDirectory {
  path: string
  purpose: string
}

export interface DesignDecision {
  title: string
  description: string
}

export interface ArchitectureInsights {
  pattern: ArchitecturePattern
  patternDescription: string
  keyDirectories: KeyDirectory[]
  designDecisions: DesignDecision[]
}

export type LLMKeyFileCategory =
  | 'entry-point'
  | 'core-logic'
  | 'configuration'
  | 'infrastructure'
  | 'data-model'
  | 'utilities'
  | 'tests'
  | 'documentation'

export interface LLMKeyFile {
  path: string
  whatItDoes: string
  whyImportant: string
  category: LLMKeyFileCategory
}

export interface ExplorationPathStep {
  order: number
  title: string
  description: string
  files: string[]
  estimatedMinutes: number
}

export interface LLMAnalysisResult {
  refinedStack: RefinedStack
  executiveSummary: ExecutiveSummary
  architectureInsights: ArchitectureInsights
  keyFiles: LLMKeyFile[]
  explorationPath: ExplorationPathStep[]
  codebaseContext: string
}

export interface LLMCorePartial {
  refinedStack: RefinedStack
  executiveSummary: ExecutiveSummary
  architectureInsights: ArchitectureInsights
}

export interface LLMGuidePartial {
  keyFiles: LLMKeyFile[]
  explorationPath: ExplorationPathStep[]
  codebaseContext: string
}

// ─── Full Analysis Result ─────────────────────────────────────────────────────

export type AnalysisStatus =
  | 'queued'
  | 'discovering'
  | 'analyzing'
  | 'generating'
  | 'complete'
  | 'failed'

export interface FullAnalysisResult {
  id: string
  repoUrl: string
  status: AnalysisStatus
  discovery: DiscoveryResult | null
  llmAnalysis: LLMAnalysisResult | null
  error: string | null
  createdAt: string
  completedAt: string | null
}

// ─── Streaming Event Types ────────────────────────────────────────────────────

export type AnalysisPhase =
  | 'discovery'
  | 'fetching'
  | 'analyzing'
  | 'thinking'
  | 'partial_core'
  | 'partial_guide'
  | 'complete'
  | 'error'

export type AnalysisProgressEvent =
  | { phase: 'discovery'; message: string }
  | { phase: 'fetching'; message: string; progress: { current: number; total: number } }
  | { phase: 'analyzing'; message: string }
  | {
      phase: 'thinking'
      message: string
      toolCall?: string
      toolInput?: Record<string, unknown>
    }
  | { phase: 'partial_core'; core: LLMCorePartial }
  | { phase: 'partial_guide'; guide: LLMGuidePartial }
  | { phase: 'complete'; result: FullAnalysisResult }
  | { phase: 'error'; error: string }
