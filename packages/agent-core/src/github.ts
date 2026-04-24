import type {
  GitHubRepoInfo,
  GitHubTreeNode,
  GitHubTreeNodeType,
  GitHubFileContent,
} from './types'

const GITHUB_API_BASE = 'https://api.github.com'
const CONCURRENCY_LIMIT = 5

// ─── Error Class ─────────────────────────────────────────────────────────────

export type GitHubErrorCode =
  | 'INVALID_URL'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'FORBIDDEN'
  | 'NETWORK_ERROR'
  | 'PARSE_ERROR'

export class GitHubError extends Error {
  constructor(
    public readonly code: GitHubErrorCode,
    message: string,
    public readonly statusCode?: number,
    public readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

// ─── URL Parsing ──────────────────────────────────────────────────────────────

export interface ParsedGitHubUrl {
  owner: string
  repo: string
  branch: string | null
}

/**
 * Parses any GitHub URL format and returns owner, repo, and optional branch.
 *
 * Supported formats:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo/tree/branch
 *   https://github.com/owner/repo/tree/branch/some/path
 *   github.com/owner/repo
 */
export function parseGitHubUrl(url: string): ParsedGitHubUrl {
  const trimmed = url.trim()

  // Match tree URLs first to capture the branch
  const treeMatch =
    /^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/tree\/([^/\s]+)/.exec(
      trimmed,
    )
  if (treeMatch !== null) {
    const owner = treeMatch[1]
    const repo = treeMatch[2]
    const branch = treeMatch[3]
    if (owner === undefined || repo === undefined || branch === undefined) {
      throw new GitHubError('INVALID_URL', `Invalid GitHub URL: ${url}`)
    }
    return { owner, repo, branch }
  }

  // Match plain repo URLs (with or without .git, trailing slashes, fragments)
  const repoMatch =
    /^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s.]+?)(?:\.git)?(?:[/?#].*)?$/.exec(trimmed)
  if (repoMatch !== null) {
    const owner = repoMatch[1]
    const repo = repoMatch[2]
    if (owner === undefined || repo === undefined) {
      throw new GitHubError('INVALID_URL', `Invalid GitHub URL: ${url}`)
    }
    return { owner, repo, branch: null }
  }

  throw new GitHubError(
    'INVALID_URL',
    `Not a valid GitHub repository URL: "${url}". Expected format: https://github.com/owner/repo`,
  )
}

// ─── Raw API response shapes (internal) ──────────────────────────────────────

interface RawRepoResponse {
  owner: { login: string }
  name: string
  full_name: string
  description: string | null
  default_branch: string
  stargazers_count: number
  forks_count: number
  language: string | null
  topics: string[]
  size: number
  created_at: string
  updated_at: string
  license: { spdx_id: string } | null
  private: boolean
}

interface RawTreeResponse {
  tree: RawTreeNode[]
  truncated: boolean
}

interface RawTreeNode {
  path?: string
  mode?: string
  type?: string
  sha?: string
  size?: number
  url?: string
}

interface RawFileResponse {
  path: string
  content: string
  encoding: string
  size: number
  sha: string
}

// ─── GitHub Client ────────────────────────────────────────────────────────────

export class GitHubClient {
  private readonly headers: Record<string, string>

  constructor(token?: string) {
    this.headers = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'reponboard-ai/1.0',
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
    }
  }

  private async request<T>(path: string): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${GITHUB_API_BASE}${path}`, {
        headers: this.headers,
      })
    } catch (err) {
      throw new GitHubError(
        'NETWORK_ERROR',
        `Network error fetching ${path}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (!response.ok) {
      const remaining = response.headers.get('x-ratelimit-remaining')
      const resetHeader = response.headers.get('x-ratelimit-reset')
      const retryAfterHeader = response.headers.get('retry-after')

      const isRateLimited =
        response.status === 429 ||
        (response.status === 403 && remaining === '0')

      if (isRateLimited) {
        const retryAfter =
          retryAfterHeader !== null
            ? parseInt(retryAfterHeader, 10)
            : resetHeader !== null
              ? Math.max(0, parseInt(resetHeader, 10) - Math.floor(Date.now() / 1000))
              : undefined
        throw new GitHubError(
          'RATE_LIMITED',
          `GitHub API rate limit exceeded.${retryAfter !== undefined ? ` Retry after ${retryAfter}s.` : ''}`,
          response.status,
          retryAfter,
        )
      }

      if (response.status === 404) {
        throw new GitHubError('NOT_FOUND', `Resource not found: ${path}`, 404)
      }

      if (response.status === 403) {
        throw new GitHubError('FORBIDDEN', `Access forbidden: ${path}`, 403)
      }

      throw new GitHubError(
        'NETWORK_ERROR',
        `GitHub API responded with ${response.status} for ${path}`,
        response.status,
      )
    }

    try {
      return (await response.json()) as T
    } catch {
      throw new GitHubError('PARSE_ERROR', `Failed to parse JSON response from ${path}`)
    }
  }

