export const runtime = 'edge'

import { NextResponse } from 'next/server'
import {
  GitHubClient,
  answerQuestion,
  buildInitialTelemetry,
  emitQaTelemetry,
  parseGitHubUrl,
  classifyQuestion,
  validateQaResponse,
  type LLMModelIntent,
  type QaTelemetry,
  type QAMessage,
} from '@reponboard/agent-core'
import {
  checkRateLimit,
  recordAnalysisCost,
  recordRequestStart,
} from '@/lib/rate-limit'

const GITHUB_URL_REGEX = /^https?:\/\/github\.com\/[\w][\w.-]*\/[\w][\w.-]*\/?$/i
// Code-level cap on the analysis. Verified empirically that
// Vercel Edge on the Hobby plan supports up to ~300s when the
// response is streamed (test endpoint /timeout-test ran 89.91s
// to completion). 120s gives Sonnet enough headroom for large
// repos while still bounding worst-case behavior.
const TIMEOUT_MS = 120_000
const MAX_QUESTION_LEN = 500
const MAX_HISTORY_ITEMS = 20

function getClientIp(request: Request): string {
  return (
    request.headers.get('x-real-ip')?.split(',')[0]?.trim() ??
    request.headers.get('x-forwarded-for') ??
    '127.0.0.1'
  )
}

interface QARequestBody {
  question: string
  repoUrl: string
  codebaseContext: string
  history: QAMessage[]
}

function parseBody(body: unknown): QARequestBody | string {
  if (typeof body !== 'object' || body === null) return 'Body must be an object'
  const b = body as Record<string, unknown>

  if (typeof b.question !== 'string' || b.question.trim() === '') {
    return 'question is required and must be a non-empty string'
  }
  if (b.question.length > MAX_QUESTION_LEN) {
    return `question must be ${MAX_QUESTION_LEN} characters or fewer`
  }
  if (typeof b.repoUrl !== 'string' || b.repoUrl.trim() === '') {
    return 'repoUrl is required and must be a non-empty string'
  }
  if (typeof b.codebaseContext !== 'string') {
    return 'codebaseContext is required and must be a string'
  }
  if (!Array.isArray(b.history)) {
    return 'history must be an array'
  }

  const history: QAMessage[] = []
  for (const item of b.history.slice(-MAX_HISTORY_ITEMS)) {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('role' in item) ||
      !('content' in item)
    ) {
      return 'history items must have role and content'
    }
    const it = item as Record<string, unknown>
    if (it.role !== 'user' && it.role !== 'assistant') {
      return 'history role must be "user" or "assistant"'
    }
    if (typeof it.content !== 'string') {
      return 'history content must be a string'
    }
    history.push({
      role: it.role,
      content: it.content,
      filesReferenced: Array.isArray(it.filesReferenced)
        ? it.filesReferenced.filter((f): f is string => typeof f === 'string')
        : [],
      timestamp: typeof it.timestamp === 'string' ? it.timestamp : '',
    })
  }

  return {
    question: b.question.trim(),
    repoUrl: b.repoUrl.trim(),
    codebaseContext: b.codebaseContext,
    history,
  }
}

