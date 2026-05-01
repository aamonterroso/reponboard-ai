import Anthropic from '@anthropic-ai/sdk'
import { GitHubClient } from './github'
import type {
  ArchitectureInsights,
  DetectedStack,
  DiscoveryResult,
  ExecutiveSummary,
  ExplorationPathStep,
  GitHubTreeNode,
  LLMAnalysisResult,
  LLMCorePartial,
  LLMGuidePartial,
  LLMKeyFile,
  RefinedStack,
} from './types'

// ─── Tree Filtering ───────────────────────────────────────────────────────────

const EXCLUDED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  '.output',
  '__pycache__',
  '.pytest_cache',
  'target',
  '.cargo',
  'vendor',
  'coverage',
  '.nyc_output',
  '.turbo',
  '.cache',
])

const NOISE_PATTERNS = [
  /^node_modules\//,
  /^\.git\//,
  /^dist\//,
  /^build\//,
  /^\.next\//,
  /^coverage\//,
  /^\.turbo\//,
  /^\.cache\//,
  /^vendor\//,
  /^target\//,           // Rust build dir
  /^__pycache__\//,
  /\.lock$/,             // package-lock.json, yarn.lock, pnpm-lock.yaml, Cargo.lock
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.(png|jpg|jpeg|gif|svg|ico|webp|mp4|mp3|woff2?|ttf|eot)$/i,
]

function filterTreeForPrompt(tree: GitHubTreeNode[]): GitHubTreeNode[] {
  return tree.filter((node) => {
    if (node.type !== 'blob') return true // keep dirs for structure
    if (NOISE_PATTERNS.some((rx) => rx.test(node.path))) return false
    if (node.size !== undefined && node.size > 500_000) return false // skip files >500KB
    return true
  })
}

function rankTreeEntries(entries: GitHubTreeNode[]): GitHubTreeNode[] {
  return [...entries].sort((a, b) => {
    const depthA = a.path.split('/').length
    const depthB = b.path.split('/').length
    if (depthA !== depthB) return depthA - depthB
    return a.path.localeCompare(b.path)
  })
}

function buildCondensedTree(tree: DiscoveryResult['tree']): string {
  const segmentFiltered = tree.filter(
    (node) => !node.path.split('/').some((seg) => EXCLUDED_SEGMENTS.has(seg)),
  )

  const originalCount = tree.length
  const filtered = filterTreeForPrompt(segmentFiltered)
  console.log(`[timing] tree filtered ${originalCount} → ${filtered.length} entries`)

  const prioritized = rankTreeEntries(filtered).slice(0, 300)
  console.log(`[timing] tree capped to ${prioritized.length} entries (was ${filtered.length})`)

  return prioritized
    .map((node) => `${node.type === 'tree' ? 'd' : 'f'} ${node.path}`)
    .join('\n')
}

// ─── Initial Prompt ───────────────────────────────────────────────────────────

