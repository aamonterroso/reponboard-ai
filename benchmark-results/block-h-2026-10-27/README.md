# Block H — Claude 5.5 Benchmark Dataset

Haiku 5.5 vs Sonnet 5.5 on the `reponboard-ai` analysis pipeline after the
October 2026 modernization (prompt caching, strict tools, worker fan-out,
parallel tools, system-message steering). Run window: 2026-10-27, from a
clean worktree of `main` at `8afad23`.

| File | Quadrant | Model | N |
|---|---|---|---|
| `zod-fast-*.jsonl` | zod / fast | `claude-haiku-5-5` | 10 |
| `zod-quality-*.jsonl` | zod / quality | `claude-sonnet-5-5` | 10 |
| `flask-fast-*.jsonl` | flask / fast | `claude-haiku-5-5` | 10 |
| `flask-quality-*.jsonl` | flask / quality | `claude-sonnet-5-5` | 10 |

Each line is one `BenchmarkRecord` (now with `cacheReadTokens`,
`cacheWriteTokens`, and core-phase `workers`). Regenerate the table with
`pnpm bench:summary --input benchmark-results/block-h-2026-10-27`.
Comparison with Block G and caveats: `BENCHMARK_NOTES.md`.
