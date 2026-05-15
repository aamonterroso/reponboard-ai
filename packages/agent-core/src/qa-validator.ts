export interface ValidationResult {
  valid: boolean
  reason?: 'hallucinated_file_references' | 'recap_detected'
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

  return { valid: true }
}
