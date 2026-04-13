import type { DiscoveryResult, GitHubFileContent, GitHubTreeNode } from './types.js'
import { parseGitHubUrl, GitHubClient } from './github.js'
import { detectStack, identifyEntryPoints, identifyKeyFiles } from './detection.js'

// Priority-ordered list of files to fetch for stack detection.
// We cap at MAX_FETCH_FILES total.
const MAX_FETCH_FILES = 15

const PRIORITY_FILES: string[] = [
  'package.json',
  'README.md',
  'readme.md',
  'tsconfig.json',
  'go.mod',
  'Cargo.toml',
  'requirements.txt',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
  'Gemfile',
  'composer.json',
  'pnpm-workspace.yaml',
  'turbo.json',
  'deno.json',
  'deno.jsonc',
  'bun.lockb',
  '.env.example',
  'next.config.ts',
  'next.config.js',
  'next.config.mjs',
  'nuxt.config.ts',
  'svelte.config.js',
  'astro.config.mjs',
  'vite.config.ts',
  'vite.config.js',
  'docker-compose.yml',
  'docker-compose.yaml',
  'Dockerfile',
]

function selectFilesToFetch(tree: GitHubTreeNode[]): string[] {
  const blobs = new Set(
    tree.filter((n) => n.type === 'blob').map((n) => n.path),
  )

  const selected: string[] = []
  const seen = new Set<string>()

  // Add priority files first (in order)
  for (const p of PRIORITY_FILES) {
    if (blobs.has(p) && !seen.has(p)) {
      selected.push(p)
      seen.add(p)
      if (selected.length >= MAX_FETCH_FILES) return selected
    }
  }

  return selected
}

function computeTreeStats(tree: GitHubTreeNode[]): {
  totalFiles: number
  totalDirectories: number
  filesByExtension: Map<string, number>
  maxDepth: number
} {
  let totalFiles = 0
  let totalDirectories = 0
  const filesByExtension = new Map<string, number>()
  let maxDepth = 0

  for (const node of tree) {
    const depth = node.path.split('/').length
    if (depth > maxDepth) maxDepth = depth

    if (node.type === 'blob') {
      totalFiles++
      const dotIdx = node.path.lastIndexOf('.')
      const ext = dotIdx !== -1 ? node.path.slice(dotIdx) : '(none)'
      filesByExtension.set(ext, (filesByExtension.get(ext) ?? 0) + 1)
    } else if (node.type === 'tree') {
      totalDirectories++
    }
  }

  return { totalFiles, totalDirectories, filesByExtension, maxDepth }
}

export async function runDiscovery(
  repoUrl: string,
  githubToken?: string,
): Promise<DiscoveryResult> {
  // 1. Parse URL
  const parsed = parseGitHubUrl(repoUrl)
  const { owner, repo } = parsed

  // 2. Create client
  const client = new GitHubClient(githubToken)

  // 3 & 4. Fetch repo info and tree in parallel
  const [repoInfo, tree] = await Promise.all([
    client.getRepoInfo(owner, repo),
    client.getTree(owner, repo, parsed.branch ?? undefined),
  ])

  // 5. Compute tree stats
  const { totalFiles, totalDirectories } = computeTreeStats(tree)

  // 6. Select priority files to fetch
  const filesToFetch = selectFilesToFetch(tree)

  // 7. Fetch file contents — errors per-file are swallowed; the Map entry will hold an Error
  const rawContents: Map<string, GitHubFileContent | Error> =
    filesToFetch.length > 0
      ? await client.getFilesContent(owner, repo, filesToFetch, parsed.branch ?? undefined)
      : new Map()

  // Build a plain string map for detection (skip files that errored)
  const fileContents = new Map<string, string>()
  for (const [path, value] of rawContents) {
    if (!(value instanceof Error)) {
      fileContents.set(path, value.content)
    }
  }

  // 8. Detect stack
  const stack = detectStack(tree, fileContents)

  // 9. Identify entry points and key files
  const entryPoints = identifyEntryPoints(tree, stack)
  const keyFiles = identifyKeyFiles(tree)

  // 10. Return full result
  return {
    repoInfo,
    tree,
    stack,
    entryPoints,
    keyFiles,
    totalFiles,
    totalDirectories,
    detectedAt: new Date().toISOString(),
  }
}
