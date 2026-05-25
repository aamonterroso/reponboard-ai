import { describe, it, expect } from 'vitest'
import { parseGitHubUrl } from './github'

describe('parseGitHubUrl', () => {
  describe('repos WITH dots in the name (regression for vercel/next.js)', () => {
    it.each([
      ['https://github.com/vercel/next.js', 'vercel', 'next.js'],
      ['https://github.com/vuejs/vue.js', 'vuejs', 'vue.js'],
      ['https://github.com/some-org/react-three.fiber', 'some-org', 'react-three.fiber'],
      ['https://github.com/owner/repo.with.many.dots', 'owner', 'repo.with.many.dots'],
      ['https://github.com/vercel/next.js/', 'vercel', 'next.js'],
      ['https://github.com/vercel/next.js.git', 'vercel', 'next.js'],
      ['github.com/vercel/next.js', 'vercel', 'next.js'],
    ])('parses %s → %s/%s', (url, owner, repo) => {
      const result = parseGitHubUrl(url)
      expect(result.owner).toBe(owner)
      expect(result.repo).toBe(repo)
      expect(result.branch).toBeNull()
    })
  })

  describe('plain repo URLs (no dots)', () => {
    it.each([
      ['https://github.com/colinhacks/zod', 'colinhacks', 'zod', null],
      ['https://github.com/pallets/flask', 'pallets', 'flask', null],
      ['https://github.com/vercel/next.js.git', 'vercel', 'next.js', null],
      ['https://github.com/owner/repo/', 'owner', 'repo', null],
      ['http://github.com/owner/repo', 'owner', 'repo', null],
      ['github.com/owner/repo', 'owner', 'repo', null],
    ])('parses %s', (url, owner, repo, branch) => {
      const result = parseGitHubUrl(url)
      expect(result.owner).toBe(owner)
      expect(result.repo).toBe(repo)
      expect(result.branch).toBe(branch)
    })
  })

  describe('tree URLs (branch capture)', () => {
    it('parses tree URL with branch', () => {
      const result = parseGitHubUrl(
        'https://github.com/vercel/next.js/tree/canary',
      )
      expect(result.owner).toBe('vercel')
      expect(result.repo).toBe('next.js')
      expect(result.branch).toBe('canary')
    })

    it('parses tree URL with branch and trailing path', () => {
      const result = parseGitHubUrl(
        'https://github.com/owner/repo.dot/tree/main/packages/core',
      )
      expect(result.owner).toBe('owner')
      expect(result.repo).toBe('repo.dot')
      expect(result.branch).toBe('main')
    })
  })

  describe('invalid URLs (still rejected)', () => {
    it.each([
      'https://gitlab.com/owner/repo',
      'https://example.com/foo/bar',
      'not a url',
      'https://github.com/onlyowner',
      'https://github.com/',
      '',
    ])('rejects %s', (url) => {
      expect(() => parseGitHubUrl(url)).toThrow()
    })
  })
})
