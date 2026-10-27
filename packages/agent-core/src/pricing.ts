export type ModelPricing = {
  inputPer1M: number
  outputPer1M: number
}

// Prices verified Oct 2026 against platform.claude.com. Retired and
// superseded models are kept so historical benchmark runs (Block G,
// May 2026) can still cost-calculate. Haiku 5.5's rate applies to
// prompts up to 100K tokens; every prompt this pipeline sends is
// well under that.
export const PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-5-5': { inputPer1M: 2.0, outputPer1M: 10.0 },
  'claude-haiku-5-5': { inputPer1M: 0.1, outputPer1M: 0.5 },
  'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-sonnet-4-20250514': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-haiku-4-5-20251001': { inputPer1M: 1.0, outputPer1M: 5.0 },
}

// Prompt-cache multipliers on the input rate (5-minute TTL).
const CACHE_READ_MULTIPLIER = 0.1
const CACHE_WRITE_MULTIPLIER = 1.25

export interface TokenUsage {
  // Uncached input tokens, as reported in `usage.input_tokens`.
  tokensIn: number
  tokensOut: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export function calculateCost(model: string, usage: TokenUsage): number {
  const entry = PRICING[model]
  if (entry === undefined) {
    console.warn(`[PRICING] no pricing entry for model "${model}"`)
    return 0
  }
  const inRate = entry.inputPer1M / 1_000_000
  const inCost = usage.tokensIn * inRate
  const cacheReadCost = (usage.cacheReadTokens ?? 0) * inRate * CACHE_READ_MULTIPLIER
  const cacheWriteCost =
    (usage.cacheWriteTokens ?? 0) * inRate * CACHE_WRITE_MULTIPLIER
  const outCost = (usage.tokensOut / 1_000_000) * entry.outputPer1M
  return inCost + cacheReadCost + cacheWriteCost + outCost
}

// Accumulates `response.usage` across the calls of one agent loop.
export function createUsageTotals(): Required<TokenUsage> {
  return { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

export function addUsage(
  totals: Required<TokenUsage>,
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number | null
    cache_creation_input_tokens?: number | null
  },
): void {
  totals.tokensIn += usage.input_tokens
  totals.tokensOut += usage.output_tokens
  totals.cacheReadTokens += usage.cache_read_input_tokens ?? 0
  totals.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0
}
