# Block G — Canonical Benchmark Dataset

Final dataset for the Haiku 4.5 vs Sonnet 4.6 systematic benchmark of the
`reponboard-ai` analysis pipeline. Run window: 2026-05-12.

## Files

| File | Quadrant | Model | N |
|---|---|---|---|
| `zod-fast-2026-05-12T05-22-09-690Z.jsonl` | zod / fast | `claude-haiku-4-5-20251001` | 10 |
| `zod-quality-2026-05-12T05-47-47-922Z.jsonl` | zod / quality | `claude-sonnet-4-6` | 10 |
| `flask-fast-2026-05-12T07-19-36-491Z.jsonl` | flask / fast | `claude-haiku-4-5-20251001` | 10 |
| `flask-quality-2026-05-12T17-35-39-594Z.jsonl` | flask / quality | `claude-sonnet-4-6` | 10 |

Each line is one `BenchmarkRecord` produced by `scripts/benchmark.ts`. Run
`pnpm bench:summary` from the repo root to regenerate the aggregated table.

## Headline numbers

| Repo | Intent | Success | p50 | p95 | Cost mean | Truncation | Avg tool calls |
|---|---|---|---|---|---|---|---|
| colinhacks/zod | fast | 10/10 | 46.8s | 50.7s | $0.057 | 20% | 7.1 |
| colinhacks/zod | quality | 10/10 | 76.5s | 88.0s | $0.167 | 40% | 6.0 |
| pallets/flask | fast | 9/10 | 31.8s | 874.2s* | $0.048 | 20% | 6.2 |
| pallets/flask | quality | 9/10 | 67.5s | 74.3s | $0.135 | 40% | 5.4 |

*flask/fast p95 is dominated by one 874s network-hang failure. The 9 healthy
runs cluster in 28.8–34.0s. See `BENCHMARK_NOTES.md` for caveats.

## Reproducibility

- Bench harness: `scripts/benchmark.ts` + `packages/agent-core/src/benchmark.ts`
- Pricing source: `packages/agent-core/src/pricing.ts` (May 2026 rates)
- Runtime: macOS, wrapped in `caffeinate -dimsu` for flask-quality after sleep
  contamination on attempt 1
- Auth: `ANTHROPIC_API_KEY` + `GITHUB_TOKEN` (5000 req/hr authenticated)
- Sleep between runs: 3000ms (default)
- Intent → model mapping: `fast` → Haiku 4.5, `quality` → Sonnet 4.6

## What "canonical" means here

These 4 files are the dataset used for the published analysis. Other JSONLs
that existed during the run window (validation runs, sanity tests, an
abandoned Q4 attempt contaminated by macOS App Nap) are kept locally but
intentionally not tracked. See `BENCHMARK_NOTES.md` for the full history.
