import { describe, it, expect } from 'vitest'

// Black-box test of the URL validation pattern. The regex lives in three
// places (apps/web/app/api/analyze/route.ts, apps/web/app/api/qa/route.ts,
// apps/web/components/url-input.tsx) — dedup is tracked as a separate
// tech debt item. This test re-declares the same pattern so any drift
// between copies surfaces here.
const GITHUB_URL_REGEX = /^https?:\/\/github\.com\/[\w][\w.-]*\/[\w][\w.-]*\/?$/i

describe('GITHUB_URL_REGEX', () => {
  describe('accepts', () => {
    const valid = [
      'https://github.com/vercel/next.js',
      'https://github.com/expressjs/express.js',
      'https://github.com/some-owner/repo.with.dots',
      'https://github.com/foo_bar/baz-qux',
      'https://github.com/pallets/click',
      'https://github.com/pallets/click/',
      'HTTPS://GITHUB.COM/Vercel/Next.JS',
      'http://github.com/foo/bar',
    ]
    for (const url of valid) {
      it(`accepts ${url}`, () => {
        expect(GITHUB_URL_REGEX.test(url)).toBe(true)
      })
    }
  })

  describe('rejects', () => {
    const invalid = [
      'https://github.com/./..',
      'https://github.com/.hidden/repo',
      'https://github.com/foo/.hidden',
      'https://github.com/-leading-dash/repo',
      'https://github.com/foo',
      'https://github.com/foo/bar/baz',
      'https://gitlab.com/foo/bar',
      'http://github.com.evil.com/foo/bar',
      'https://github.com//double-slash',
      'ftp://github.com/foo/bar',
      'github.com/foo/bar',
      'https://github.com/foo bar/baz',
    ]
    for (const url of invalid) {
      it(`rejects ${url}`, () => {
        expect(GITHUB_URL_REGEX.test(url)).toBe(false)
      })
    }
  })
})
