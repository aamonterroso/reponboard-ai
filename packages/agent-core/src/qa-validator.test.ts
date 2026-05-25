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

  // ─── Prospective non-answer (preamble) checks ────────────────────────────

  it('rejects "Let me look at the source code before answering" as prospective non-answer', () => {
    // Exact preamble observed in prod: Sonnet under forced-respond
    // budget pressure emitted this as `answer`, passed validation (no
    // hallucination, no recap), and reached the user as a non-answer.
    const result = validateQaResponse({
      answer:
        'Let me look at the actual error formatting source code before answering.',
      filesReferencedClaim: [],
      filesActuallyFetched: [],
      classification: 'on_topic',
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('prospective_non_answer')
  })

  it.each([
    "I'll check the routing logic and get back to you.",
    'I need to look at how middleware is wired first.',
    "I'll examine the entry point to find this.",
    'Before I answer, let me verify the package config.',
    'Let me check src/index.ts for the export.',
    'First, I need to look at the build script.',
    "I'll review the schema definitions.",
  ])('rejects prospective preamble: %s', (answer) => {
    const result = validateQaResponse({
      answer,
      filesReferencedClaim: [],
      filesActuallyFetched: [],
      classification: 'on_topic',
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('prospective_non_answer')
  })

  it('accepts a short but SUBSTANTIVE answer (no false positive)', () => {
    // Conservative threshold must NOT reject legit short answers that
    // happen to be brief. This is the "false positive" guardrail.
    const result = validateQaResponse({
      answer: 'Zod uses ZodError.flatten() for this.',
      filesReferencedClaim: ['src/error.ts'],
      filesActuallyFetched: ['src/error.ts'],
      classification: 'on_topic',
    })
    expect(result.valid).toBe(true)
  })

  it('accepts a LONG answer that opens with "Let me explain..." followed by substance', () => {
    // The length gate prevents catching a long, substantive response
    // whose first phrase happens to be "Let me explain". Above the
    // threshold, the model has produced enough body that the leading
    // phrase is almost certainly framing, not preamble.
    const answer =
      'Let me explain the request lifecycle. When a request comes in, ' +
      'Flask routes it through werkzeug to the matching view function via ' +
      'the URL map. The view returns a Response object that the WSGI ' +
      'wrapper then serializes. Key files: src/flask/app.py for the App ' +
      'class and src/flask/wrappers.py for the Response. The dispatch ' +
      'happens in App.full_dispatch_request which calls preprocess_request ' +
      'first, then routes to the view, then runs after_request hooks.'
    const result = validateQaResponse({
      answer,
      filesReferencedClaim: ['src/flask/app.py', 'src/flask/wrappers.py'],
      filesActuallyFetched: ['src/flask/app.py', 'src/flask/wrappers.py'],
      classification: 'on_topic',
    })
    expect(result.valid).toBe(true)
  })

  it('hallucination check wins when both hallucination AND preamble apply', () => {
    // Order invariant: if the answer is a preamble AND cites a file
    // that was never fetched, the hallucination reason takes priority
    // because the retry text for hallucination is more actionable.
    const result = validateQaResponse({
      answer: "Let me check fake/path.ts.",
      filesReferencedClaim: ['fake/path.ts'],
      filesActuallyFetched: [],
      classification: 'on_topic',
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('hallucinated_file_references')
  })

  it('does NOT match "let me explain" mid-sentence (start-anchored)', () => {
    // The patterns are start-anchored. A real answer that uses "let me"
    // mid-sentence should not trip the check.
    const result = validateQaResponse({
      answer:
        'The auth module is in src/auth.ts. To clarify: let me note that ' +
        'this uses JWT, not session cookies.',
      filesReferencedClaim: ['src/auth.ts'],
      filesActuallyFetched: ['src/auth.ts'],
      classification: 'on_topic',
    })
    expect(result.valid).toBe(true)
  })
})
