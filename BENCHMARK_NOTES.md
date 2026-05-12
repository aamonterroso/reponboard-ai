# Block G — Benchmark Run Notes

Operational journal for the systematic Haiku 4.5 vs Sonnet 4.6 benchmark of
the `reponboard-ai` analysis pipeline. Data lives in
`benchmark-results/block-g-final-canonical/`; this document captures the
provenance, the things that went wrong, and what's safe to publish.

## Scope

- 2 repos × 2 intents × 10 runs = 40 target runs
- Repos: `colinhacks/zod` (TS, ~600 entries), `pallets/flask` (Python, ~280 entries)
- Intents: `fast` → `claude-haiku-4-5-20251001`, `quality` → `claude-sonnet-4-6`
- Metrics captured per run: latency, tokens in/out, $ cost, tool call count,
  defensive-coercion flag (`truncated`) and which fields fell back.

## Final dataset

40 runs total, 38 successes (95%). Files in `benchmark-results/block-g-final-canonical/`.

| Quadrant | N | Success | p50 latency | Cost mean | Truncation |
|---|---|---|---|---|---|
| zod fast (Haiku) | 10 | 10 | 46.8s | $0.057 | 20% |
| zod quality (Sonnet) | 10 | 10 | 76.5s | $0.167 | 40% |
| flask fast (Haiku) | 10 | 9 | 31.8s | $0.048 | 20% |
| flask quality (Sonnet) | 10 | 9 | 67.5s | $0.135 | 40% |

## Headline observations

- **Cost ratio tracks pricing exactly.** Sonnet ≈ 3× Haiku per analysis,
  matching the $3/$1 input price tier.
- **Latency ratio ≈ 1.5–1.8× Sonnet vs Haiku** on clean runs.
- **Truncation is intent-driven, not repo-driven.** Sonnet hit defensive
  coercion (`truncated: true`) on 40% of runs across *both* repos; Haiku on
  20%. Counter-intuitive — Sonnet needed more forced-finish calls because it
  ran the tool budget out trying to look at more files.
- **Tool calls inverted from latency.** Sonnet averaged fewer exploration
  tool calls (5.4–6.0) than Haiku (6.2–7.1) but each call processed more
  tokens.

## Caveats for anyone using this dataset

1. **flask/fast has one 874s outlier.** GitHub fetch hung, eventually
   surfaced as `Network error fetching /repos/pallets/flask: fetch failed`.
   The other 9 runs cluster in 28.8–34.0s. When graphing, use median or drop
   that record; the mean is misleading.
2. **flask/quality has one 10s GitHub fetch fail.** Fast-failing (not a
   hang). The 9 successes are clean and tight (49.9–74.3s).
3. **Anthropic API timeouts are silent for now.** Our pipeline doesn't set
   per-request timeouts on `Anthropic.messages.create`. A stuck TCP socket
   can block a single run for tens of minutes. We hit this hard on the first
   Q4 attempt — see "What went wrong" below. The retry under `caffeinate`
   was clean.
4. **Prices in `pricing.ts` were verified against Anthropic's published
   rates in May 2026.** Anthropic occasionally updates pricing — if
   reproducing this benchmark later, reverify against docs.claude.com
   before trusting cost numbers.

## What went wrong (and the fix)

### Original Q3 (flask fast) attempt — 57-minute socket hang
The forced `finish_core` Anthropic API call on run 1 never returned. Most
likely root cause: a shell process inspection accidentally suspended the
running task, leaving the TCP socket open with no reader. The pipeline
doesn't set per-request timeouts, so the process blocked silently. Killed
manually, no JSONL produced. Same root cause shape as the Q4 disaster:
missing per-request timeout + an environmental issue = unbounded wait.

### Q3 retry — completed with 1 outlier
9 runs in 28.8–34.0s. Run 4 hung on a GitHub fetch for 14.6 min before
surfacing `fetch failed`. Kept the JSONL as-is; the failure is honest data.

### Original Q4 (flask quality) attempt — disaster
50% success rate. 4 Anthropic `Request timed out` failures, plus latencies
of 13/14/43 minutes on the "successes". Root cause was almost certainly
macOS App Nap putting network sockets to sleep — the machine was idle
during the long batch.
- Discarded entirely (file preserved in `benchmark-results/q4-contaminated-attempt1/`
  locally, gitignored).

### Q4 retry under `caffeinate -dimsu` — clean
9/10 success, latencies 49.9–74.3s, no Anthropic timeouts at all. The
caffeinate wrap confirmed the prior failures were environmental, not a
service-side incident.

## Process changes to make before next batch

1. **Per-Anthropic-call timeout** in `llm-analysis.ts` (e.g., 60s via
   `AbortController`). Converts socket hangs into clean `success: false`.
2. **Per-run wall-clock timeout** in `scripts/benchmark.ts` (e.g., 180s).
   Same goal at the harness level.
3. **Always wrap long batches in `caffeinate -dimsu`** on macOS, or run on
   a non-sleeping machine.

## File organization

- `benchmark-results/block-g-final-canonical/` — the 4 JSONLs + README,
  tracked in git.
- `benchmark-results/sanity-test/` — pre-batch single-run smoke test,
  gitignored.
- `benchmark-results/validation-pre-block-g/` — runs from the original
  instrumentation PR validation, gitignored.
- `benchmark-results/q4-contaminated-attempt1/` — the discarded original Q4
  attempt, gitignored. Kept locally for forensic reference.
- Other loose `*.jsonl` files in `benchmark-results/` (the original 4
  canonical files) — gitignored at the root pattern level. The canonical
  copies inside the subdirectory are whitelisted via `.gitignore` negation.

## Reproducing the summary

```bash
pnpm bench:summary
```

Walks every `.jsonl` under `benchmark-results/`, groups by `(repo, intent)`,
prints a markdown table with p50/p95/mean/min/max latency, mean/total cost,
truncation rate, and avg tool calls.
