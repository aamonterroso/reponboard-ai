import { appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import minimist from 'minimist'
import { runBenchmarkAnalysis } from '@reponboard/agent-core'

const REPO_ALIASES: Record<string, string> = {
  zod: 'https://github.com/colinhacks/zod',
  flask: 'https://github.com/pallets/flask',
}

interface CliArgs {
  repo: string
  intent: 'fast' | 'quality'
  runs: number
  output: string
  sleep: number
}

function parseArgs(): CliArgs {
  const argv = minimist(process.argv.slice(2), {
    string: ['repo', 'intent', 'output'],
    default: {
      runs: 10,
      output: 'benchmark-results',
      sleep: 3000,
    },
  })

  const repo = argv.repo as string | undefined
  if (repo === undefined || REPO_ALIASES[repo] === undefined) {
    throw new Error(
      `--repo must be one of: ${Object.keys(REPO_ALIASES).join(', ')}`,
    )
  }
  const intent = argv.intent as string | undefined
  if (intent !== 'fast' && intent !== 'quality') {
    throw new Error('--intent must be "fast" or "quality"')
  }
  const runs = Number(argv.runs)
  if (!Number.isFinite(runs) || runs < 1) {
    throw new Error('--runs must be a positive integer')
  }
  const sleep = Number(argv.sleep)
  if (!Number.isFinite(sleep) || sleep < 0) {
    throw new Error('--sleep must be >= 0')
  }
  return {
    repo,
    intent,
    runs,
    output: String(argv.output),
    sleep,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

async function main(): Promise<void> {
  const args = parseArgs()
  const repoUrl = REPO_ALIASES[args.repo]
  const batchTimestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = resolve(args.output)
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, `${args.repo}-${args.intent}-${batchTimestamp}.jsonl`)

  let successes = 0
  let failures = 0
  let totalLatency = 0

  for (let i = 1; i <= args.runs; i++) {
    process.stderr.write(`\n[BENCH] run ${i}/${args.runs} (${args.repo}, ${args.intent})\n`)
    const record = await runBenchmarkAnalysis(repoUrl, args.intent)
    const line = `[BENCH] ${JSON.stringify(record)}`
    console.log(line)
    appendFileSync(outFile, line + '\n')

    if (record.success) successes++
    else failures++
    totalLatency += record.totalLatencyMs

    if (i < args.runs) await sleep(args.sleep)
  }

  const meanLatency = args.runs > 0 ? Math.round(totalLatency / args.runs) : 0
  process.stderr.write(
    `\n[BENCH] summary: ${args.runs} runs, ${successes} success, ${failures} failure, mean latency ${meanLatency}ms\n`,
  )
  process.stderr.write(`[BENCH] wrote: ${outFile}\n`)
}

main().catch((err) => {
  console.error('[BENCH] fatal:', err)
  process.exit(1)
})