function buildInitialUserPrompt(discovery: DiscoveryResult): string {
  const { repoInfo, stack, repoType, entryPoints, keyFiles } = discovery

  const repoMeta = [
    `Repository: ${repoInfo.fullName}`,
    `Description: ${repoInfo.description ?? 'No description'}`,
    `Stars: ${repoInfo.stars}`,
    `Primary Language: ${repoInfo.language ?? 'Unknown'}`,
    `Topics: ${repoInfo.topics.join(', ') || 'None'}`,
    `License: ${repoInfo.license ?? 'None'}`,
    `Size: ${repoInfo.size} KB`,
  ].join('\n')

  const heuristicGuess = `## Heuristic Analysis (treat as starting hypothesis)
Runtime: ${stack.runtime}
Framework: ${stack.framework}
Language: ${stack.language}
Category: ${stack.category}
Package Manager: ${stack.packageManager}
Has Tests: ${stack.hasTests} | Has Docker: ${stack.hasDocker} | Has CI: ${stack.hasCi}
Detection Confidence: ${stack.confidence}

Repo Type: ${repoType.type} (confidence: ${repoType.confidence}) — ${repoType.reason}

Entry Points (heuristic):
${entryPoints.map((ep) => `- ${ep.path} (${ep.kind}): ${ep.reason}`).join('\n') || '- None detected'}

Key Files (heuristic, by importance):
${keyFiles
  .slice(0, 10)
  .map((kf) => `- ${kf.path} [${kf.role}, ${kf.importance}]: ${kf.reason}`)
  .join('\n') || '- None detected'}`

  const treeSection = `## Repository Tree (condensed, excluding build artifacts)
\`\`\`
${buildCondensedTree(discovery.tree)}
\`\`\``

  return `${repoMeta}\n\n${heuristicGuess}\n\n${treeSection}\n\nYou have tools to explore this codebase. Call \`fetch_file\` to read specific files (entry points, key configs, main modules). Call \`list_directory\` to explore unfamiliar areas. Call \`search_code\` to find files by name pattern. When you have enough context to describe the stack, summary, and architecture, call \`finish_core\` to submit the core analysis. After that you'll be asked to call \`finish_guide\` to submit the detailed onboarding guide.`
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert software engineer specializing in codebase analysis and developer onboarding.

You have tools to explore a GitHub repository. Use them to gather evidence before drawing conclusions:
- fetch_file: read a file's contents (first 4000 chars)
- list_directory: list files in a directory
- search_code: find files by path substring

You will produce the analysis in TWO phases:

Phase 1 — Core architecture: Once you have explored enough to understand the stack, summary, and architecture pattern, call finish_core with refinedStack, executiveSummary, and architectureInsights.

Phase 2 — Onboarding guide: After finish_core is captured, you will be prompted to produce the guide. You may explore additional files first if needed, then call finish_guide with keyFiles, explorationPath, and codebaseContext.

IMPORTANT: You MUST call both finish_core and finish_guide. Do not skip either. Call finish_core first, then finish_guide.

Strategy:
1. Start by reading 2-4 critical files (entry points, main config, root README)
2. Explore key directories if unclear
3. Once you understand the project, call finish_core
4. After core is captured, optionally explore a few more files, then call finish_guide

You have a total budget of ~7 tool calls across both phases. The most important files are pre-loaded for you in the user message — do not refetch them. Use your tool calls only for files/directories you genuinely need but haven't seen yet.

Quality guidelines for the structured outputs:
- Be specific and concrete. Reference actual file names, function names, and patterns you observed via tools.
- codebaseContext should be a dense 2-3 paragraph summary to serve as background for follow-up questions.
- Size caps: keyFiles ≤ 10, explorationPath ≤ 5, keyDirectories ≤ 6, designDecisions ≤ 4, additionalLibraries ≤ 8.
- All description fields: max 2 sentences each.
- For architectureInsights.pattern: pick exactly ONE slug from the enum (monolith, microservices, monorepo, mvc, layered, event-driven, serverless, jamstack, library, unknown). Do NOT write a sentence here. Use architectureInsights.patternDescription for the rich 1-2 sentence description of the architecture style.
- Prioritize quality over quantity.`

// ─── Tool Schemas ─────────────────────────────────────────────────────────────

// Shared inner-property schemas (preserved exactly so length-guidance descriptions
// stay attached when split across the two terminal tools).
const REFINED_STACK_SCHEMA: Anthropic.Tool.InputSchema['properties'] = {
  runtime: { type: 'string' },
  framework: { type: 'string' },
  language: { type: 'string' },
  category: { type: 'string' },
  packageManager: { type: 'string' },
  hasTests: { type: 'boolean' },
  hasDocker: { type: 'boolean' },
  hasCi: { type: 'boolean' },
  additionalLibraries: { type: 'array', items: { type: 'string' } },
  confidence: { type: 'number' },
  reasoning: { type: 'string' },
}

const FINISH_CORE_SCHEMA: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    refinedStack: {
      type: 'object',
      properties: REFINED_STACK_SCHEMA,
      required: [
        'runtime',
        'framework',
        'language',
        'category',
        'packageManager',
        'hasTests',
        'hasDocker',
        'hasCi',
        'additionalLibraries',
        'confidence',
        'reasoning',
      ],
    },
    executiveSummary: {
      type: 'object',
      properties: {
        oneLiner: { type: 'string' },
        overview: {
          type: 'string',
          description: '(2-3 sentences max, ~250 chars)',
        },
        targetAudience: {
          type: 'string',
          description: '(1 sentence, ~120 chars)',
        },
      },
      required: ['oneLiner', 'overview', 'targetAudience'],
    },
    architectureInsights: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          enum: [
            'monolith',
            'microservices',
            'monorepo',
            'mvc',
            'layered',
            'event-driven',
            'serverless',
            'jamstack',
            'library',
            'unknown',
          ],
          description:
            'Pick the SINGLE closest matching pattern slug from the enum. Do not invent new values. If unsure, use "unknown".',
        },
        patternDescription: {
          type: 'string',
          description:
            'A 1-2 sentence rich description of the architecture (e.g. "Monorepo with two-layer analysis pipeline: heuristic discovery feeds an LLM refinement layer, exposed via a Next.js streaming API."). This is the descriptive text shown to the user as a subtitle. (1-2 sentences, ~200 chars)',
        },
        keyDirectories: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              purpose: { type: 'string' },
            },
            required: ['path', 'purpose'],
          },
        },
        designDecisions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['title', 'description'],
          },
        },
      },
      required: ['pattern', 'patternDescription', 'keyDirectories', 'designDecisions'],
    },
  },
  required: ['refinedStack', 'executiveSummary', 'architectureInsights'],
}

const FINISH_GUIDE_SCHEMA: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    keyFiles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          whatItDoes: {
            type: 'string',
            description: '(1 sentence, ~150 chars)',
          },
          whyImportant: {
            type: 'string',
            description: '(1 sentence, ~120 chars)',
          },
          category: { type: 'string' },
        },
        required: ['path', 'whatItDoes', 'whyImportant', 'category'],
      },
    },
    explorationPath: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          order: { type: 'number' },
          title: { type: 'string' },
          description: {
            type: 'string',
            description: '(2 sentences max, ~200 chars)',
          },
          files: { type: 'array', items: { type: 'string' } },
          estimatedMinutes: { type: 'number' },
        },
        required: ['order', 'title', 'description', 'files', 'estimatedMinutes'],
      },
    },
    codebaseContext: {
      type: 'string',
      description:
        "(short paragraph, ~300 chars max — only what you couldn't fit elsewhere)",
    },
  },
  required: ['keyFiles', 'explorationPath', 'codebaseContext'],
}

export const EXPLORATION_TOOLS: Anthropic.Tool[] = [
  {
    name: 'fetch_file',
    description:
      'Read the contents of a file in the repository. Returns the first 4000 characters. Use for entry points, main modules, and configs.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to repo root (e.g., "src/index.ts")',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description:
      'List files and subdirectories in a directory. Use "" for the repository root. Useful for exploring unfamiliar areas.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to repo root. Use "" for root.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_code',
    description:
      'Search the repository tree for file paths matching a substring. Optionally filter by extension. Returns matching file paths (not contents).',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Substring to match in file paths (case-insensitive)',
        },
        filePattern: {
          type: 'string',
          description: 'Optional extension filter (e.g., ".ts", ".tsx")',
        },
      },
      required: ['query'],
    },
  },
]

const CORE_TOOLS: Anthropic.Tool[] = [
  ...EXPLORATION_TOOLS,
  {
    name: 'finish_core',
    description:
      'Submit the core structural analysis: stack, summary, and architecture. Call this FIRST after exploring the repo. After this is captured, you will be asked to produce the detailed onboarding guide.',
    input_schema: FINISH_CORE_SCHEMA,
  },
]

const GUIDE_TOOLS: Anthropic.Tool[] = [
  ...EXPLORATION_TOOLS,
  {
    name: 'finish_guide',
    description:
      'Submit the detailed onboarding guide: key files (categorized), exploration path (5-step journey), and any additional codebase context. Call this AFTER finish_core.',
    input_schema: FINISH_GUIDE_SCHEMA,
  },
]

// ─── Tool Executor ────────────────────────────────────────────────────────────

const MAX_FILE_CHARS = 4000

export async function executeExplorationTool(
  name: string,
  input: unknown,
  tree: DiscoveryResult['tree'],
  githubClient: GitHubClient,
  repoContext: { owner: string; repo: string; branch: string },
): Promise<string> {
  if (typeof input !== 'object' || input === null) {
    return 'Error: invalid tool input'
  }
  const inp = input as Record<string, unknown>

  if (name === 'fetch_file') {
    const path = typeof inp.path === 'string' ? inp.path : ''
    if (path === '') return 'Error: missing path'
    try {
      const file = await githubClient.getFileContent(
        repoContext.owner,
        repoContext.repo,
        path,
        repoContext.branch,
      )
      const body =
        file.content.length > MAX_FILE_CHARS
          ? file.content.slice(0, MAX_FILE_CHARS) +
            `\n... (truncated, full size: ${file.size} bytes)`
          : file.content
      return `--- ${path} ---\n${body}`
    } catch (err) {
      return `Error fetching ${path}: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  if (name === 'list_directory') {
    const rawPath = typeof inp.path === 'string' ? inp.path : ''
    const prefix = rawPath === '' ? '' : rawPath.replace(/\/$/, '') + '/'
    const entries = tree
      .filter((n) => {
        if (prefix === '') return !n.path.includes('/')
        if (!n.path.startsWith(prefix)) return false
        const rest = n.path.slice(prefix.length)
        return rest !== '' && !rest.includes('/')
      })
      .slice(0, 100)
      .map((n) => `${n.type === 'tree' ? 'd' : 'f'} ${n.path}`)
    return entries.length > 0
      ? entries.join('\n')
      : `No entries found for "${rawPath}"`
  }

  if (name === 'search_code') {
    const query =
      typeof inp.query === 'string' ? inp.query.toLowerCase() : ''
    const filePattern =
      typeof inp.filePattern === 'string' ? inp.filePattern : null
    if (query === '') return 'Error: missing query'

    const matches = tree
      .filter((n) => n.type === 'blob')
      .filter((n) => n.path.toLowerCase().includes(query))
      .filter((n) =>
        filePattern !== null ? n.path.endsWith(filePattern) : true,
      )
      .slice(0, 30)
      .map((n) => n.path)
    return matches.length > 0 ? matches.join('\n') : 'No matching files'
  }

  return `Unknown tool: ${name}`
}

