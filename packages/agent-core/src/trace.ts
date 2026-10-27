import type Anthropic from '@anthropic-ai/sdk'
import { calculateCost } from './pricing'
import type { TraceLlmCall } from './types'

// Joins the summarized thinking text of a response. Empty when the model
// skipped thinking for this turn (adaptive) or display was omitted.
export function extractReasoning(content: Anthropic.ContentBlock[]): string | null {
  const text = content
    .filter((b): b is Anthropic.ThinkingBlock => b.type === 'thinking')
    .map((b) => b.thinking.trim())
    .filter((t) => t !== '')
    .join('\n\n')
  return text === '' ? null : text
}

export function buildTraceLlmCall(input: {
  step: number
  stage: TraceLlmCall['stage']
  model: string
  latencyMs: number
  response: Pick<Anthropic.Message, 'content' | 'usage'>
}): TraceLlmCall {
  const { usage, content } = input.response
  const tokens = {
    tokensIn: usage.input_tokens,
    tokensOut: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  }
  return {
    step: input.step,
    stage: input.stage,
    model: input.model,
    latencyMs: input.latencyMs,
    ...tokens,
    costUsd: calculateCost(input.model, tokens),
    toolUses: content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => b.name),
    reasoning: extractReasoning(content),
  }
}
