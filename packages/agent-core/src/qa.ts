import Anthropic from '@anthropic-ai/sdk'
import { GitHubClient } from './github'
import {
  EXPLORATION_TOOLS,
  executeExplorationTool,
  type LLMMode,
} from './llm-analysis'
import type {
  GitHubTreeNode,
  QAMessage,
  QAProgressEvent,
  QAResult,
} from './types'

// Excluded path segments (matches llm-analysis internal list)
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

function buildTreeSummary(tree: GitHubTreeNode[]): string {
  const filtered = tree
    .filter(
      (n) => !n.path.split('/').some((seg) => EXCLUDED_SEGMENTS.has(seg)),
    )
    .slice(0, 300)
    .map((n) => `${n.type === 'tree' ? 'd' : 'f'} ${n.path}`)
  return filtered.join('\n')
}

// ─── Model Configuration ──────────────────────────────────────────────────────

const MODELS = {
  development: 'claude-haiku-4-5-20251001',
  production: 'claude-sonnet-4-20250514',
} as const

const MAX_TOOL_CALLS = 3
const MAX_ITERATIONS = MAX_TOOL_CALLS + 3

// ─── Tool Schema ──────────────────────────────────────────────────────────────

const QA_TOOLS: Anthropic.Tool[] = [
  ...EXPLORATION_TOOLS,
  {
    name: 'respond',
    description:
      'Submit your final answer to the user. This terminates the loop. Include the files you referenced so the UI can link them.',
    input_schema: {
      type: 'object',
      properties: {
        answer: {
          type: 'string',
          description:
            'Your answer to the user\'s question. Use markdown sparingly — prefer short paragraphs.',
        },
        filesReferenced: {
          type: 'array',
          items: { type: 'string' },
          description:
            'File paths you used to inform your answer (empty array if none).',
        },
      },
      required: ['answer', 'filesReferenced'],
    },
  },
]

// ─── System Prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(
  analysisContext: string,
  treeSummary: string,
): string {
  return `You are an expert software engineer helping a developer understand a GitHub repository they are onboarding to.

You have tools to explore the codebase:
- fetch_file: read file contents (first 4000 chars). Use EXACT paths from the tree below.
- list_directory: list files in a directory (use "" for root)
- search_code: find files by path substring (optionally filter by extension like ".ts")
- respond: submit your final answer (TERMINATES the loop)

Process:
1. Use the tree below to find exact paths — do NOT guess at paths.
2. Fetch 1-3 files that are most relevant to the question before answering.
3. Ground your answer in what you actually read — quote or reference specific paths.
4. Call respond with a concise, specific answer and the files you referenced.

You have a budget of ~5 tool calls. Be efficient.

IMPORTANT: You MUST call respond() within your tool budget. After 3 tool calls, you must call respond() with whatever you have found — even if incomplete. Never exhaust the budget without calling respond().

Background context about this repository (from initial onboarding analysis):
${analysisContext}

## Repository Tree (condensed)
\`\`\`
${treeSummary}
\`\`\``
}

// ─── Main Q&A Generator ───────────────────────────────────────────────────────

export async function* answerQuestion(
  question: string,
  repoContext: { owner: string; repo: string; branch: string },
  analysisContext: string,
  history: QAMessage[],
  anthropicApiKey: string,
  githubToken?: string,
  mode: LLMMode = 'production',
): AsyncGenerator<QAProgressEvent> {
  try {
    const client = new Anthropic({ apiKey: anthropicApiKey })
    const githubClient = new GitHubClient(githubToken)
    const model = MODELS[mode]

    // Fetch tree once so exploration tools can reference it without extra API calls
    const tree = await githubClient.getTree(
      repoContext.owner,
      repoContext.repo,
      repoContext.branch,
    )

    const system = buildSystemPrompt(analysisContext, buildTreeSummary(tree))

    const messages: Anthropic.MessageParam[] = []

    // Replay conversation history as alternating user/assistant text
    for (const msg of history) {
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
      })
    }

    messages.push({ role: 'user', content: question })

    let toolCallCount = 0
    let iteration = 0

    while (iteration < MAX_ITERATIONS) {
      iteration++

      const response = await client.messages.create({
        model,
        max_tokens: 2048,
        system,
        tools: QA_TOOLS,
        messages,
      })

      // respond is the terminal tool
      const respondBlock = response.content.find(
        (b): b is Anthropic.ToolUseBlock =>
          b.type === 'tool_use' && b.name === 'respond',
      )
      if (respondBlock !== undefined) {
        const input = respondBlock.input as {
          answer?: unknown
          filesReferenced?: unknown
        }
        const rawFiles = Array.isArray(input.filesReferenced)
          ? input.filesReferenced.filter(
              (f): f is string => typeof f === 'string',
            )
          : []
        const result: QAResult = {
          answer: typeof input.answer === 'string' ? input.answer : '',
          // Dedupe in case the LLM repeats file paths — avoids React
          // duplicate-key warnings in the chat UI.
          filesReferenced: Array.from(new Set(rawFiles)),
        }
        yield { phase: 'complete', result }
        return
      }

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      )

      if (toolUses.length === 0) {
        // Agent responded with text only — nudge toward respond
        messages.push({ role: 'assistant', content: response.content })
        messages.push({
          role: 'user',
          content:
            'Please call the respond tool now with your final answer.',
        })
        continue
      }

      const budgetExceeded = toolCallCount >= MAX_TOOL_CALLS
      const toolResults: Anthropic.ToolResultBlockParam[] = []

      for (const toolUse of toolUses) {
        toolCallCount++
        const inp = toolUse.input as Record<string, unknown>
        const label =
          typeof inp?.path === 'string'
            ? inp.path
            : typeof inp?.query === 'string'
              ? inp.query
              : ''

        yield {
          phase: 'thinking',
          message: label !== '' ? `${toolUse.name}: ${label}` : toolUse.name,
          toolCall: toolUse.name,
          toolInput: inp,
        }

        let resultText: string
        if (budgetExceeded) {
          resultText =
            'TOOL BUDGET EXHAUSTED. Call respond now with your best answer.'
        } else {
          resultText = await executeExplorationTool(
            toolUse.name,
            toolUse.input,
            tree,
            githubClient,
            repoContext,
          )
        }

        yield {
          phase: 'tool_result',
          tool: toolUse.name,
          summary: resultText.slice(0, 120),
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

    // Safety fallback: agent never called respond() within the iteration cap.
    // Emit a graceful complete event so the UI shows a message rather than
    // surfacing a raw error to the user.
    yield {
      phase: 'complete',
      result: {
        answer:
          'I explored the codebase but ran out of tool calls to answer fully. Try rephrasing your question.',
        filesReferenced: [],
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    yield { phase: 'error', error: message }
  }
}
