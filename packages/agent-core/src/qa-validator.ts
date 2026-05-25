export interface ValidationResult {
  valid: boolean
  reason?:
    | 'hallucinated_file_references'
    | 'recap_detected'
    | 'prospective_non_answer'
  hallucinatedFiles?: string[]
}

const RECAP_PATTERNS: RegExp[] = [
  /I've (already|previously) (provided|answered|explained|covered|mentioned|noted|discussed)/i,
  /As I (mentioned|said|noted|explained|covered) (above|previously|earlier|before)/i,
  /in my (previous|earlier|prior) (answer|response|reply)/i,
  /(as|like) I said (before|earlier|previously)/i,
  /to (recap|summarize what I've said|reiterate)/i,
  /(building on|expanding on) (my|the) (previous|earlier|prior) (answer|response)/i,
  /referring back to (my|the) (previous|earlier|prior) (answer|response)/i,
  /going back to (what I said|my previous answer)/i,
]

// Prospective "I'm about to do X" patterns — the agent announces a
// future action instead of answering. Tested only against the START of
// the trimmed answer so that a long real response that happens to
// contain "let me explain" mid-paragraph isn't mistakenly rejected.
// All patterns are anchored with ^.
const PROSPECTIVE_PATTERNS: RegExp[] = [
  /^let me (look|check|examine|see|investigate|verify|explore|search|find|review|inspect|read)/i,
  /^let me first /i,
  /^i'?ll (look|check|examine|see|investigate|verify|explore|search|find|need|review|inspect|read)/i,
  /^i (need|want|have) to (look|check|examine|see|investigate|verify|explore|search|find|review|read)/i,
  /^i will (look|check|examine|see|investigate|verify|explore|search|find|review|read)/i,
  /^before (i answer|answering|i can answer|i respond)/i,
  /^first,? (let me|i('?ll| will| need to))/i,
  /^(give me a moment|hold on) /i,
]

// Conservative length threshold for the prospective-answer check.
// Below this many characters, an answer that starts with a prospective
// pattern is almost certainly a preamble with no substance. Above this,
// the model has produced enough body text that the leading phrase is
// most likely "Let me explain X: ... <actual answer> ..." which we
// should NOT reject. Tuned to be permissive for short legit answers
// (e.g. "Zod uses ZodError.flatten() for this.") while catching the
// known failure modes (e.g. "Let me look at the source code before
// answering." at ~50 chars).
const PROSPECTIVE_MAX_LEN = 200

export function validateQaResponse(input: {
  answer: string
  filesReferencedClaim: string[]
  filesActuallyFetched: string[]
  classification: 'on_topic' | 'off_topic' | 'needs_clarification'
}): ValidationResult {
  if (
    input.classification === 'off_topic' ||
    input.classification === 'needs_clarification'
  ) {
    return { valid: true }
  }

  const fetched = new Set(input.filesActuallyFetched)
  const hallucinated = input.filesReferencedClaim.filter((p) => !fetched.has(p))
  if (hallucinated.length > 0) {
    return {
      valid: false,
      reason: 'hallucinated_file_references',
      hallucinatedFiles: hallucinated,
    }
  }

  for (const pattern of RECAP_PATTERNS) {
    if (pattern.test(input.answer)) {
      return { valid: false, reason: 'recap_detected' }
    }
  }

  // Prospective non-answer: a short response that opens with a future-
  // intent phrase ("Let me look at...", "I'll check..."). The length
  // gate prevents false positives on long answers that legitimately
  // begin with "Let me explain". Order matters: this check runs LAST
  // so hallucination and recap (which carry richer retry context) win
  // when multiple conditions apply.
  const trimmed = input.answer.trim()
  if (trimmed.length > 0 && trimmed.length < PROSPECTIVE_MAX_LEN) {
    for (const pattern of PROSPECTIVE_PATTERNS) {
      if (pattern.test(trimmed)) {
        return { valid: false, reason: 'prospective_non_answer' }
      }
    }
  }

  return { valid: true }
}