// ─── Model Configuration ──────────────────────────────────────────────────────

const MODELS = {
  development: 'claude-haiku-4-5-20251001',
  production: 'claude-sonnet-4-20250514',
} as const

export type LLMMode = keyof typeof MODELS

export type LLMModelIntent = 'fast' | 'quality' | 'parity'

export const INTENT_TO_MODEL: Record<LLMModelIntent, string> = {
  fast: MODELS.development,
  quality: MODELS.production,
  parity: MODELS.production,
}

// ─── Streaming Events ─────────────────────────────────────────────────────────

export type LLMStreamEvent =
  | {
      type: 'thinking'
      message: string
      toolCall?: string
      toolInput?: Record<string, unknown>
    }
  | { type: 'partial_core'; core: LLMCorePartial }
  | { type: 'partial_guide'; guide: LLMGuidePartial }
  | { type: 'result'; result: LLMAnalysisResult }

const MAX_TOOL_CALLS_CORE = 4
const MAX_TOOL_CALLS_GUIDE = 3

// ─── Result Validation & Normalization ────────────────────────────────────────

function dedupeBy<T>(arr: T[], keyFn: (x: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of arr) {
    const k = keyFn(item)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(item)
  }
  return out
}

const VALID_PATTERNS = [
  'monolith',
  'microservices',
  'monorepo',
  'mvc',
  'layered',
  'event-driven',
  'serverless',
  'jamstack',
  'library',
  'unknown',
] as const

