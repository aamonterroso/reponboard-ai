// Safe extractor for the `error` field of a JSON error response body.
//
// API routes in this app respond with `{error: <string>}` on 4xx/5xx
// failures. But several layers above the app code may inject a
// non-string `error` payload before our handler runs:
//   - Vercel platform errors  → {error: {code, id, message}}
//   - Middleware / proxies    → arbitrary error shapes
//   - Network / framework     → empty body, HTML, malformed JSON
//
// Rendering any of those non-string shapes directly inside JSX crashes
// the app with React error #31 ("Objects are not valid as a React
// child"). This helper guarantees the caller always gets a string —
// either the upstream error message verbatim (when it's a non-empty
// string) or a fallback the caller controls.

export function extractErrorMessage(
  body: unknown,
  fallback: string,
): string {
  if (typeof body !== 'object' || body === null) return fallback
  const err = (body as Record<string, unknown>).error
  if (typeof err === 'string' && err !== '') return err
  return fallback
}