  async getRepoInfo(owner: string, repo: string): Promise<GitHubRepoInfo> {
    const raw = await this.request<RawRepoResponse>(`/repos/${owner}/${repo}`)

    return {
      owner: raw.owner.login,
      name: raw.name,
      fullName: raw.full_name,
      description: raw.description,
      defaultBranch: raw.default_branch,
      stars: raw.stargazers_count,
      forks: raw.forks_count,
      language: raw.language,
      topics: raw.topics ?? [],
      size: raw.size,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      license: raw.license?.spdx_id ?? null,
      isPrivate: raw.private,
    }
  }

  async getTree(
    owner: string,
    repo: string,
    branch?: string,
  ): Promise<GitHubTreeNode[]> {
    let ref = branch
    if (ref === undefined) {
      const info = await this.getRepoInfo(owner, repo)
      ref = info.defaultBranch
    }

    const raw = await this.request<RawTreeResponse>(
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    )

    return raw.tree
      .filter((node): node is RawTreeNode & { path: string; type: string } =>
        node.path !== undefined && node.type !== undefined,
      )
      .map((node) => ({
        path: node.path,
        mode: node.mode ?? '100644',
        type: node.type as GitHubTreeNodeType,
        sha: node.sha ?? '',
        ...(node.size !== undefined ? { size: node.size } : {}),
        url: node.url ?? '',
      }))
  }

  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    branch?: string,
  ): Promise<GitHubFileContent> {
    const query =
      branch !== undefined ? `?ref=${encodeURIComponent(branch)}` : ''
    const raw = await this.request<RawFileResponse>(
      `/repos/${owner}/${repo}/contents/${path}${query}`,
    )

    // GitHub returns base64 with embedded newlines — strip before decoding
    // Uses Web Crypto APIs (atob + TextDecoder) instead of Buffer for Edge compatibility
    const content =
      raw.encoding === 'base64'
        ? (() => {
            const bin = atob(raw.content.replace(/\n/g, ''))
            const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
            return new TextDecoder().decode(bytes)
          })()
        : raw.content

    return {
      path: raw.path,
      content,
      encoding: 'utf-8',
      size: raw.size,
      sha: raw.sha,
    }
  }

  async getFilesContent(
    owner: string,
    repo: string,
    paths: string[],
    branch?: string,
  ): Promise<Map<string, GitHubFileContent | Error>> {
    const results = new Map<string, GitHubFileContent | Error>()

    for (let i = 0; i < paths.length; i += CONCURRENCY_LIMIT) {
      const batch = paths.slice(i, i + CONCURRENCY_LIMIT)

      const settled = await Promise.allSettled(
        batch.map((p) => this.getFileContent(owner, repo, p, branch)),
      )

      for (let j = 0; j < batch.length; j++) {
        const filePath = batch[j]
        const result = settled[j]
        if (filePath === undefined || result === undefined) continue

        if (result.status === 'fulfilled') {
          results.set(filePath, result.value)
        } else {
          results.set(
            filePath,
            result.reason instanceof Error
              ? result.reason
              : new Error(String(result.reason)),
          )
        }
      }
    }

    return results
  }
}