type ArchPattern = (typeof VALID_PATTERNS)[number]

// Anthropic sometimes returns tool_use inputs that don't fully match the schema
// (e.g. omitting top-level fields when under tool-budget pressure). Instead of
// throwing — which kills the whole analysis — coerce the result into a
// fully-shaped partial by filling missing fields with sensible fallbacks
// (heuristic discovery data where applicable, empty defaults otherwise). Only
// throw if the LLM returned no object at all.
function coerceCorePartial(
  value: unknown,
  discoveryStack: DetectedStack,
): LLMCorePartial {
  if (typeof value !== 'object' || value === null) {
    throw new Error('finish_core returned non-object')
  }
  const v = value as Record<string, unknown>

  let refinedStack: RefinedStack
  if (typeof v.refinedStack !== 'object' || v.refinedStack === null) {
    console.warn('[LLM] refinedStack missing, falling back to discovery stack')
    refinedStack = {
      ...discoveryStack,
      reasoning:
        'Stack derived from heuristic discovery (LLM did not refine).',
    }
  } else {
    const rs = v.refinedStack as Record<string, unknown>
    refinedStack = {
      runtime: (rs.runtime as DetectedStack['runtime']) ?? discoveryStack.runtime,
      framework:
        (rs.framework as DetectedStack['framework']) ?? discoveryStack.framework,
      language:
        (rs.language as DetectedStack['language']) ?? discoveryStack.language,
      category:
        (rs.category as DetectedStack['category']) ?? discoveryStack.category,
      packageManager:
        (rs.packageManager as DetectedStack['packageManager']) ??
        discoveryStack.packageManager,
      hasTests:
        typeof rs.hasTests === 'boolean' ? rs.hasTests : discoveryStack.hasTests,
      hasDocker:
        typeof rs.hasDocker === 'boolean'
          ? rs.hasDocker
          : discoveryStack.hasDocker,
      hasCi: typeof rs.hasCi === 'boolean' ? rs.hasCi : discoveryStack.hasCi,
      additionalLibraries: Array.isArray(rs.additionalLibraries)
        ? (rs.additionalLibraries.filter(
            (x) => typeof x === 'string',
          ) as string[])
        : discoveryStack.additionalLibraries,
      confidence:
        typeof rs.confidence === 'number'
          ? rs.confidence
          : discoveryStack.confidence,
      reasoning: typeof rs.reasoning === 'string' ? rs.reasoning : '',
    }
  }

  let executiveSummary: ExecutiveSummary
  if (typeof v.executiveSummary !== 'object' || v.executiveSummary === null) {
    console.warn('[LLM] executiveSummary missing, using minimal fallback')
    executiveSummary = {
      oneLiner: 'Analysis incomplete — LLM did not provide a summary.',
      overview:
        'The AI analysis layer did not return a complete summary for this repository. The structural discovery data below is still accurate.',
      targetAudience: 'Developers exploring this codebase.',
    }
  } else {
    const es = v.executiveSummary as Record<string, unknown>
    executiveSummary = {
      oneLiner: typeof es.oneLiner === 'string' ? es.oneLiner : '',
      overview: typeof es.overview === 'string' ? es.overview : '',
      targetAudience:
        typeof es.targetAudience === 'string' ? es.targetAudience : '',
    }
  }

  let architectureInsights: ArchitectureInsights
  if (
    typeof v.architectureInsights !== 'object' ||
    v.architectureInsights === null
  ) {
    console.warn('[LLM] architectureInsights missing, using empty defaults')
    architectureInsights = {
      pattern: 'unknown',
      patternDescription: '',
      keyDirectories: [],
      designDecisions: [],
    }
  } else {
    const ai = v.architectureInsights as Record<string, unknown>
    let pattern: ArchPattern = 'unknown'
    if (
      typeof ai.pattern === 'string' &&
      (VALID_PATTERNS as readonly string[]).includes(ai.pattern)
    ) {
      pattern = ai.pattern as ArchPattern
    } else if (typeof ai.pattern === 'string') {
      console.warn(
        `[LLM] pattern "${ai.pattern}" not in enum, coerced to unknown`,
      )
    }
    architectureInsights = {
      pattern,
      patternDescription:
        typeof ai.patternDescription === 'string' &&
        ai.patternDescription.trim() !== ''
          ? ai.patternDescription
          : '',
      keyDirectories: Array.isArray(ai.keyDirectories)
        ? (ai.keyDirectories as ArchitectureInsights['keyDirectories'])
        : [],
      designDecisions: Array.isArray(ai.designDecisions)
        ? (ai.designDecisions as ArchitectureInsights['designDecisions'])
        : [],
    }
  }

  return { refinedStack, executiveSummary, architectureInsights }
}

