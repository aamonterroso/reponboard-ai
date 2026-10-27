import Anthropic from '@anthropic-ai/sdk'
import { calculateCost } from './pricing'
import { ANTHROPIC_TIMEOUT_MS, withAnthropicRetry } from './anthropic-retry'

export interface ClassificationResult {
  classification: 'on_topic' | 'off_topic' | 'needs_clarification'
  confidence: number
  reasoning: string
  suggestions?: string[]
}

export interface ClassifyOutput {
  result: ClassificationResult
  latencyMs: number
  degradedMode: boolean
  costUsd: number
}

const MODEL = 'claude-haiku-5-5'

// Structured output: the API constrains the response to this schema, so
// the reply is always parseable JSON. `parseClassificationResult` still
// validates ranges (structured outputs don't support min/max).
const CLASSIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    classification: {
      type: 'string',
      enum: ['on_topic', 'off_topic', 'needs_clarification'],
    },
    confidence: { type: 'number' },
    reasoning: { type: 'string' },
    suggestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['classification', 'confidence', 'reasoning', 'suggestions'],
  additionalProperties: false,
} as const

const SYSTEM_PROMPT = `You are a question classifier for a code-aware assistant.

The assistant only answers questions grounded in a specific GitHub
repository's code, configuration, documentation, or structure.

Given a question and a repository URL (optionally with a short
summary), classify the question into exactly one of three categories:

- on_topic: the question can be answered by reading files in this
  repository.
- off_topic: the question is about something else (other tools,
  general advice, opinions on platforms, industry trends, etc).
- needs_clarification: the question is ambiguous; could be either
  on_topic or off_topic depending on intent.

Set "confidence" between 0.0 and 1.0 and keep "reasoning" to one or
two sentences.

Fill "suggestions" ONLY when classification is "off_topic": 2-3
concrete questions about this specific repository that the user might
ask instead. Use an empty array for on_topic and needs_clarification.`

// Fail-OPEN degraded result: when the classifier itself cannot run
// (network/upstream failure, timeout, malformed JSON), we let the
// question through to the main QA agent rather than rejecting the user.
// The main agent has its own SCOPE INVARIANT guardrail. The classifier
// is only a cost optimization, not the single line of defense.
const FAIL_OPEN_RESULT: ClassificationResult = {
  classification: 'on_topic',
  confidence: 0,
  reasoning:
    'Classifier unavailable; falling through to main QA agent (fail-open). The main agent enforces repo-scope on its own.',
}

function makeDegradedResult(latencyMs: number): ClassifyOutput {
  return { result: FAIL_OPEN_RESULT, latencyMs, degradedMode: true, costUsd: 0 }
}

function isValidClassification(
  v: unknown,
): v is 'on_topic' | 'off_topic' | 'needs_clarification' {
  return v === 'on_topic' || v === 'off_topic' || v === 'needs_clarification'
}

function parseClassificationResult(text: string): ClassificationResult | null {
  // Haiku often wraps JSON in ```json ... ``` fences. Extract the first {...}
  // span before parsing so the fences don't fail JSON.parse.
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  const slice = text.slice(start, end + 1)
  let parsed: unknown
  try {
    parsed = JSON.parse(slice)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>

  if (!isValidClassification(p.classification)) return null
  if (typeof p.confidence !== 'number' || p.confidence < 0 || p.confidence > 1)
    return null
  if (typeof p.reasoning !== 'string') return null

  const result: ClassificationResult = {
    classification: p.classification,
    confidence: p.confidence,
    reasoning: p.reasoning,
  }

  if (
    p.classification === 'off_topic' &&
    Array.isArray(p.suggestions) &&
    p.suggestions.length > 0
  ) {
    const filtered = p.suggestions.filter(
      (s): s is string => typeof s === 'string',
    )
    if (filtered.length > 0) {
      result.suggestions = filtered
    }
  }

  return result
}

export async function classifyQuestion(input: {
  question: string
  repoUrl: string
  repoSummary?: string
  anthropicApiKey: string
}): Promise<ClassifyOutput> {
  const t0 = Date.now()

  let userMessage = `Repository: ${input.repoUrl}`
  if (input.repoSummary !== undefined && input.repoSummary.trim() !== '') {
    userMessage += `\nSummary: ${input.repoSummary}`
  }
  userMessage += `\nQuestion: ${input.question}`

  try {
    const client = new Anthropic({ apiKey: input.anthropicApiKey, timeout: ANTHROPIC_TIMEOUT_MS })

    const response = await withAnthropicRetry(
      () =>
        Promise.race([
          client.messages.create({
            model: MODEL,
            // Headroom for adaptive thinking, which is on by default on
            // Haiku 5.5; effort 'low' keeps it brief for a routing call.
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userMessage }],
            output_config: {
              effort: 'low',
              format: { type: 'json_schema', schema: CLASSIFICATION_SCHEMA },
            },
          }),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('classifier timeout')), 12_000),
          ),
        ]),
      { maxAttempts: 2, baseDelayMs: 500 },
    )

    const latencyMs = Date.now() - t0
    // Read by type: with thinking on, the first block is a thinking block.
    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === 'text',
    )
    const text = textBlock?.text ?? ''
    const parsed = parseClassificationResult(text)

    if (parsed === null) {
      console.error('[qa-classifier]', 'Failed to parse classifier response:', text)
      return makeDegradedResult(latencyMs)
    }

    const costUsd = calculateCost(MODEL, {
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
    })

    return {
      result: parsed,
      latencyMs,
      degradedMode: false,
      costUsd,
    }
  } catch (err) {
    const latencyMs = Date.now() - t0
    console.error('[qa-classifier]', err)
    return makeDegradedResult(latencyMs)
  }
}
