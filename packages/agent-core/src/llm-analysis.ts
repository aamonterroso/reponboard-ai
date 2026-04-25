import Anthropic from '@anthropic-ai/sdk'
import { GitHubClient } from './github'
import type { DiscoveryResult, LLMAnalysisResult } from './types'

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

You have a budget of ~10 tool calls. Be efficient. Don't fetch files you won't use.

Quality guidelines for finish_analysis:
- Be specific and concrete. Reference actual file names, function names, and patterns you observed via tools.
- codebaseContext should be a dense 2-3 paragraph summary to serve as background for follow-up questions.
- Size caps: keyFiles ≤ 10, explorationPath ≤ 5, keyDirectories ≤ 6, designDecisions ≤ 4, additionalLibraries ≤ 8.
- All description fields: max 2 sentences each.
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
        pattern: { type: 'string' },
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
      required: ['pattern', 'keyDirectories', 'designDecisions'],
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

const MAX_TOOL_CALLS = 10

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

// Anthropic sometimes returns tool_use inputs that don't fully match the schema.
// Validate the shape so the frontend never receives a partially-populated
// LLMAnalysisResult (which caused runtime crashes like "Cannot read properties
// of undefined (reading 'runtime')").
function assertValidLLMAnalysisResult(
  value: unknown,
): asserts value is LLMAnalysisResult {
  if (typeof value !== 'object' || value === null) {
    throw new Error('finish_analysis returned non-object')
  }
  const v = value as Record<string, unknown>

  const requiredTop = [
    'refinedStack',
    'executiveSummary',
    'architectureInsights',
    'keyFiles',
    'explorationPath',
    'codebaseContext',
  ] as const
  for (const key of requiredTop) {
    if (v[key] === undefined || v[key] === null) {
      throw new Error(`finish_analysis missing required field: ${key}`)
    }
  }

  const rs = v.refinedStack as Record<string, unknown>
  const rsRequired = [
    'runtime',
    'framework',
    'language',
    'category',
    'packageManager',
    'confidence',
  ] as const
  for (const key of rsRequired) {
    if (rs[key] === undefined || rs[key] === null) {
      throw new Error(`finish_analysis.refinedStack missing field: ${key}`)
    }
  }

  const es = v.executiveSummary as Record<string, unknown>
  if (typeof es.oneLiner !== 'string' || typeof es.overview !== 'string') {
    throw new Error('finish_analysis.executiveSummary is malformed')
  }

  const ai = v.architectureInsights as Record<string, unknown>
  if (
    typeof ai.pattern !== 'string' ||
    !Array.isArray(ai.keyDirectories) ||
    !Array.isArray(ai.designDecisions)
  ) {
    throw new Error('finish_analysis.architectureInsights is malformed')
  }

  if (!Array.isArray(v.keyFiles) || !Array.isArray(v.explorationPath)) {
    throw new Error('finish_analysis.keyFiles/explorationPath must be arrays')
  }
}

// Dedupe arrays to prevent React "duplicate key" warnings when the LLM
// repeats entries (observed with keyDirectories returning the same path twice).
function normalizeLLMAnalysisResult(
  result: LLMAnalysisResult,
): LLMAnalysisResult {
  const insights = result.architectureInsights
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
  const initialUser = buildInitialUserPrompt(discovery)

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
      assertValidLLMAnalysisResult(finishBlock.input)
      const normalized = normalizeLLMAnalysisResult(finishBlock.input)
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