function coerceGuidePartial(value: unknown): LLMGuidePartial {
  if (typeof value !== 'object' || value === null) {
    throw new Error('finish_guide returned non-object')
  }
  const v = value as Record<string, unknown>

  let keyFiles: LLMKeyFile[]
  if (!Array.isArray(v.keyFiles)) {
    console.warn('[LLM] keyFiles missing, defaulting to []')
    keyFiles = []
  } else {
    keyFiles = v.keyFiles as LLMKeyFile[]
  }

  let explorationPath: ExplorationPathStep[]
  if (!Array.isArray(v.explorationPath)) {
    console.warn('[LLM] explorationPath missing, defaulting to []')
    explorationPath = []
  } else {
    explorationPath = v.explorationPath as ExplorationPathStep[]
  }

  const codebaseContext =
    typeof v.codebaseContext === 'string' ? v.codebaseContext : ''

  return { keyFiles, explorationPath, codebaseContext }
}

// Thin wrapper that merges a core partial and a guide partial into the
// fully-shaped LLMAnalysisResult consumed by the rest of the pipeline.
function mergePartials(
  core: LLMCorePartial,
  guide: LLMGuidePartial,
): LLMAnalysisResult {
  return {
    refinedStack: core.refinedStack,
    executiveSummary: core.executiveSummary,
    architectureInsights: core.architectureInsights,
    keyFiles: guide.keyFiles,
    explorationPath: guide.explorationPath,
    codebaseContext: guide.codebaseContext,
  }
}

