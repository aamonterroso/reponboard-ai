import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import minimist from 'minimist'
import type { BenchmarkRecord } from '@reponboard/agent-core'

interface CliArgs {
  input: string
}

function parseArgs(): CliArgs {
  const argv = minimist(process.argv.slice(2), {
    string: ['input'],
    default: { input: 'benchmark-results/block-g-final-canonical' },
  })
  return { input: String(argv.input) }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

interface GroupStats {
  count: number
  successes: number
  successRate: number
  latencyP50: number
  latencyP95: number
  latencyMean: number
  latencyMin: number
  latencyMax: number
  costMean: number
  costTotal: number
  truncationRate: number
  avgToolCalls: number
}

function computeStats(records: BenchmarkRecord[]): GroupStats {
  const count = records.length
  const successes = records.filter((r) => r.success).length
  const latencies = records.map((r) => r.totalLatencyMs).sort((a, b) => a - b)
  const costs = records.map((r) => r.totalCostUsd)
  const truncated = records.filter(
    (r) => r.core?.truncated === true || r.guide?.truncated === true,
  ).length
  const toolCalls = records.map(
    (r) => (r.core?.toolCallCount ?? 0) + (r.guide?.toolCallCount ?? 0),
  )

  return {
    count,
    successes,
    successRate: count > 0 ? successes / count : 0,
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
    latencyMean: Math.round(mean(latencies)),
    latencyMin: latencies[0] ?? 0,
    latencyMax: latencies[latencies.length - 1] ?? 0,
    costMean: mean(costs),
    costTotal: costs.reduce((a, b) => a + b, 0),
    truncationRate: count > 0 ? truncated / count : 0,
    avgToolCalls: mean(toolCalls),
  }
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

function repoSlug(url: string): string {
  return url.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '')
}

function main(): void {
  const args = parseArgs()
  const dir = resolve(args.input)
  const files = readdirSync(dir, { recursive: true })
    .map((entry) => (typeof entry === 'string' ? entry : entry.toString()))
    .filter((f) => f.endsWith('.jsonl'))
  if (files.length === 0) {
    console.error(`[SUMMARY] no .jsonl files found in ${dir}`)
    process.exit(1)
  }

  const all: BenchmarkRecord[] = []
  for (const file of files) {
    const contents = readFileSync(join(dir, file), 'utf8')
    for (const line of contents.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      const jsonStart = trimmed.indexOf('{')
      if (jsonStart === -1) continue
      try {
        const record = JSON.parse(trimmed.slice(jsonStart)) as BenchmarkRecord
        all.push(record)
      } catch {
        console.error(`[SUMMARY] failed to parse line in ${file}`)
      }
    }
  }

  const groups = new Map<string, BenchmarkRecord[]>()
  for (const r of all) {
    const key = `${repoSlug(r.repoUrl)}|${r.intent}`
    const list = groups.get(key) ?? []
    list.push(r)
    groups.set(key, list)
  }

  console.log('# Benchmark Summary\n')
  console.log(
    '| Repo | Intent | N | Success | Latency p50 | p95 | Mean | Min | Max | Cost mean | Cost total | Truncation | Avg tool calls |',
  )
  console.log(
    '|------|--------|---|---------|-------------|-----|------|-----|-----|-----------|------------|------------|----------------|',
  )

  const sortedKeys = Array.from(groups.keys()).sort()
  for (const key of sortedKeys) {
    const [repo, intent] = key.split('|')
    const stats = computeStats(groups.get(key) ?? [])
    console.log(
      `| ${repo} | ${intent} | ${stats.count} | ${fmtPct(stats.successRate)} | ${stats.latencyP50}ms | ${stats.latencyP95}ms | ${stats.latencyMean}ms | ${stats.latencyMin}ms | ${stats.latencyMax}ms | ${fmtUsd(stats.costMean)} | ${fmtUsd(stats.costTotal)} | ${fmtPct(stats.truncationRate)} | ${stats.avgToolCalls.toFixed(1)} |`,
    )
  }
}

main()
