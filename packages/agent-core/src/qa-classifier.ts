import Anthropic from '@anthropic-ai/sdk'
import { calculateCost } from './pricing'
import { withAnthropicRetry } from './anthropic-retry'

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

const MODEL = 'claude-haiku-4-5-20251001'

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

Respond ONLY with a JSON object matching this schema, no prose:

{
  "classification": "on_topic" | "off_topic" | "needs_clarification",
  "confidence": <number between 0.0 and 1.0>,
  "reasoning": "<one or two sentences>",
  "suggestions": ["<question>", "<question>", "<question>"]
}

Include the "suggestions" field ONLY when classification is
"off_topic". Suggestions should be 2-3 concrete questions about this
specific repository that the user might ask instead. Omit the field
entirely for on_topic and needs_clarification.`

const FAIL_OPEN_RESULT: ClassificationResult = {
  classification: 'on_topic',
  confidence: 0.5,
  reasoning: 'Classifier unavailable; defaulting to on_topic (fail-open).',
}

const OFF_TOPIC_HEURISTICS: RegExp[] = [
  /\bin 20\d\d\b/i,
  /\bbest\b/i,
  /\brecommend/i,
  /\bcompare/i,
  /\s+vs\s+/i,
  /\s+versus\s+/i,
  /\btop \d+\b/i,
  /\bindustry\b/i,
  /\bplatform\b/i,
  /\bframework for\b/i,
]

function matchesOffTopicHeuristic(question: string): boolean {
  return OFF_TOPIC_HEURISTICS.some((re) => re.test(question))
}

function makeDegradedResult(question: string, latencyMs: number): ClassifyOutput {
  if (matchesOffTopicHeuristic(question)) {
    return {
      result: {
        classification: 'off_topic',
        confidence: 0.5,
        reasoning:
          'Classifier unavailable; question matched off-topic heuristic patterns. Defaulting to off_topic to avoid unbounded LLM cost on likely-off-topic query.',
        suggestions: [],
      },
      latencyMs,
      degradedMode: true,
      costUsd: 0,
    }
  }
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
    const client = new Anthropic({ apiKey: input.anthropicApiKey })

    const response = await withAnthropicRetry(
      () =>
        Promise.race([
          client.messages.create({
            model: MODEL,
            max_tokens: 200,
            temperature: 0,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userMessage }],
          }),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('classifier timeout')), 12_000),
          ),
        ]),
      { maxAttempts: 2, baseDelayMs: 500 },
    )

    const latencyMs = Date.now() - t0
    const text =
      response.content[0]?.type === 'text' ? response.content[0].text : ''
    const parsed = parseClassificationResult(text)

    if (parsed === null) {
      console.error('[qa-classifier]', 'Failed to parse classifier response:', text)
      return makeDegradedResult(input.question, latencyMs)
    }

    const costUsd = calculateCost(
      MODEL,
      response.usage.input_tokens,
      response.usage.output_tokens,
    )

    return {
      result: parsed,
      latencyMs,
      degradedMode: false,
      costUsd,
    }
  } catch (err) {
    const latencyMs = Date.now() - t0
    console.error('[qa-classifier]', err)
    return makeDegradedResult(input.question, latencyMs)
  }
}