// Dedupe arrays to prevent React "duplicate key" warnings when the LLM
// repeats entries (observed with keyDirectories returning the same path twice).
function normalizeLLMAnalysisResult(
  result: LLMAnalysisResult,
): LLMAnalysisResult {
  const insights = result.architectureInsights
  insights.patternDescription =
    typeof insights.patternDescription === 'string' ? insights.patternDescription : ''
  insights.keyDirectories = dedupeBy(insights.keyDirectories, (d) => d.path)

  result.keyFiles = dedupeBy(result.keyFiles, (f) => f.path)
  result.explorationPath = dedupeBy(result.explorationPath, (s) =>
    String(s.order),
  )
  for (const step of result.explorationPath) {
    step.files = dedupeBy(step.files, (f) => f)
  }
  result.refinedStack.additionalLibraries = dedupeBy(
    result.refinedStack.additionalLibraries,
    (x) => x,
  )
  return result
}

// ─── Pre-fetch helpers ────────────────────────────────────────────────────────

const KEY_FILE_IMPORTANCE_RANK: Record<
  DiscoveryResult['keyFiles'][number]['importance'],
  number
> = { critical: 0, high: 1, medium: 2, low: 3 }

const PREFETCH_FILE_LIMIT = 3
const PREFETCH_CONTENT_CHARS = 3000

// Fetch the top N most important keyFiles in parallel so the agent has
// immediate context without burning tool calls on obvious files.
async function prefetchTopKeyFiles(
  discovery: DiscoveryResult,
  githubClient: GitHubClient,
  repoContext: { owner: string; repo: string; branch: string },
): Promise<Map<string, string>> {
  const top = [...discovery.keyFiles]
    .sort(
      (a, b) =>
        KEY_FILE_IMPORTANCE_RANK[a.importance] -
        KEY_FILE_IMPORTANCE_RANK[b.importance],
    )
    .slice(0, PREFETCH_FILE_LIMIT)
    .map((f) => f.path)

  if (top.length === 0) return new Map()

  const raw = await githubClient.getFilesContent(
    repoContext.owner,
    repoContext.repo,
    top,
    repoContext.branch,
  )

  const contents = new Map<string, string>()
  for (const [path, value] of raw) {
    if (!(value instanceof Error)) contents.set(path, value.content)
  }
  return contents
}

function formatPrefetchedContent(contents: Map<string, string>): string {
  if (contents.size === 0) return ''
  const sections = Array.from(contents.entries()).map(([path, body]) => {
    const trimmed =
      body.length > PREFETCH_CONTENT_CHARS
        ? body.slice(0, PREFETCH_CONTENT_CHARS) + '\n... (truncated)'
        : body
    return `### ${path}\n\`\`\`\n${trimmed}\n\`\`\``
  })
  return `\n\nHere are the most important files to start your analysis:\n\n${sections.join('\n\n')}\n\nNow explore further as needed with your tools.`
}

// ─── Main Tool Loop ───────────────────────────────────────────────────────────

interface PhaseContext {
  client: Anthropic
  model: string
  messages: Anthropic.MessageParam[]
  finishToolName: 'finish_core' | 'finish_guide'
  tools: Anthropic.Tool[]
  maxToolCalls: number
  githubClient: GitHubClient
  discovery: DiscoveryResult
  repoContext: { owner: string; repo: string; branch: string }
  counters: { iter: number; toolCalls: number }
  llmStart: number
}

