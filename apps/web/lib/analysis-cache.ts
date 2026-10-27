import type {
  FullAnalysisResult,
  LLMModelIntent,
  TraceLlmCall,
  TraceToolCall,
} from '@reponboard/agent-core'
import { prefixKey, redis } from './rate-limit'

// Analyses are deterministic enough per commit to cache: the key pins the
// repo, the HEAD commit SHA, and the model intent, so a new push or a
// model switch is a natural miss. A cache hit replays the stored result
// and the original agent trace with zero LLM spend.
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60
// Version the payload shape so a deploy that changes it can't read stale
// entries written by the previous one.
const CACHE_VERSION = 'v1'

export type CachedTraceEvent =
  | { phase: 'llm_call'; call: TraceLlmCall }
  | { phase: 'tool_end'; tool: TraceToolCall }
  | {
      phase: 'thinking'
      message: string
      toolCall?: string
      toolInput?: Record<string, unknown>
      toolUseId?: string
    }

export interface CachedAnalysis {
  cachedAt: string
  result: FullAnalysisResult
  trace: CachedTraceEvent[]
}

export function analysisCacheKey(input: {
  owner: string
  repo: string
  sha: string
  intent: LLMModelIntent
}): string {
  const repo = `${input.owner}/${input.repo}`.toLowerCase()
  return prefixKey(`analysis:${CACHE_VERSION}:${repo}@${input.sha}:${input.intent}`)
}

// The cache is an optimization: every failure is logged and treated as a
// miss so a Redis problem never blocks an analysis.
export async function readCachedAnalysis(key: string): Promise<CachedAnalysis | null> {
  try {
    const value = await redis.get<CachedAnalysis>(key)
    if (value === null || typeof value !== 'object' || !('result' in value)) {
      return null
    }
    return value
  } catch (err) {
    console.warn('[analysis-cache] read failed', err)
    return null
  }
}

export async function writeCachedAnalysis(
  key: string,
  result: FullAnalysisResult,
  trace: CachedTraceEvent[],
): Promise<void> {
  // The full file tree can run to megabytes on large repos and nothing in
  // the UI reads it, so it is dropped to keep entries small.
  const slim: FullAnalysisResult =
    result.discovery === null
      ? result
      : { ...result, discovery: { ...result.discovery, tree: [] } }
  const value: CachedAnalysis = { cachedAt: new Date().toISOString(), result: slim, trace }
  try {
    await redis.set(key, value, { ex: CACHE_TTL_SECONDS })
  } catch (err) {
    console.warn('[analysis-cache] write failed', err)
  }
}
