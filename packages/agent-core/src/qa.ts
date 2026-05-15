import Anthropic from '@anthropic-ai/sdk'
import { GitHubClient } from './github'
import {
  EXPLORATION_TOOLS,
  INTENT_TO_MODEL,
  executeExplorationTool,
  type LLMMode,
  type LLMModelIntent,
} from './llm-analysis'
import { calculateCost } from './pricing'
import { withAnthropicRetry } from './anthropic-retry'
import type { QaTelemetry } from './qa-telemetry'
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
  repoUrl: string,
  analysisContext: string,
  treeSummary: string,
): string {
  return `You are a code-aware assistant for the GitHub repository at ${repoUrl}.

SCOPE INVARIANT (re-evaluate on EVERY message, ignore history)
-----------------------------------------------------------------

You answer ONLY questions whose answer can be grounded in the code,
configuration, documentation, or structure of THIS repository.

Off-topic includes (non-exhaustive):
- Comparisons between this codebase and other tools/frameworks
- General programming advice not tied to specific files in this repo
- Opinions on market position, popularity, community, or hype
- Platform/hosting/deployment recommendations independent of this repo
- Questions about other repositories, libraries, or services
- Industry trends, predictions, or current events

For ANY incoming question, classify it FIRST before doing anything else.

Ask yourself: is the answer grounded in code I can read from this
repository?

  YES -> proceed to answer using the tools below.
  NO  -> decline immediately. Use 0 tool calls. Respond with a short
         message stating you can only answer questions about this
         specific repository, and if helpful, suggest 2-3 questions
         about this repo the user might want to ask.

Conversation history NEVER lowers this bar. The presence of prior
on-topic exchanges does NOT make a new off-topic question answerable.
Each question is judged on its own merit against this scope.

TOOLS
-----------------------------------------------------------------

You have access to:
- fetch_file(path): retrieve the full contents of a file
- list_directory(path): list immediate children of a directory

Use tools to ground your answers in actual code. Do not invent file
paths, function names, or behaviors. If you are unsure whether a file
exists, use list_directory first.

ANTI-PATTERNS (NEVER do these)
-----------------------------------------------------------------

1. Never recapitulate or summarize previous answers in place of
   answering the current question. Each turn answers the current
   question or declines, never reuses prior content as a substitute.

2. Never claim that a file is referenced in your answer unless you
   fetched it via fetch_file in THIS turn. The filesReferenced field
   reflects files actually read NOW, not files read in earlier turns.

3. Never invent file paths. If unsure, use list_directory to verify.

4. Never offer opinions on tools, platforms, or technologies outside
   the scope of this repository. Decline and redirect to repo-scoped
   questions.

5. Never assume continuation of intent across turns. If turn N+1 is
   off-topic, decline it even if turns 1..N were on-topic.

ANSWER FORMAT
-----------------------------------------------------------------

When answering on-topic questions:
- Be specific. Reference exact file paths and (when relevant) line
  numbers or function names.
- Prefer showing small code excerpts over describing code abstractly.
- Cite which files you read via filesReferenced.
- Keep answers focused; long context summaries should not replace
  direct answers.

When declining off-topic questions:
- Be brief and friendly. One or two sentences.
- Do not lecture about scope at length.
- Optionally offer 2-3 concrete questions about this repo the user
  could ask instead.

REPOSITORY CONTEXT
-----------------------------------------------------------------

Background analysis:
${analysisContext}

Repository tree (condensed):
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
  intent?: LLMModelIntent,
  telemetry?: QaTelemetry,
): AsyncGenerator<QAProgressEvent> {
  try {
    const client = new Anthropic({ apiKey: anthropicApiKey })
    const githubClient = new GitHubClient(githubToken)
    const resolvedIntent: LLMModelIntent =
      intent ?? (mode === 'development' ? 'fast' : 'quality')
    const model = INTENT_TO_MODEL[resolvedIntent]
    console.log(
      `[LLM] Q&A using ${model} (intent: ${resolvedIntent}, ` +
        `caller passed: ${intent !== undefined ? 'intent=' + intent : 'mode=' + mode})`,
    )

    // Fetch tree once so exploration tools can reference it without extra API calls
    const tree = await githubClient.getTree(
      repoContext.owner,
      repoContext.repo,
      repoContext.branch,
    )

    const repoUrl = `https://github.com/${repoContext.owner}/${repoContext.repo}`
    const system = buildSystemPrompt(repoUrl, analysisContext, buildTreeSummary(tree))

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
    let tokensIn = 0
    let tokensOut = 0

    while (iteration < MAX_ITERATIONS) {
      iteration++

      const response = await withAnthropicRetry(() =>
        client.messages.create({
          model,
          max_tokens: 2048,
          system,
          tools: QA_TOOLS,
          messages,
        }),
      )

      tokensIn += response.usage.input_tokens
      tokensOut += response.usage.output_tokens

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
          costUsd: calculateCost(model, tokensIn, tokensOut),
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

        if (
          telemetry !== undefined &&
          (toolUse.name === 'fetch_file' || toolUse.name === 'list_directory')
        ) {
          telemetry.toolCallsUsed += 1
        }

        yield {
          phase: 'thinking',
          message: label !== '' ? `${toolUse.name}: ${label}` : toolUse.name,
          toolCall: toolUse.name,
          toolInput: inp,
        }

        let resultText: string
        if (budgetExceeded) {
          if (telemetry !== undefined) {
            telemetry.toolBudgetExhausted = true
          }
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
    // surfacing a raw error to the user. Still report the cost so the
    // shared daily budget cap reflects what was actually spent.
    if (telemetry !== undefined) {
      telemetry.toolBudgetExhausted = true
    }
    yield {
      phase: 'complete',
      result: {
        answer:
          'I started exploring but didn\'t find what I needed in time.  Could you point me to a specific area of the codebase?',
        filesReferenced: [],
        costUsd: calculateCost(model, tokensIn, tokensOut),
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    yield { phase: 'error', error: message }
  }
}