export async function POST(request: Request): Promise<NextResponse | Response> {
  const startTime = Date.now()
  let telemetry: QaTelemetry | null = null

  const emit = (): void => {
    if (telemetry === null) return
    telemetry.finalLatencyMs = Date.now() - startTime
    emitQaTelemetry(telemetry)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = parseBody(body)
  if (typeof parsed === 'string') {
    return NextResponse.json({ error: parsed }, { status: 400 })
  }

  telemetry = buildInitialTelemetry({
    requestId: crypto.randomUUID(),
    repoUrl: parsed.repoUrl,
    question: parsed.question,
    historyLength: parsed.history.length,
  })

  if (!GITHUB_URL_REGEX.test(parsed.repoUrl)) {
    emit()
    return NextResponse.json(
      {
        error:
          'Please provide a valid GitHub repository URL — e.g. https://github.com/owner/repo',
      },
      { status: 400 },
    )
  }

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY
  if (anthropicApiKey === undefined || anthropicApiKey === '') {
    emit()
    return NextResponse.json(
      { error: 'Q&A is not available (ANTHROPIC_API_KEY not configured).' },
      { status: 503 },
    )
  }

  // Rate limit: Redis-backed Q&A scope. Counter increments up-front so
  // the slot is reserved even on stream abort; the shared daily budget
  // cap is charged only after a successful 'complete' event.
  const ip = getClientIp(request)
  const rateLimit = await checkRateLimit(ip, 'qa')
  if (!rateLimit.allowed) {
    const message =
      rateLimit.reason === 'budget_exceeded'
        ? 'Demo budget exhausted for today. Try again tomorrow or run locally.'
        : rateLimit.reason === 'global_limit'
          ? 'Q&A daily limit reached. Try again tomorrow or run locally.'
          : "You've used your Q&A allowance for today. Try again tomorrow or run locally."
    emit()
    return NextResponse.json(
      { error: message, reason: rateLimit.reason },
      { status: 429 },
    )
  }
  await recordRequestStart(ip, 'qa')

  let owner: string
  let repo: string
  let branch: string | null
  try {
    const parsedUrl = parseGitHubUrl(parsed.repoUrl)
    owner = parsedUrl.owner
    repo = parsedUrl.repo
    branch = parsedUrl.branch
  } catch (err) {
    emit()
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid repo URL' },
      { status: 400 },
    )
  }

  // Resolve default branch if none specified
  const githubToken = process.env.GITHUB_TOKEN ?? undefined
  let resolvedBranch = branch
  if (resolvedBranch === null) {
    try {
      const github = new GitHubClient(githubToken)
      const info = await github.getRepoInfo(owner, repo)
      resolvedBranch = info.defaultBranch
    } catch (err) {
      emit()
      return NextResponse.json(
        {
          error:
            err instanceof Error
              ? err.message
              : 'Failed to resolve default branch',
        },
        { status: 502 },
      )
    }
  }

  const classifyResult = await classifyQuestion({
    question: parsed.question,
    repoUrl: parsed.repoUrl,
    repoSummary: parsed.codebaseContext.slice(0, 500),
    anthropicApiKey,
  })
  telemetry.classification = classifyResult.result.classification
  telemetry.classifierConfidence = classifyResult.result.confidence
  telemetry.classifierLatencyMs = classifyResult.latencyMs
  telemetry.classifierDegradedMode = classifyResult.degradedMode

  const { classification, confidence } = classifyResult.result
  const isOffTopicShortcut =
    classification === 'off_topic' &&
    (confidence > 0.7 || classifyResult.degradedMode)
  const isClarificationShortcut =
    classification === 'needs_clarification' &&
    confidence > 0.7 &&
    !classifyResult.degradedMode
  const isShortcutPath = isOffTopicShortcut || isClarificationShortcut

  if (isShortcutPath) {
    const cannedAnswer =
      classification === 'off_topic'
        ? `I can only answer questions about ${parsed.repoUrl}. ${classifyResult.result.reasoning}`
        : `Could you clarify what you're asking? ${classifyResult.result.reasoning}`

    telemetry.finalCostUsd = classifyResult.costUsd
    const shortcutTelemetry = telemetry
    emit()

    const shortcutResult: Record<string, unknown> = {
      answer: cannedAnswer,
      filesReferenced: [],
      costUsd: classifyResult.costUsd,
      classification: classifyResult.result.classification,
      meta: {
        classifierConfidence: classifyResult.result.confidence,
        classifierDegradedMode: classifyResult.degradedMode,
      },
    }
    if (
      classification === 'off_topic' &&
      classifyResult.result.suggestions !== undefined
    ) {
      shortcutResult.suggestions = classifyResult.result.suggestions
    }

    const shortcutEncoder = new TextEncoder()
    const shortcutStream = new ReadableStream({
      start(controller) {
        try {
          controller.enqueue(
            shortcutEncoder.encode(
              JSON.stringify({ phase: 'complete', result: shortcutResult }) + '\n',
            ),
          )
        } catch (err) {
          if (shortcutTelemetry !== null) {
            shortcutTelemetry.fatalError =
              err instanceof Error ? err.message : String(err)
          }
          try {
            controller.enqueue(
              shortcutEncoder.encode(
                JSON.stringify({
                  phase: 'error',
                  error:
                    'Something went wrong. If this persists, please reload the page.',
                  errorCode: 'INTERNAL_ERROR',
                  requestId: shortcutTelemetry?.requestId ?? '',
                }) + '\n',
              ),
            )
          } catch {
            /* ignore */
          }
        }
        try {
          controller.close()
        } catch {
          /* ignore */
        }
      },
    })

    return new Response(shortcutStream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        'X-RateLimit-Remaining': String(rateLimit.remainingForIp),
      },
    })
  }

  const rawIntent = process.env.LLM_MODEL_INTENT
  const rawMode = process.env.LLM_MODE
  let intent: LLMModelIntent | undefined
  let llmMode: 'development' | 'production' = 'production'

  if (rawIntent === 'fast' || rawIntent === 'quality' || rawIntent === 'parity') {
    intent = rawIntent
  } else if (rawMode === 'development' || rawMode === 'production') {
    console.warn(
      '[env] LLM_MODE is deprecated. Set LLM_MODEL_INTENT to ' +
        '"fast" | "quality" | "parity" instead.',
    )
    llmMode = rawMode
  }

  const initialTelemetry = telemetry === null ? undefined : telemetry
  const generator = answerQuestion(
    parsed.question,
    { owner, repo, branch: resolvedBranch },
    parsed.codebaseContext,
    parsed.history,
    anthropicApiKey,
    githubToken,
    llmMode,
    intent,
    initialTelemetry,
  )

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false

      const closeStream = (errorMsg?: string): void => {
        if (closed) return
        closed = true
        if (errorMsg !== undefined) {
          try {
            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  phase: 'error',
                  error: errorMsg,
                  errorCode: 'INTERNAL_ERROR',
                  requestId: telemetry?.requestId ?? '',
                }) + '\n',
              ),
            )
          } catch {
            /* ignore */
          }
        }
        try {
          controller.close()
        } catch {
          /* ignore */
        }
      }

      const timeout = setTimeout(
        () =>
          closeStream(
            'Q&A timed out. Try rephrasing or asking a more specific question.',
          ),
        TIMEOUT_MS,
      )

      const filesActuallyFetched = new Set<string>()

      const trackFetchedFiles = (event: {
        phase: string
        toolCall?: string
        toolInput?: Record<string, unknown>
      }): void => {
        if (event.phase === 'thinking' && event.toolCall === 'fetch_file') {
          const path = event.toolInput?.path
          if (typeof path === 'string') {
            filesActuallyFetched.add(path)
          }
        }
      }

      try {
        for await (const event of generator) {
          if (closed) break
          trackFetchedFiles(event)
          // Charge the shared daily budget only on successful completion.
          // Errors and the timeout path skip this.
          if (event.phase === 'complete') {
            const enrichedResult = {
              ...event.result,
              costUsd: (event.result.costUsd ?? 0) + classifyResult.costUsd,
              classification: classifyResult.result.classification,
              meta: {
                classifierConfidence: classifyResult.result.confidence,
                classifierDegradedMode: classifyResult.degradedMode,
              },
            }

            const validation = validateQaResponse({
              answer: event.result.answer,
              filesReferencedClaim: event.result.filesReferenced,
              filesActuallyFetched: Array.from(filesActuallyFetched),
              classification: classifyResult.result.classification,
            })

            if (
              validation.valid === false &&
              telemetry !== null &&
              telemetry.retryCount === 0
            ) {
              telemetry.responseRejectedByValidator = true
              telemetry.retryCount = 1
              if (validation.hallucinatedFiles !== undefined) {
                telemetry.hallucinatedFileReferences =
                  validation.hallucinatedFiles
              }

              const reasonText =
                validation.reason === 'hallucinated_file_references'
                  ? 'referenced files you did not fetch in this turn'
                  : 'summarized previous answers instead of answering directly'
              const hardenedQuestion =
                `IMPORTANT: Your previous response was rejected because it ${reasonText}. ` +
                `Answer the current question fresh using ONLY files you actually fetch_file in this turn. ` +
                `Do not recapitulate prior context.\n\n` +
                `Original question: ${parsed.question}`

              const retryTelemetry = telemetry === null ? undefined : telemetry
              const retryGenerator = answerQuestion(
                hardenedQuestion,
                { owner, repo, branch: resolvedBranch },
                parsed.codebaseContext,
                parsed.history,
                anthropicApiKey,
                githubToken,
                llmMode,
                intent,
                retryTelemetry,
              )

              let retryHandled = false
              for await (const retryEvent of retryGenerator) {
                if (closed) break
                trackFetchedFiles(retryEvent)
                if (retryEvent.phase === 'complete') {
                  const retryEnriched = {
                    ...retryEvent.result,
                    costUsd:
                      (event.result.costUsd ?? 0) +
                      (retryEvent.result.costUsd ?? 0) +
                      classifyResult.costUsd,
                    classification: classifyResult.result.classification,
                    meta: {
                      classifierConfidence: classifyResult.result.confidence,
                      classifierDegradedMode: classifyResult.degradedMode,
                    },
                  }

                  const retryValidation = validateQaResponse({
                    answer: retryEvent.result.answer,
                    filesReferencedClaim: retryEvent.result.filesReferenced,
                    filesActuallyFetched: Array.from(filesActuallyFetched),
                    classification: classifyResult.result.classification,
                  })

                  if (retryValidation.valid === true) {
                    const retryCostUsd = retryEnriched.costUsd
                    if (telemetry !== null) {
                      telemetry.finalCostUsd = retryCostUsd
                    }
                    if (retryCostUsd > 0) {
                      void recordAnalysisCost(retryCostUsd).catch((err) => {
                        console.warn(
                          '[rate-limit] recordAnalysisCost failed',
                          err,
                        )
                      })
                    }
                    controller.enqueue(
                      encoder.encode(
                        JSON.stringify({
                          phase: 'complete',
                          result: retryEnriched,
                        }) + '\n',
                      ),
                    )
                  } else {
                    const cannedResult = {
                      answer:
                        "I had trouble grounding my answer in this repository's actual files. " +
                        "Could you rephrase the question or be more specific about which part of the codebase you're asking about?",
                      filesReferenced: [],
                      costUsd:
                        (event.result.costUsd ?? 0) +
                        (retryEvent.result.costUsd ?? 0) +
                        classifyResult.costUsd,
                      classification: 'on_topic' as const,
                      meta: {
                        classifierConfidence: classifyResult.result.confidence,
                        classifierDegradedMode: classifyResult.degradedMode,
                      },
                    }
                    if (telemetry !== null) {
                      telemetry.finalCostUsd = cannedResult.costUsd
                    }
                    if (cannedResult.costUsd > 0) {
                      void recordAnalysisCost(cannedResult.costUsd).catch(
                        (err) => {
                          console.warn(
                            '[rate-limit] recordAnalysisCost failed',
                            err,
                          )
                        },
                      )
                    }
                    controller.enqueue(
                      encoder.encode(
                        JSON.stringify({
                          phase: 'complete',
                          result: cannedResult,
                        }) + '\n',
                      ),
                    )
                  }
                  retryHandled = true
                  break
                } else {
                  controller.enqueue(
                    encoder.encode(JSON.stringify(retryEvent) + '\n'),
                  )
                }
              }

              if (!retryHandled && !closed) {
                const cannedResult = {
                  answer:
                    "I had trouble grounding my answer in this repository's actual files. " +
                    "Could you rephrase the question or be more specific about which part of the codebase you're asking about?",
                  filesReferenced: [],
                  costUsd:
                    (event.result.costUsd ?? 0) + classifyResult.costUsd,
                  classification: 'on_topic' as const,
                  meta: {
                    classifierConfidence: classifyResult.result.confidence,
                    classifierDegradedMode: classifyResult.degradedMode,
                  },
                }
                if (telemetry !== null) {
                  telemetry.finalCostUsd = cannedResult.costUsd
                }
                if (cannedResult.costUsd > 0) {
                  void recordAnalysisCost(cannedResult.costUsd).catch(
                    (err) => {
                      console.warn(
                        '[rate-limit] recordAnalysisCost failed',
                        err,
                      )
                    },
                  )
                }
                controller.enqueue(
                  encoder.encode(
                    JSON.stringify({
                      phase: 'complete',
                      result: cannedResult,
                    }) + '\n',
                  ),
                )
              }
              break
            }

            if (validation.valid === false) {
              // Defensive: validator rejected AND we've already retried (or
              // telemetry is null). Emit canned fallback.
              const cannedResult = {
                answer:
                  "I had trouble grounding my answer in this repository's actual files. " +
                  "Could you rephrase the question or be more specific about which part of the codebase you're asking about?",
                filesReferenced: [],
                costUsd: enrichedResult.costUsd,
                classification: 'on_topic' as const,
                meta: {
                  classifierConfidence: classifyResult.result.confidence,
                  classifierDegradedMode: classifyResult.degradedMode,
                },
              }
              if (telemetry !== null) {
                telemetry.finalCostUsd = cannedResult.costUsd
              }
              if (cannedResult.costUsd > 0) {
                void recordAnalysisCost(cannedResult.costUsd).catch((err) => {
                  console.warn('[rate-limit] recordAnalysisCost failed', err)
                })
              }
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({
                    phase: 'complete',
                    result: cannedResult,
                  }) + '\n',
                ),
              )
              break
            }

            const costUsd = enrichedResult.costUsd
            if (telemetry !== null) {
              telemetry.finalCostUsd = costUsd
            }
            if (costUsd > 0) {
              void recordAnalysisCost(costUsd).catch((err) => {
                console.warn('[rate-limit] recordAnalysisCost failed', err)
              })
            }
            controller.enqueue(
              encoder.encode(
                JSON.stringify({ phase: 'complete', result: enrichedResult }) + '\n',
              ),
            )
          } else {
            controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
          }
        }
      } catch (err) {
        const status =
          typeof err === 'object' && err !== null && 'status' in err
            ? (err as { status?: unknown }).status
            : undefined
        const errorCode =
          status === 529
            ? 'UPSTREAM_OVERLOADED'
            : status === 503
              ? 'UPSTREAM_UNAVAILABLE'
              : 'INTERNAL_ERROR'
        const errorMessage =
          errorCode === 'UPSTREAM_OVERLOADED'
            ? 'Service temporarily unavailable. Please try again in a moment.'
            : errorCode === 'UPSTREAM_UNAVAILABLE'
              ? 'Connection issue. Please try again.'
              : 'Something went wrong. If this persists, please reload the page.'
        if (telemetry !== null) {
          telemetry.fatalError =
            err instanceof Error ? err.message : String(err)
        }
        if (!closed) {
          closed = true
          try {
            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  phase: 'error',
                  error: errorMessage,
                  errorCode,
                  requestId: telemetry?.requestId ?? '',
                }) + '\n',
              ),
            )
          } catch {
            /* ignore */
          }
          try {
            controller.close()
          } catch {
            /* ignore */
          }
        }
      } finally {
        clearTimeout(timeout)
        closeStream()
        emit()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'X-RateLimit-Remaining': String(rateLimit.remainingForIp),
    },
  })
}
