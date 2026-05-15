import { describe, it, expect } from 'vitest'
import { validateQaResponse } from './qa-validator'

describe('validateQaResponse', () => {
  it('skips validation for off_topic classification', () => {
    const result = validateQaResponse({
      answer: '',
      filesReferencedClaim: ['anything/at/all.ts'],
      filesActuallyFetched: [],
      classification: 'off_topic',
    })
    expect(result.valid).toBe(true)
  })

  it('skips validation for needs_clarification classification', () => {
    const result = validateQaResponse({
      answer: 'I have already answered this before',
      filesReferencedClaim: [],
      filesActuallyFetched: [],
      classification: 'needs_clarification',
    })
    expect(result.valid).toBe(true)
  })

  it('passes clean on_topic answer with matched file references', () => {
    const result = validateQaResponse({
      answer: 'The entry point is `src/click/__init__.py`.',
      filesReferencedClaim: ['src/click/__init__.py', 'pyproject.toml'],
      filesActuallyFetched: ['src/click/__init__.py', 'pyproject.toml'],
      classification: 'on_topic',
    })
    expect(result.valid).toBe(true)
  })

  it('rejects on_topic answer that references unfetched files', () => {
    const result = validateQaResponse({
      answer: 'See fake/path.ts for details.',
      filesReferencedClaim: ['fake/path.ts', 'src/click/__init__.py'],
      filesActuallyFetched: ['src/click/__init__.py'],
      classification: 'on_topic',
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('hallucinated_file_references')
    expect(result.hallucinatedFiles).toEqual(['fake/path.ts'])
  })

  it('rejects on_topic answer with "As I mentioned earlier" recap', () => {
    const result = validateQaResponse({
      answer: 'As I mentioned earlier, the entry point is the __init__ file.',
      filesReferencedClaim: [],
      filesActuallyFetched: [],
      classification: 'on_topic',
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('recap_detected')
  })

  it("rejects on_topic answer with \"I've already answered\" recap", () => {
    const result = validateQaResponse({
      answer: "I've already answered this in a previous response.",
      filesReferencedClaim: [],
      filesActuallyFetched: [],
      classification: 'on_topic',
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('recap_detected')
  })

  it('passes when "mentioned" appears in legitimate non-recap context', () => {
    const result = validateQaResponse({
      answer:
        'The README mentioned that this package uses flit as its build backend.',
      filesReferencedClaim: ['README.md'],
      filesActuallyFetched: ['README.md'],
      classification: 'on_topic',
    })
    expect(result.valid).toBe(true)
  })
})
