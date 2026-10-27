import Anthropic from '@anthropic-ai/sdk'
import { withAnthropicRetry } from './anthropic-retry'
import { addUsage, calculateCost, createUsageTotals } from './pricing'
import { buildTraceLlmCall } from './trace'
import type { TraceLlmCall } from './types'

// Orchestrator–worker fan-out. Before the main ReAct loop starts, cheap
// Haiku 5.5 workers each read one secondary key file and return a short
// summary, in parallel. The orchestrator (Sonnet 5.5 on the quality
// tier) starts with compressed context for files it would otherwise
// spend tool calls fetching, while the raw top-3 prefetch stays as-is.

export const WORKER_MODEL = 'claude-haiku-5-5'
const WORKER_MAX_TOKENS = 1024
const WORKER_INPUT_CHARS = 6000

export interface FileSummary {
  path: string
  summary: string
}

export interface WorkerRunResult {
  summaries: FileSummary[]
  // One trace entry per successful worker call, for the AI Lab.
  traces: TraceLlmCall[]
  calls: number
  latencyMs: number
  costUsd: number
}

const WORKER_SYSTEM = `You summarize one source file for an engineer who is building an onboarding guide for the repository.

Write 2-3 sentences: what the file is responsible for, the main exports or entry points it defines, and how it connects to the rest of the codebase. Name concrete functions, classes, or config keys. No preamble, no markdown headings.`

async function summarizeFile(
  client: Anthropic,
  path: string,
  content: string,
): Promise<{ summary: string; trace: TraceLlmCall; usage: Anthropic.Usage }> {
  const start = Date.now()
  const response = await withAnthropicRetry(
    () =>
      client.messages.create({
        model: WORKER_MODEL,
        max_tokens: WORKER_MAX_TOKENS,
        system: WORKER_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `File: ${path}\n\n\`\`\`\n${content.slice(0, WORKER_INPUT_CHARS)}\n\`\`\``,
          },
        ],
        output_config: { effort: 'low' },
      }),
    { maxAttempts: 2, baseDelayMs: 500 },
  )
  const summary = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
  const trace = buildTraceLlmCall({
    step: 0,
    stage: 'workers',
    model: WORKER_MODEL,
    latencyMs: Date.now() - start,
    response,
  })
  return { summary, trace, usage: response.usage }
}

// Runs one worker per file, all concurrently. A failed worker drops its
// file rather than failing the analysis — the orchestrator can still
// fetch that file itself.
export async function summarizeFilesWithWorkers(
  client: Anthropic,
  files: Map<string, string>,
): Promise<WorkerRunResult> {
  const start = Date.now()
  const entries = Array.from(files.entries())
  const settled = await Promise.allSettled(
    entries.map(([path, content]) => summarizeFile(client, path, content)),
  )

  const usage = createUsageTotals()
  const summaries: FileSummary[] = []
  const traces: TraceLlmCall[] = []
  settled.forEach((outcome, i) => {
    const path = entries[i]?.[0]
    if (path === undefined) return
    if (outcome.status === 'rejected') {
      console.warn(`[workers] summary failed for ${path}`, outcome.reason)
      return
    }
    addUsage(usage, outcome.value.usage)
    traces.push(outcome.value.trace)
    if (outcome.value.summary !== '') {
      summaries.push({ path, summary: outcome.value.summary })
    }
  })

  return {
    summaries,
    traces,
    calls: entries.length,
    latencyMs: Date.now() - start,
    costUsd: calculateCost(WORKER_MODEL, usage),
  }
}

export function formatWorkerSummaries(summaries: FileSummary[]): string {
  if (summaries.length === 0) return ''
  const lines = summaries.map((s) => `- ${s.path}: ${s.summary}`)
  return `\n\nWorker summaries of further key files (read by a helper model; fetch a file yourself only if you need its exact code):\n${lines.join('\n')}`
}