// Run a single ReAct phase. Yields thinking events as the agent works, and
// returns the captured finish tool_use block (or null if the phase exhausted
// its iteration budget without one). Mutates `ctx.messages` so the caller can
// continue the conversation in the next phase.
async function* runReactPhase(
  ctx: PhaseContext,
): AsyncGenerator<LLMStreamEvent, Anthropic.ToolUseBlock | null> {
  const phaseMaxIterations = ctx.maxToolCalls + 3
  let phaseIter = 0

  while (phaseIter < phaseMaxIterations) {
    phaseIter++
    ctx.counters.iter++
    const iterStart = Date.now()
    console.log(
      `[timing] llm iter ${ctx.counters.iter} starting at +${iterStart - ctx.llmStart}ms`,
    )

    const isForced = ctx.counters.toolCalls >= ctx.maxToolCalls
    if (isForced) {
      console.log(
        `[timing] forcing ${ctx.finishToolName} via tool_choice (budget exceeded)`,
      )
    }

    const apiStart = Date.now()
    const response = await ctx.client.messages.create({
      model: ctx.model,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools: ctx.tools,
      messages: ctx.messages,
      ...(isForced
        ? {
            tool_choice: {
              type: 'tool' as const,
              name: ctx.finishToolName,
            },
          }
        : {}),
    })
    console.log(`[timing] anthropic api call took ${Date.now() - apiStart}ms`)

    const finishBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === 'tool_use' && b.name === ctx.finishToolName,
    )
    if (finishBlock !== undefined) {
      yield {
        type: 'thinking',
        message: 'Finalizing analysis...',
        toolCall: ctx.finishToolName,
      }
      // Append the finish call + a synthetic tool_result so the next phase can
      // continue from this conversation state.
      ctx.messages.push({ role: 'assistant', content: response.content })
      const finalResults: Anthropic.ToolResultBlockParam[] = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({
          type: 'tool_result' as const,
          tool_use_id: b.id,
          content:
            b.name === 'finish_core'
              ? 'Core captured. Now produce the detailed onboarding guide by calling finish_guide. You may explore additional files first if needed.'
              : b.name === 'finish_guide'
                ? 'Guide captured.'
                : 'Skipped — proceeding to next phase.',
        }))
      ctx.messages.push({ role: 'user', content: finalResults })
      return finishBlock
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    )

    if (toolUses.length === 0) {
      // Agent produced only text — nudge it toward the finish tool.
      ctx.messages.push({ role: 'assistant', content: response.content })
      ctx.messages.push({
        role: 'user',
        content: `Please call ${ctx.finishToolName} now with your structured result.`,
      })
      continue
    }

    const budgetExceeded = ctx.counters.toolCalls >= ctx.maxToolCalls
    const toolResults: Anthropic.ToolResultBlockParam[] = []

    for (const toolUse of toolUses) {
      ctx.counters.toolCalls++
      const pathOrQuery =
        typeof toolUse.input === 'object' &&
        toolUse.input !== null &&
        'path' in toolUse.input
          ? String((toolUse.input as Record<string, unknown>).path ?? '')
          : typeof toolUse.input === 'object' &&
              toolUse.input !== null &&
              'query' in toolUse.input
            ? String((toolUse.input as Record<string, unknown>).query ?? '')
            : ''

      yield {
        type: 'thinking',
        message:
          pathOrQuery !== ''
            ? `${toolUse.name}: ${pathOrQuery}`
            : `${toolUse.name}...`,
        toolCall: toolUse.name,
        toolInput: toolUse.input as Record<string, unknown>,
      }

      const truncatedInput =
        pathOrQuery.length > 40 ? pathOrQuery.slice(0, 40) : pathOrQuery
      const toolStart = Date.now()
      let resultText: string
      if (budgetExceeded) {
        resultText = `TOOL BUDGET EXHAUSTED. Do not call any more exploration tools. Call ${ctx.finishToolName} immediately with your best result.`
      } else {
        resultText = await executeExplorationTool(
          toolUse.name,
          toolUse.input,
          ctx.discovery.tree,
          ctx.githubClient,
          ctx.repoContext,
        )
      }
      console.log(
        `[timing] tool ${toolUse.name} (${truncatedInput}) took ${Date.now() - toolStart}ms`,
      )

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: resultText,
      })
    }

    ctx.messages.push({ role: 'assistant', content: response.content })
    ctx.messages.push({ role: 'user', content: toolResults })
  }

  return null
}

