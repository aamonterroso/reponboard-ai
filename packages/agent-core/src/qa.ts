import Anthropic from '@anthropic-ai/sdk'
import { GitHubClient } from './github'
import {
  EXPLORATION_TOOLS,
  INTENT_TO_MODEL,
  executeExplorationTool,
  type LLMMode,
  type LLMModelIntent,
} from './llm-analysis'
import { addUsage, calculateCost, createUsageTotals } from './pricing'
import { ANTHROPIC_TIMEOUT_MS, withAnthropicRetry } from './anthropic-retry'
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

// Hard cap on exploration tool calls (fetch_file + list_directory)
// per QA turn. When the cap is hit, the agent is steered to 'respond'
// so it emits its final answer from the context it has — instead of
// being cut off mid-walk. Pattern mirrors the `finish_*` steering in
// llm-analysis.ts.
const QA_MAX_TOOL_CALLS = 4
// One extra iteration headroom for the steered-respond turn plus a
// small safety margin if the model returns text-only and has to be
// re-prompted to call respond.
const MAX_ITERATIONS = QA_MAX_TOOL_CALLS + 3
// Thinking tokens count toward max_tokens; leave room for reasoning plus
// a full markdown answer.
const QA_MAX_TOKENS = 8_000
const QA_EFFORT = 'medium' as const

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
      additionalProperties: false,
    },
    // Schema-guaranteed input: answer is always a string and
    // filesReferenced always an array.
    strict: true,
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
    const client = new Anthropic({ apiKey: anthropicApiKey, timeout: ANTHROPIC_TIMEOUT_MS })
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
    const usage = createUsageTotals()
    // Tracks whether the budget-exhausted anti-preamble nudge has
    // already been injected into the conversation. Without this flag
    // we would push the same instruction on every post-budget iteration
    // (text-only retry loops) and accumulate duplicates in `messages`.
    let forcedGuidanceInjected = false
    let emptyAnswerRetried = false

    while (iteration < MAX_ITERATIONS) {
      iteration++

      // When the exploration budget is exhausted, steer the next call to
      // `respond`. Forced tool_choice returns a 400 on Sonnet 5.5, so this
      // is an operator instruction appended as a mid-conversation system
      // message (append-only keeps the cached prefix valid), and any
      // exploration call that still arrives gets a budget-exhausted result
      // instead of running.
      const isBudgetExhausted = toolCallCount >= QA_MAX_TOOL_CALLS
      if (isBudgetExhausted) {
        if (telemetry !== undefined) {
          telemetry.toolBudgetExhausted = true
        }
        // Spelling out that there are NO more turns stops the model from
        // putting a transitional preamble ("let me look at the source
        // code before answering") in respond.answer.
        if (!forcedGuidanceInjected) {
          console.log('[qa] tool budget exhausted; steering to respond')
          messages.push({
            role: 'system',
            content:
              'TOOL BUDGET EXHAUSTED. You have NO more turns. Call respond ' +
              'NOW with whatever substance you already learned. Do NOT ' +
              'announce next steps ("let me look at...", "I\'ll check...") ' +
              'and do NOT say you will examine anything. If you genuinely ' +
              'lack enough information to answer, say so plainly in one ' +
              'sentence as respond.answer and stop.',
          })
          forcedGuidanceInjected = true
        }
      }

      // Parallel tool use is OFF on every call: the model returns at most
      // one tool_use per response, which makes QA_MAX_TOOL_CALLS an actual
      // hard cap on file fetches.
      const response = await withAnthropicRetry(() =>
        client.messages.create({
          model,
          max_tokens: QA_MAX_TOKENS,
          cache_control: { type: 'ephemeral' },
          system,
          tools: QA_TOOLS,
          messages,
          tool_choice: { type: 'auto', disable_parallel_tool_use: true },
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: QA_EFFORT },
        }),
      )

      addUsage(usage, response.usage)

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
        const answer = typeof input.answer === 'string' ? input.answer.trim() : ''

        // A post-budget `respond` can arrive with an empty answer
        // when the model burned its budget without learning anything
        // useful. Give it one corrective turn; if it still comes back
        // empty, fall through to the canned fallback below instead of
        // shipping a blank bubble to the UI.
        if (answer === '') {
          if (emptyAnswerRetried) break
          emptyAnswerRetried = true
          if (telemetry !== undefined) {
            telemetry.emptyAnswerRetried = true
          }
          messages.push({ role: 'assistant', content: response.content })
          messages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: respondBlock.id,
                is_error: true,
                content:
                  'respond.answer was empty. Call respond again with a ' +
                  'non-empty answer built from what you already learned. ' +
                  'If you cannot answer, say so plainly in one sentence.',
              },
            ],
          })
          continue
        }

        const result: QAResult = {
          answer,
          // Dedupe in case the LLM repeats file paths — avoids React
          // duplicate-key warnings in the chat UI.
          filesReferenced: Array.from(new Set(rawFiles)),
          costUsd: calculateCost(model, usage),
        }
        yield { phase: 'complete', result }
        return
      }

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      )

      if (toolUses.length === 0) {
        // Agent responded with text only — nudge toward respond. Spell
        // out the anti-preamble guidance: under budget pressure the
        // model sometimes emits "Let me look at..." as text instead of
        // calling respond. Make explicit that there are no more turns.
        messages.push({ role: 'assistant', content: response.content })
        messages.push({
          role: 'user',
          content:
            'Call the respond tool NOW with your final answer based on what ' +
            'you already learned. Do NOT announce next steps or say you ' +
            'will look at anything — there are no more turns. If you lack ' +
            'the information to answer, say so plainly in respond.answer ' +
            'and stop.',
        })
        continue
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = []

      for (const toolUse of toolUses) {
        // Post-budget calls are answered without running. They emit no
        // thinking event, so the route's fetched-files set (used by the
        // hallucination validator) only holds files actually read.
        if (isBudgetExhausted) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content:
              'TOOL BUDGET EXHAUSTED. Do not call any more tools except respond.',
          })
          continue
        }

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

        const resultText = await executeExplorationTool(
          toolUse.name,
          toolUse.input,
          tree,
          githubClient,
          repoContext,
        )

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

    // Safety fallback: agent never called respond() with a usable answer
    // within the iteration cap.
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
        costUsd: calculateCost(model, usage),
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    yield { phase: 'error', error: message }
  }
}
