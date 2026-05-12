export type ModelPricing = {
  inputPer1M: number
  outputPer1M: number
}

// Prices verified May 2026 against docs.claude.com.
// Sonnet 4 (claude-sonnet-4-20250514) is deprecated but kept
// here so historical benchmark runs can still cost-calculate.
export const PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-sonnet-4-20250514': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-haiku-4-5-20251001': { inputPer1M: 1.0, outputPer1M: 5.0 },
}

export function calculateCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const entry = PRICING[model]
  if (entry === undefined) {
    console.warn(`[PRICING] no pricing entry for model "${model}"`)
    return 0
  }
  const inCost = (tokensIn / 1_000_000) * entry.inputPer1M
  const outCost = (tokensOut / 1_000_000) * entry.outputPer1M
  return inCost + outCost
}
