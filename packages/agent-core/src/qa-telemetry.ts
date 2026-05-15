export interface QaTelemetry {
  requestId: string
  timestamp: string
  repoUrl: string
  questionLength: number
  questionHashPrefix: string
  classification: 'on_topic' | 'off_topic' | 'needs_clarification' | null
  classifierConfidence: number | null
  classifierLatencyMs: number | null
  classifierDegradedMode: boolean
  toolCallsUsed: number
  toolBudgetExhausted: boolean
  hallucinatedFileReferences: string[]
  responseRejectedByValidator: boolean
  retryCount: number
  finalCostUsd: number
  finalLatencyMs: number
  historyLength: number
  fatalError: string | null
}

// FNV-1a 32-bit. Not cryptographic — only used for grep-ability of
// telemetry log lines tied to the same question. Synchronous so the
// helper can be called inline at request start in Edge runtime, which
// rejects node:crypto.
export function hashQuestionPrefix(question: string): string {
  const bytes = new TextEncoder().encode(question)
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function emitQaTelemetry(t: QaTelemetry): void {
  console.log('[qa-telemetry]', JSON.stringify(t))
}

export function buildInitialTelemetry(input: {
  requestId: string
  repoUrl: string
  question: string
  historyLength: number
}): QaTelemetry {
  return {
    requestId: input.requestId,
    timestamp: new Date().toISOString(),
    repoUrl: input.repoUrl,
    questionLength: input.question.length,
    questionHashPrefix: hashQuestionPrefix(input.question),
    classification: null,
    classifierConfidence: null,
    classifierLatencyMs: null,
    classifierDegradedMode: false,
    toolCallsUsed: 0,
    toolBudgetExhausted: false,
    hallucinatedFileReferences: [],
    responseRejectedByValidator: false,
    retryCount: 0,
    finalCostUsd: 0,
    finalLatencyMs: 0,
    historyLength: input.historyLength,
    fatalError: null,
  }
}
