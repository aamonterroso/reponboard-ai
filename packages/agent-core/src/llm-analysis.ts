import Anthropic from '@anthropic-ai/sdk'
import { GitHubClient } from './github'
import type { DetectedStack, DiscoveryResult, LLMAnalysisResult } from './types'

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

function buildCondensedTree(tree: DiscoveryResult['tree']): string {
  const filtered = tree.filter(
    (node) => !node.path.split('/').some((seg) => EXCLUDED_SEGMENTS.has(seg))
  )
  return filtered
    .slice(0, 400)
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

  return `${repoMeta}\n\n${heuristicGuess}\n\n${treeSection}\n\nYou have tools to explore this codebase. Call \`fetch_file\` to read specific files (entry points, key configs, main modules). Call \`list_directory\` to explore unfamiliar areas. Call \`search_code\` to find files by name pattern. When you have enough context to produce a thorough onboarding guide, call \`finish_analysis\` with the structured result.`
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert software engineer specializing in codebase analysis and developer onboarding.

You have tools to explore a GitHub repository. Use them to gather evidence before drawing conclusions:
- fetch_file: read a file's contents (first 4000 chars)
- list_directory: list files in a directory
- search_code: find files by path substring
- finish_analysis: submit the final structured onboarding analysis (TERMINATES the loop)

Strategy:
1. Start by reading 2-4 critical files (entry points, main config, root README)
2. Explore key directories if unclear
3. Once you understand the project, call finish_analysis

You have a budget of ~5 tool calls. The most important files are pre-loaded for you in the user message — do not refetch them. Use your tool calls only for files/directories you genuinely need but haven't seen yet.

Quality guidelines for finish_analysis:
- Be specific and concrete. Reference actual file names, function names, and patterns you observed via tools.
- codebaseContext should be a dense 2-3 paragraph summary to serve as background for follow-up questions.
- Size caps: keyFiles ≤ 10, explorationPath ≤ 5, keyDirectories ≤ 6, designDecisions ≤ 4, additionalLibraries ≤ 8.
- All description fields: max 2 sentences each.
- For architectureInsights.pattern: pick exactly ONE slug from the enum (monolith, microservices, monorepo, mvc, layered, event-driven, serverless, jamstack, library, unknown). Do NOT write a sentence here. Use architectureInsights.patternDescription for the rich 1-2 sentence description of the architecture style.
- Prioritize quality over quantity.`

// ─── Tool Schemas ─────────────────────────────────────────────────────────────

// JSON-schema for the finish_analysis tool — mirrors LLMAnalysisResult
const FINISH_ANALYSIS_SCHEMA: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    refinedStack: {
      type: 'object',
      properties: {
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
      },
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
        overview: { type: 'string' },
        targetAudience: { type: 'string' },
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
            'A 1-2 sentence rich description of the architecture (e.g. "Monorepo with two-layer analysis pipeline: heuristic discovery feeds an LLM refinement layer, exposed via a Next.js streaming API."). This is the descriptive text shown to the user as a subtitle.',
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
    keyFiles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          whatItDoes: { type: 'string' },
          whyImportant: { type: 'string' },
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
          description: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          estimatedMinutes: { type: 'number' },
        },
        required: ['order', 'title', 'description', 'files', 'estimatedMinutes'],
      },
    },
    codebaseContext: { type: 'string' },
  },
  required: [
    'refinedStack',
    'executiveSummary',
    'architectureInsights',
    'keyFiles',
    'explorationPath',
    'codebaseContext',
  ],
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

const ANALYSIS_TOOLS: Anthropic.Tool[] = [
  ...EXPLORATION_TOOLS,
  {
    name: 'finish_analysis',
    description:
      'Submit the final structured onboarding analysis. Call ONLY when you have enough context. This terminates the loop.',
    input_schema: FINISH_ANALYSIS_SCHEMA,
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

// ─── Streaming Events ─────────────────────────────────────────────────────────

export type LLMStreamEvent =
  | {
      type: 'thinking'
      message: string
      toolCall?: string
      toolInput?: Record<string, unknown>
    }
  | { type: 'result'; result: LLMAnalysisResult }

const MAX_TOOL_CALLS = 5

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
// (e.g. omitting top-level fields when under MAX_TOOL_CALLS pressure). Instead
// of throwing — which kills the whole analysis — coerce the result into a
// fully-shaped LLMAnalysisResult by filling missing fields with sensible
// fallbacks (heuristic discovery data where applicable, empty defaults
// otherwise). Only throw if the LLM returned no object at all.
function coerceLLMAnalysisResult(
  value: unknown,
  discoveryStack: DetectedStack,
): LLMAnalysisResult {
  if (typeof value !== 'object' || value === null) {
    throw new Error('finish_analysis returned non-object')
  }
  const v = value as Record<string, unknown>

  // Step B — refinedStack
  let refinedStack: LLMAnalysisResult['refinedStack']
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

  // Step C — executiveSummary
  let executiveSummary: LLMAnalysisResult['executiveSummary']
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

  // Step D — architectureInsights
  let architectureInsights: LLMAnalysisResult['architectureInsights']
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
        ? (ai.keyDirectories as LLMAnalysisResult['architectureInsights']['keyDirectories'])
        : [],
      designDecisions: Array.isArray(ai.designDecisions)
        ? (ai.designDecisions as LLMAnalysisResult['architectureInsights']['designDecisions'])
        : [],
    }
  }

  // Step E — keyFiles
  let keyFiles: LLMAnalysisResult['keyFiles']
  if (!Array.isArray(v.keyFiles)) {
    console.warn('[LLM] keyFiles missing, defaulting to []')
    keyFiles = []
  } else {
    keyFiles = v.keyFiles as LLMAnalysisResult['keyFiles']
  }

  // Step F — explorationPath
  let explorationPath: LLMAnalysisResult['explorationPath']
  if (!Array.isArray(v.explorationPath)) {
    console.warn('[LLM] explorationPath missing, defaulting to []')
    explorationPath = []
  } else {
    explorationPath = v.explorationPath as LLMAnalysisResult['explorationPath']
  }

  // Step G — codebaseContext
  const codebaseContext =
    typeof v.codebaseContext === 'string' ? v.codebaseContext : ''

  return {
    refinedStack,
    executiveSummary,
    architectureInsights,
    keyFiles,
    explorationPath,
    codebaseContext,
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

export async function* analyzeWithLLMStream(
  discovery: DiscoveryResult,
  githubClient: GitHubClient,
  repoContext: { owner: string; repo: string; branch: string },
  apiKey: string,
  mode: LLMMode = 'production',
): AsyncGenerator<LLMStreamEvent> {
  const client = new Anthropic({ apiKey })
  const model = MODELS[mode]

  // Pre-fetch top key files in parallel so the agent has immediate context
  // and doesn't burn its tool budget on obvious fetches.
  const prefetched = await prefetchTopKeyFiles(
    discovery,
    githubClient,
    repoContext,
  )
  const initialUser =
    buildInitialUserPrompt(discovery) + formatPrefetchedContent(prefetched)

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: initialUser },
  ]

  let toolCallCount = 0
  let loopIteration = 0
  const MAX_ITERATIONS = MAX_TOOL_CALLS + 3 // allow a couple extra for post-budget finish

  while (loopIteration < MAX_ITERATIONS) {
    loopIteration++

    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: ANALYSIS_TOOLS,
      messages,
    })

    // Check for finish_analysis first — that's the terminal signal
    const finishBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === 'tool_use' && b.name === 'finish_analysis',
    )
    if (finishBlock !== undefined) {
      yield {
        type: 'thinking',
        message: 'Finalizing analysis...',
        toolCall: 'finish_analysis',
      }
      // Validate the tool input matches the expected schema before handing it
      // to the UI. Throws on malformed results so the caller can fall back to
      // discovery-only output instead of rendering a broken page.
      const coerced = coerceLLMAnalysisResult(finishBlock.input, discovery.stack)
      const normalized = normalizeLLMAnalysisResult(coerced)
      yield { type: 'result', result: normalized }
      return
    }

    // Collect exploration tool calls
    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    )

    if (toolUses.length === 0) {
      // Agent gave only text — nudge it toward finish_analysis
      messages.push({ role: 'assistant', content: response.content })
      messages.push({
        role: 'user',
        content:
          'Please call finish_analysis now with your structured onboarding analysis.',
      })
      continue
    }

    const budgetExceeded = toolCallCount >= MAX_TOOL_CALLS
    const toolResults: Anthropic.ToolResultBlockParam[] = []

    for (const toolUse of toolUses) {
      toolCallCount++
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

      let resultText: string
      if (budgetExceeded) {
        resultText =
          'TOOL BUDGET EXHAUSTED. Do not call any more exploration tools. Call finish_analysis immediately with your best analysis.'
      } else {
        resultText = await executeExplorationTool(
          toolUse.name,
          toolUse.input,
          discovery.tree,
          githubClient,
          repoContext,
        )
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: resultText,
      })
    }

    messages.push({ role: 'assistant', content: response.content })
    messages.push({ role: 'user', content: toolResults })
  }

  throw new Error(
    `Analysis exceeded max ${MAX_ITERATIONS} loop iterations without calling finish_analysis`,
  )
}

// ─── Non-streaming Convenience Wrapper ────────────────────────────────────────

export async function analyzeWithLLM(
  discovery: DiscoveryResult,
  githubClient: GitHubClient,
  repoContext: { owner: string; repo: string; branch: string },
  apiKey: string,
  mode: LLMMode = 'production',
): Promise<LLMAnalysisResult> {
  for await (const event of analyzeWithLLMStream(
    discovery,
    githubClient,
    repoContext,
    apiKey,
    mode,
  )) {
    if (event.type === 'result') return event.result
  }
  throw new Error('analyzeWithLLM: stream ended without producing a result')
}