export async function* analyzeWithLLMStream(
  discovery: DiscoveryResult,
  githubClient: GitHubClient,
  repoContext: { owner: string; repo: string; branch: string },
  apiKey: string,
  mode: LLMMode = 'production',
  intent?: LLMModelIntent,
): AsyncGenerator<LLMStreamEvent> {
  const client = new Anthropic({ apiKey })
  const resolvedIntent: LLMModelIntent =
    intent ?? (mode === 'development' ? 'fast' : 'quality')
  const model = INTENT_TO_MODEL[resolvedIntent]
  console.log(
    `[LLM] using ${model} (intent: ${resolvedIntent}, ` +
      `caller passed: ${intent !== undefined ? 'intent=' + intent : 'mode=' + mode})`,
  )

  const llmStart = Date.now()
  const counters = { iter: 0, toolCalls: 0 }
  console.log('[timing] llm loop start')

  // Pre-fetch top key files in parallel so the agent has immediate context
  // and doesn't burn its tool budget on obvious fetches.
  const prefetched = await prefetchTopKeyFiles(
    discovery,
    githubClient,
    repoContext,
  )
  console.log(
    `[timing] key files fetched in ${Date.now() - llmStart}ms (cumulative since llm stage start)`,
  )
  const initialUser =
    buildInitialUserPrompt(discovery) + formatPrefetchedContent(prefetched)

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: initialUser },
  ]

  // ─── PHASE 1: Core (refinedStack + executiveSummary + architectureInsights) ──
  console.log('[timing] phase 1 (core) start')
  const phase1Start = Date.now()
  const coreBlock = yield* runReactPhase({
    client,
    model,
    messages,
    finishToolName: 'finish_core',
    tools: CORE_TOOLS,
    maxToolCalls: MAX_TOOL_CALLS_CORE,
    githubClient,
    discovery,
    repoContext,
    counters,
    llmStart,
  })
  console.log(`[timing] phase 1 done in ${Date.now() - phase1Start}ms`)
  if (coreBlock === null) {
    throw new Error(
      'Phase 1 (core) exhausted iterations without producing finish_core',
    )
  }
  const corePartial = coerceCorePartial(coreBlock.input, discovery.stack)
  yield { type: 'partial_core', core: corePartial }

  // ─── PHASE 2: Guide (keyFiles + explorationPath + codebaseContext) ───────────
  console.log('[timing] phase 2 (guide) start')
  const phase2Start = Date.now()
  const guideBlock = yield* runReactPhase({
    client,
    model,
    messages,
    finishToolName: 'finish_guide',
    tools: GUIDE_TOOLS,
    maxToolCalls: MAX_TOOL_CALLS_GUIDE,
    githubClient,
    discovery,
    repoContext,
    counters,
    llmStart,
  })
  console.log(`[timing] phase 2 done in ${Date.now() - phase2Start}ms`)
  if (guideBlock === null) {
    throw new Error(
      'Phase 2 (guide) exhausted iterations without producing finish_guide',
    )
  }
  const guidePartial = coerceGuidePartial(guideBlock.input)
  yield { type: 'partial_guide', guide: guidePartial }

  const merged = mergePartials(corePartial, guidePartial)
  const normalized = normalizeLLMAnalysisResult(merged)
  console.log(
    `[timing] llm loop exit after ${counters.iter} iterations, total ${Date.now() - llmStart}ms`,
  )
  yield { type: 'result', result: normalized }
}

// ─── Non-streaming Convenience Wrapper ────────────────────────────────────────

export async function analyzeWithLLM(
  discovery: DiscoveryResult,
  githubClient: GitHubClient,
  repoContext: { owner: string; repo: string; branch: string },
  apiKey: string,
  mode: LLMMode = 'production',
  intent?: LLMModelIntent,
): Promise<LLMAnalysisResult> {
  for await (const event of analyzeWithLLMStream(
    discovery,
    githubClient,
    repoContext,
    apiKey,
    mode,
    intent,
  )) {
    if (event.type === 'result') return event.result
  }
  throw new Error('analyzeWithLLM: stream ended without producing a result')
}

export const __internal = {
  coerceCorePartial,
  coerceGuidePartial,
  filterTreeForPrompt,
}
