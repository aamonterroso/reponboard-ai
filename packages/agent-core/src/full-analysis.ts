import { GitHubClient, parseGitHubUrl } from './github'
import { runDiscovery } from './discovery'
import { analyzeWithLLM, analyzeWithLLMStream } from './llm-analysis'
import type { LLMMode } from './llm-analysis'
import type { AnalysisProgressEvent, FullAnalysisResult, KeyFile, LLMAnalysisResult } from './types'

// ─── Key File Selection ───────────────────────────────────────────────────────

const IMPORTANCE_RANK: Record<KeyFile['importance'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

// Cap fetched files so the LLM prompt stays manageable
const MAX_KEY_FILES_FOR_LLM = 12

function selectKeyFilePaths(keyFiles: KeyFile[]): string[] {
  return [...keyFiles]
    .sort((a, b) => IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance])
    .slice(0, MAX_KEY_FILES_FOR_LLM)
    .map((f) => f.path)
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export async function runFullAnalysis(
  repoUrl: string,
  githubToken: string | undefined,
  anthropicApiKey: string,
  llmMode: LLMMode = 'production',
): Promise<FullAnalysisResult> {
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()

  // Layer 1: heuristic discovery
  const discovery = await runDiscovery(repoUrl, githubToken)

  // Fetch key file contents for LLM context
  const { owner, repo, branch } = parseGitHubUrl(repoUrl)
  const client = new GitHubClient(githubToken)
  const pathsToFetch = selectKeyFilePaths(discovery.keyFiles)

  const rawContents =
    pathsToFetch.length > 0
      ? await client.getFilesContent(owner, repo, pathsToFetch, branch ?? undefined)
      : new Map<string, never>()

  const fileContents = new Map<string, string>()
  for (const [path, value] of rawContents) {
    if (!(value instanceof Error)) {
      fileContents.set(path, value.content)
    }
  }

  // Layer 2: LLM analysis — degrades gracefully if it fails
  let llmAnalysis: FullAnalysisResult['llmAnalysis'] = null
  let error: string | null = null

  try {
    llmAnalysis = await analyzeWithLLM(discovery, fileContents, anthropicApiKey, llmMode)
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
): AsyncGenerator<AnalysisProgressEvent> {
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()

  try {
    // Layer 1: heuristic discovery
    yield { phase: 'discovery', message: 'Scanning repository structure...' }
    const discovery = await runDiscovery(repoUrl, githubToken)

    // Fetch key file contents for LLM context
    const { owner, repo, branch } = parseGitHubUrl(repoUrl)
    const client = new GitHubClient(githubToken)
    const pathsToFetch = selectKeyFilePaths(discovery.keyFiles)
    const total = pathsToFetch.length

    yield {
      phase: 'fetching',
      message: `Fetching ${total} key files...`,
      progress: { current: 0, total },
    }

    const rawContents =
      total > 0
        ? await client.getFilesContent(owner, repo, pathsToFetch, branch ?? undefined)
        : new Map<string, never>()

    const fileContents = new Map<string, string>()
    for (const [path, value] of rawContents) {
      if (!(value instanceof Error)) {
        fileContents.set(path, value.content)
      }
    }

    yield {
      phase: 'fetching',
      message: `Fetching ${total} key files...`,
      progress: { current: fileContents.size, total },
    }

    // Layer 2: LLM analysis — stream tokens so the client sees progress instead
    // of a blank screen while Anthropic generates the full JSON response
    yield { phase: 'analyzing', message: 'AI is analyzing the codebase...' }

    let llmAnalysis: LLMAnalysisResult | null = null
    let error: string | null = null

    try {
      for await (const event of analyzeWithLLMStream(
        discovery,
        fileContents,
        anthropicApiKey,
        llmMode,
      )) {
        if (event.type === 'progress') {
          yield {
            phase: 'analyzing',
            message: `Generating analysis… ${event.chars.toLocaleString()} chars`,
          }
        } else {
          llmAnalysis = event.result
        }
      }
    } catch (err) {
      console.error('[analyzeWithLLM] Error:', err)
      error = err instanceof Error ? err.message : String(err)
    }

    yield {
      phase: 'complete',
      result: {
        id,
        repoUrl,
        status: 'complete',
        discovery,
        llmAnalysis,
        error,
        createdAt,
        completedAt: new Date().toISOString(),
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    yield { phase: 'error', error: message }
  }
}
