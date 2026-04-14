import Anthropic from '@anthropic-ai/sdk'
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
  // cap at 400 entries to keep prompt manageable
  return filtered
    .slice(0, 400)
    .map((node) => `${node.type === 'tree' ? 'd' : 'f'} ${node.path}`)
    .join('\n')
}

// ─── Prompt Construction ──────────────────────────────────────────────────────

function buildUserPrompt(
  discoveryResult: DiscoveryResult,
  fileContents: Map<string, string>
): string {
  const { repoInfo, stack, repoType, entryPoints, keyFiles } = discoveryResult

  const repoMeta = [
    `Repository: ${repoInfo.fullName}`,
    `Description: ${repoInfo.description ?? 'No description'}`,
    `Stars: ${repoInfo.stars}`,
    `Primary Language: ${repoInfo.language ?? 'Unknown'}`,
    `Topics: ${repoInfo.topics.join(', ') || 'None'}`,
    `License: ${repoInfo.license ?? 'None'}`,
    `Size: ${repoInfo.size} KB`,
    `Created: ${repoInfo.createdAt}`,
    `Updated: ${repoInfo.updatedAt}`,
  ].join('\n')

  const heuristicGuess = `## Heuristic Analysis (Layer 1 — treat as a starting hypothesis)
Runtime: ${stack.runtime}
Framework: ${stack.framework}
Language: ${stack.language}
Category: ${stack.category}
Package Manager: ${stack.packageManager}
Additional Libraries: ${stack.additionalLibraries.join(', ') || 'None'}
Has Tests: ${stack.hasTests} | Has Docker: ${stack.hasDocker} | Has CI: ${stack.hasCi}
Detection Confidence: ${stack.confidence}

Repo Type: ${repoType.type} (confidence: ${repoType.confidence}) — ${repoType.reason}

Entry Points:
${entryPoints.map((ep) => `- ${ep.path} (${ep.kind}): ${ep.reason}`).join('\n') || '- None detected'}

Key Files (heuristic):
${keyFiles.map((kf) => `- ${kf.path} [${kf.role}, ${kf.importance}]: ${kf.reason}`).join('\n') || '- None detected'}`

  const treeSection = `## Repository Tree (condensed, excluding build artifacts)
\`\`\`
${buildCondensedTree(discoveryResult.tree)}
\`\`\``

  const fileSection =
    fileContents.size > 0
      ? `## Key File Contents\n\n${Array.from(fileContents.entries())
          .map(([path, content]) => {
            const body =
              content.length > 4000 ? content.slice(0, 4000) + '\n... (truncated)' : content
            return `### ${path}\n\`\`\`\n${body}\n\`\`\``
          })
          .join('\n\n')}`
      : '## Key File Contents\n(No file contents provided)'

  return `${repoMeta}\n\n${heuristicGuess}\n\n${treeSection}\n\n${fileSection}`
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert software engineer specializing in codebase analysis and developer onboarding. Analyze the provided GitHub repository and return a single JSON object — no markdown, no explanation, just the JSON.

The JSON must match this exact structure:

{
  "refinedStack": {
    "runtime": "<nodejs|deno|bun|python|go|rust|java|dotnet|ruby|php|unknown>",
    "framework": "<nextjs|react|vue|svelte|angular|nuxt|astro|remix|express|fastify|nestjs|hono|django|fastapi|flask|gin|echo|axum|spring|unknown>",
    "language": "<typescript|javascript|python|go|rust|java|csharp|ruby|php|unknown>",
    "category": "<frontend|backend|fullstack|mobile|cli|library|monorepo|unknown>",
    "packageManager": "<npm|pnpm|yarn|bun|pip|cargo|go|maven|gradle|unknown>",
    "hasTests": boolean,
    "hasDocker": boolean,
    "hasCi": boolean,
    "additionalLibraries": ["string"],
    "confidence": number,
    "reasoning": "string — why you concluded this stack, referencing specific files or patterns"
  },
  "executiveSummary": {
    "oneLiner": "string — one sentence describing the project",
    "overview": "string — 2-3 paragraphs: what it does, how it works, and why it exists",
    "targetAudience": "string — who would use or contribute to this project"
  },
  "architectureInsights": {
    "pattern": "<monolith|microservices|monorepo|mvc|layered|event-driven|serverless|jamstack|library|unknown>",
    "keyDirectories": [
      { "path": "string", "purpose": "string — what this directory contains and why it exists" }
    ],
    "designDecisions": [
      { "title": "string", "description": "string — a notable architectural choice and its rationale" }
    ]
  },
  "keyFiles": [
    {
      "path": "string",
      "whatItDoes": "string — concrete description of what this file does",
      "whyImportant": "string — why a new developer should read this file first",
      "category": "<entry-point|core-logic|configuration|infrastructure|data-model|utilities|tests|documentation>"
    }
  ],
  "explorationPath": [
    {
      "order": number,
      "title": "string",
      "description": "string — what to focus on in this step",
      "files": ["string"],
      "estimatedMinutes": number
    }
  ],
  "codebaseContext": "string — a dense 2-3 paragraph summary of the entire codebase written to serve as context for answering follow-up questions. Reference actual file names, patterns, and design choices."
}

Be specific and concrete. Reference actual file names, function names, and patterns you observe. Avoid generic boilerplate descriptions.`

// ─── JSON Parsing ─────────────────────────────────────────────────────────────

function parseResponse(text: string): LLMAnalysisResult {
  const stripped = text.trim()
  // handle responses wrapped in markdown code fences
  const fenceMatch = stripped.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonText = fenceMatch?.[1]?.trim() ?? stripped
  return JSON.parse(jsonText) as LLMAnalysisResult
}

// ─── Main Function ────────────────────────────────────────────────────────────

export async function analyzeWithLLM(
  discoveryResult: DiscoveryResult,
  fileContents: Map<string, string>,
  apiKey: string
): Promise<LLMAnalysisResult> {
  const client = new Anthropic({ apiKey })
  const userPrompt = buildUserPrompt(discoveryResult, fileContents)

  async function attempt(): Promise<LLMAnalysisResult> {
    console.log('[LLM] Calling Claude API...')

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    })

    console.log('[LLM] Response received, length:', message.content.find((b) => b.type === 'text')?.text?.length)

    const textBlock = message.content.find((block) => block.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Claude returned no text content')
    }

    return parseResponse(textBlock.text)
  }

  try {
    return await attempt()
  } catch {
    // retry once on JSON parse failure or transient error
    try {
      return await attempt()
    } catch (secondError) {
      console.error('[LLM] Parse error:', secondError)
      const msg = secondError instanceof Error ? secondError.message : String(secondError)
      throw new Error(`analyzeWithLLM failed after 2 attempts. Last error: ${msg}`)
    }
  }
}
