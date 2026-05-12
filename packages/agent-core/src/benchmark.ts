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

export async function runBenchmarkAnalysis(
  repoUrl: string,
  intent: 'fast' | 'quality',
): Promise<BenchmarkRecord> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (apiKey === undefined || apiKey === '') {
    throw new Error('ANTHROPIC_API_KEY is required')
  }
  const githubToken = process.env.GITHUB_TOKEN

  const timestamp = new Date().toISOString()
  const start = Date.now()
  let core: AnalysisMeta | null = null
  let guide: AnalysisMeta | null = null
  let success = false
  let errorMessage: string | undefined

  try {
    for await (const event of runFullAnalysisStream(
      repoUrl,
      githubToken,
      apiKey,
      'production',
      intent,
    )) {
      if (event.phase === 'complete') {
        core = event.result.meta?.core ?? null
        guide = event.result.meta?.guide ?? null
        if (event.result.error !== null) {
          errorMessage = event.result.error
        } else {
          success = true
        }
      } else if (event.phase === 'error') {
        errorMessage = event.error
      }
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err)
  }

  const totalLatencyMs = Date.now() - start
  const totalCostUsd = (core?.costUsd ?? 0) + (guide?.costUsd ?? 0)

  const record: BenchmarkRecord = {
    timestamp,
    repoUrl,
    intent,
    success,
    totalLatencyMs,
    core,
    guide,
    totalCostUsd,
  }
  if (errorMessage !== undefined) record.errorMessage = errorMessage
  return record
}
