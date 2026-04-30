import { GitHubClient, parseGitHubUrl } from './github'
import { runDiscovery } from './discovery'
import {
  analyzeWithLLM,
  analyzeWithLLMStream,
  INTENT_TO_MODEL,
} from './llm-analysis'
import type { LLMMode, LLMModelIntent } from './llm-analysis'
import type {
  AnalysisMeta,
  AnalysisProgressEvent,
  FullAnalysisResult,
  LLMAnalysisResult,
} from './types'

// ─── Orchestrator (non-streaming) ─────────────────────────────────────────────

export async function runFullAnalysis(
  repoUrl: string,
  githubToken: string | undefined,
  anthropicApiKey: string,
  llmMode: LLMMode = 'production',
  intent?: LLMModelIntent,
): Promise<FullAnalysisResult> {
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()

  const resolvedIntent: LLMModelIntent =
    intent ?? (llmMode === 'development' ? 'fast' : 'quality')
  const model = INTENT_TO_MODEL[resolvedIntent]
  const deprecatedModeUsed = intent === undefined
  const meta: AnalysisMeta = {
    model,
    intent: resolvedIntent,
    deprecatedModeUsed,
  }

  // Layer 1: heuristic discovery
  const discovery = await runDiscovery(repoUrl, githubToken)

  const { owner, repo, branch } = parseGitHubUrl(repoUrl)
  const client = new GitHubClient(githubToken)
  const resolvedBranch = branch ?? discovery.repoInfo.defaultBranch

  // Layer 2: LLM analysis with tool_use — degrades gracefully if it fails
  let llmAnalysis: FullAnalysisResult['llmAnalysis'] = null
  let error: string | null = null

  try {
    llmAnalysis = await analyzeWithLLM(
      discovery,
      client,
      { owner, repo, branch: resolvedBranch },
      anthropicApiKey,
      llmMode,
      intent,
    )
  } catch (err) {
    console.error('[analyzeWithLLM] Error:', err)
    error = err instanceof Error ? err.message : String(err)
  }

  return {
    id,
    repoUrl,
    status: 'complete',
    discovery,
    llmAnalysis,
    error,
    meta,
    createdAt,
    completedAt: new Date().toISOString(),
  }
}

// ─── Streaming Orchestrator ───────────────────────────────────────────────────

export async function* runFullAnalysisStream(
  repoUrl: string,
  githubToken: string | undefined,
  anthropicApiKey: string,
  llmMode: LLMMode = 'production',
  intent?: LLMModelIntent,
): AsyncGenerator<AnalysisProgressEvent> {
  const t0 = Date.now()
  console.log('[timing] analysis start')
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()

  const resolvedIntent: LLMModelIntent =
    intent ?? (llmMode === 'development' ? 'fast' : 'quality')
  const model = INTENT_TO_MODEL[resolvedIntent]
  const deprecatedModeUsed = intent === undefined
  const meta: AnalysisMeta = {
    model,
    intent: resolvedIntent,
    deprecatedModeUsed,
  }

  try {
    yield { phase: 'discovery', message: 'Scanning repository structure...' }
    const discovery = await runDiscovery(repoUrl, githubToken)
    console.log(`[timing] discovery done in ${Date.now() - t0}ms`)

    const { owner, repo, branch } = parseGitHubUrl(repoUrl)
    const client = new GitHubClient(githubToken)
    const resolvedBranch = branch ?? discovery.repoInfo.defaultBranch

    yield { phase: 'analyzing', message: 'Agent is exploring the codebase...' }

    let llmAnalysis: LLMAnalysisResult | null = null
    let error: string | null = null

    try {
      for await (const event of analyzeWithLLMStream(
        discovery,
        client,
        { owner, repo, branch: resolvedBranch },
        anthropicApiKey,
        llmMode,
        intent,
      )) {
        if (event.type === 'thinking') {
          const base: {
            phase: 'thinking'
            message: string
            toolCall?: string
            toolInput?: Record<string, unknown>
          } = {
            phase: 'thinking',
            message: event.message,
          }
          if (event.toolCall !== undefined) base.toolCall = event.toolCall
          if (event.toolInput !== undefined) base.toolInput = event.toolInput
          yield base
        } else if (event.type === 'partial_core') {
          yield { phase: 'partial_core', core: event.core }
        } else if (event.type === 'partial_guide') {
          yield { phase: 'partial_guide', guide: event.guide }
        } else {
          llmAnalysis = event.result
        }
      }
    } catch (err) {
      console.error('[analyzeWithLLM] Error:', err)
      error = err instanceof Error ? err.message : String(err)
    }
    console.log(`[timing] llm analysis done in ${Date.now() - t0}ms (cumulative)`)

    console.log(`[timing] total ${Date.now() - t0}ms`)
    yield {
      phase: 'complete',
      result: {
        id,
        repoUrl,
        status: 'complete',
        discovery,
        llmAnalysis,
        error,
        meta,
        createdAt,
        completedAt: new Date().toISOString(),
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    yield { phase: 'error', error: message }
  }
}
