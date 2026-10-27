import { runFullAnalysisStream } from './full-analysis'
import type { AnalysisMeta } from './types'

export interface BenchmarkRecord {
  timestamp: string
  repoUrl: string
  intent: 'fast' | 'quality'
  success: boolean
  errorMessage?: string
  totalLatencyMs: number
  core: AnalysisMeta | null
  guide: AnalysisMeta | null
  totalCostUsd: number
}

const DEFAULT_WALL_CLOCK_MS = 180_000

export async function runBenchmarkAnalysis(
  repoUrl: string,
  intent: 'fast' | 'quality',
  wallClockMs: number = DEFAULT_WALL_CLOCK_MS,
): Promise<BenchmarkRecord> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (apiKey === undefined || apiKey === '') {
    throw new Error('ANTHROPIC_API_KEY is required')
  }
  const githubToken = process.env.GITHUB_TOKEN

  const timestamp = new Date().toISOString()
  const start = Date.now()
  // Held in an object because `consume` assigns from a closure, which
  // TypeScript's control-flow analysis does not track for plain lets.
  const meta: { core: AnalysisMeta | null; guide: AnalysisMeta | null } = {
    core: null,
    guide: null,
  }
  let success = false
  let errorMessage: string | undefined

  const consume = async (): Promise<void> => {
    for await (const event of runFullAnalysisStream(
      repoUrl,
      githubToken,
      apiKey,
      'production',
      intent,
    )) {
      if (event.phase === 'complete') {
        meta.core = event.result.meta?.core ?? null
        meta.guide = event.result.meta?.guide ?? null
        if (event.result.error !== null) {
          errorMessage = event.result.error
        } else {
          success = true
        }
      } else if (event.phase === 'error') {
        errorMessage = event.error
      }
    }
  }

  // Per-run wall-clock cap. Block G lost a run to an 874s socket hang;
  // this turns any future hang into a clean `success: false` record.
  let timer: ReturnType<typeof setTimeout> | undefined
  const wallClock = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`wall-clock timeout after ${wallClockMs}ms`)),
      wallClockMs,
    )
  })

  try {
    await Promise.race([consume(), wallClock])
  } catch (err) {
    success = false
    errorMessage = err instanceof Error ? err.message : String(err)
  } finally {
    clearTimeout(timer)
  }

  const totalLatencyMs = Date.now() - start
  const totalCostUsd = (meta.core?.costUsd ?? 0) + (meta.guide?.costUsd ?? 0)

  const record: BenchmarkRecord = {
    timestamp,
    repoUrl,
    intent,
    success,
    totalLatencyMs,
    core: meta.core,
    guide: meta.guide,
    totalCostUsd,
  }
  if (errorMessage !== undefined) record.errorMessage = errorMessage
  return record
}
