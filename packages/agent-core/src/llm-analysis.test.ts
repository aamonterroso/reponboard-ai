import { describe, it, expect } from 'vitest'
import { __internal } from './llm-analysis'
import type { DetectedStack, GitHubTreeNode } from './types'

const baseStack: DetectedStack = {
  runtime: 'nodejs',
  framework: 'nextjs',
  category: 'fullstack',
  packageManager: 'pnpm',
  language: 'typescript',
  hasTests: true,
  hasDocker: false,
  hasCi: true,
  additionalLibraries: [],
  confidence: 0.9,
}

const treeNode = (
  path: string,
  type: GitHubTreeNode['type'],
  size?: number,
): GitHubTreeNode => ({
  path,
  mode: type === 'tree' ? '040000' : '100644',
  type,
  sha: `sha-${path}`,
  url: '',
  ...(size === undefined ? {} : { size }),
})

describe('filterTreeForPrompt', () => {
  it('removes noise blobs but keeps directories and source files', () => {
    const input: GitHubTreeNode[] = [
      treeNode('src', 'tree'),
      treeNode('src/index.ts', 'blob', 1200),
      treeNode('Cargo.lock', 'blob', 50_000),
      treeNode('dist/app.min.js', 'blob', 8000),
      treeNode('dist/bundle.js.map', 'blob', 12_000),
      treeNode('public/logo.png', 'blob', 4000),
      treeNode('data/huge.json', 'blob', 600_000),
    ]
    const result = __internal.filterTreeForPrompt(input)
    expect(result).toHaveLength(2)
    expect(result.map((n) => n.path).sort()).toEqual(['src', 'src/index.ts'])
  })
})

describe('coerceCorePartial', () => {
  it('falls back to discoveryStack when LLM omits refinedStack', () => {
    const result = __internal.coerceCorePartial(
      {
        executiveSummary: {
          oneLiner: 'A test repo.',
          overview: 'Overview text for the repo.',
          targetAudience: 'Developers.',
        },
        architectureInsights: {
          pattern: 'monolith',
          patternDescription: 'Single deployable unit.',
          keyDirectories: [],
          designDecisions: [],
        },
      },
      baseStack,
    )
    expect(result.refinedStack.runtime).toBe(baseStack.runtime)
    expect(result.refinedStack.framework).toBe(baseStack.framework)
    expect(result.refinedStack.language).toBe(baseStack.language)
    expect(typeof result.refinedStack.reasoning).toBe('string')
    expect(result.refinedStack.reasoning.length).toBeGreaterThan(0)
  })

  it('throws when input is null', () => {
    expect(() => __internal.coerceCorePartial(null, baseStack)).toThrow(
      /finish_core returned non-object/,
    )
  })
})

describe('coerceGuidePartial', () => {
  it('defaults keyFiles to [] when not an array', () => {
    const result = __internal.coerceGuidePartial({
      keyFiles: 'not-an-array',
      explorationPath: [],
      codebaseContext: 'ctx',
    })
    expect(result.keyFiles).toEqual([])
    expect(result.explorationPath).toEqual([])
    expect(result.codebaseContext).toBe('ctx')
  })

  it('defaults codebaseContext to empty string when not a string', () => {
    const result = __internal.coerceGuidePartial({
      keyFiles: [],
      explorationPath: [],
      codebaseContext: 42,
    })
    expect(result.codebaseContext).toBe('')
    expect(result.keyFiles).toEqual([])
    expect(result.explorationPath).toEqual([])
  })
})
