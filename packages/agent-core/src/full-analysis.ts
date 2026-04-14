import { randomUUID } from 'crypto'
import { GitHubClient, parseGitHubUrl } from './github'
import { runDiscovery } from './discovery'
import { analyzeWithLLM } from './llm-analysis'
import type { FullAnalysisResult, KeyFile } from './types'

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
): Promise<FullAnalysisResult> {
  const id = randomUUID()
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
    llmAnalysis = await analyzeWithLLM(discovery, fileContents, anthropicApiKey)
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
