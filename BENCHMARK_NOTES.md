# Benchmark Run Notes

Two benchmarks on the same protocol: **Block H** (Oct 2026, Claude 5.5,
first section) and **Block G** (May 2026, previous generation, kept
verbatim below).

# Block H — Claude 5.5 + agent patterns (2026-10-27)

Same protocol as Block G: 2 repos × 2 intents × 10 runs, `caffeinate
-dimsu`, 3s sleep between runs, authenticated GitHub, run from a clean
worktree of `main` at `8afad23` (PR #17). Data:
`benchmark-results/block-h-2026-10-27/`.

What changed between G and H (all at once — this is a before/after of the
whole modernization, not an ablation of each lever):

- Models: `fast` Haiku 4.5 → **Haiku 5.5**; `quality` Sonnet 4.6 → **Sonnet 5.5**
- Prompt caching (auto `cache_control`, one tool list across phases)
- Strict tool use on `finish_core` / `finish_guide`
- Forced `tool_choice` replaced by system-message steering
- Parallel tool execution; Haiku 5.5 worker summaries of 5 secondary files
- Adaptive thinking, effort `medium`; per-call (60s) and per-run (180s) timeouts

## Results (`pnpm bench:summary --input benchmark-results/block-h-2026-10-27`)

| Quadrant | N | Success | p50 | p95 | Cost mean | Truncation | Avg tool calls | Cache hit |
|---|---|---|---|---|---|---|---|---|
| zod fast (Haiku 5.5) | 10 | 10 | 26.7s | 29.6s | $0.0059 | 0% | 5.6 | 71% |
| zod quality (Sonnet 5.5) | 10 | 10 | 23.9s | 43.6s | $0.0702 | 0% | 3.7 | 64% |
| flask fast (Haiku 5.5) | 10 | 10 | 20.5s | 22.9s | $0.0026 | 0% | 3.7 | 88% |
| flask quality (Sonnet 5.5) | 10 | 10 | 23.2s | 24.4s | $0.0483 | 0% | 2.0 | 84% |

Total spend for the 40 runs: **$1.27**.

## Block G → Block H

| Quadrant | p50 G → H | Cost G → H | Truncation G → H |
|---|---|---|---|
| zod fast | 46.8s → 26.7s (**−43%**) | $0.057 → $0.0059 (**−90%**) | 20% → 0% |
| zod quality | 76.5s → 23.9s (**−69%**) | $0.167 → $0.070 (**−58%**) | 40% → 0% |
| flask fast | 31.8s → 20.5s (**−36%**) | $0.048 → $0.0026 (**−95%**) | 20% → 0% |
| flask quality | 67.5s → 23.2s (**−66%**) | $0.135 → $0.048 (**−64%**) | 40% → 0% |

Phase medians (core / guide): Sonnet went from 41–48s / 25–28s to
9–15s / 7–8s. The guide phase now reads the core phase's cached prefix.

## Observations

- **Success rate 40/40** (Block G: 38/40). No hangs: the timeouts added
  after Block G's 874s socket hang were never triggered.
- **Truncation went to zero on both tiers.** Strict tool use guarantees
  the finish payload matches the schema; `coercedFields` was empty on all
  40 runs. The coercion code stays as a backstop.
- **The quality tier is no longer the slow tier.** In Block G Sonnet was
  1.6–2.1× slower than Haiku. In Block H, Sonnet 5.5 matches or beats
  Haiku 5.5 on wall-clock (23.9s vs 26.7s on zod) because it explores less
  (2.0–3.7 tool calls vs 3.7–5.6) and decides sooner. Cost is where the
  tiers now differ: Sonnet 5.5 is ~12–19× Haiku 5.5 per analysis.
- **Caching serves 64–88% of input tokens.** Higher on flask, where the
  loop is shorter relative to the shared prefix.
- **Fewer orchestrator tool calls** on every quadrant (G 5.4–7.1 → H
  2.0–5.6): the worker summaries cover files the orchestrator used to
  fetch.

## Caveats

1. **Cross-run cache warmth.** Consecutive runs on the same repo within 5
   minutes share the cached system + tools + initial-prompt prefix, so
   runs 2–10 start warmer than a first-time visitor. The cold first run of
   each batch landed close to the median (zod: 29.6s / $0.0066 fast, 24.4s
   / $0.069 quality; flask: 22.9s / $0.0040 fast, 24.4s / $0.070 quality),
   so the effect on latency is small; on cost the cold run is up to ~45%
   above the mean (flask quality).
2. **Not an ablation.** Model and harness changes landed together. The
   live AI Lab (per-call cache %, tool timings) is the place to attribute
   individual wins; a per-lever ablation is future work.
3. **N=10 per quadrant**, two repos. Treat percentages as directional.
4. An effort sweep (low/medium/high) was not run in this block; route
   defaults stay at `medium`.

---

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
- **Latency ratio per repo: ~1.63× on zod, ~2.12× on flask** (Sonnet p50 /
  Haiku p50, computed from the canonical JSONLs by `pnpm bench:summary`).
  Counter-intuitively, the *smaller* workload has the *wider* gap: flask
  finishes faster in absolute terms on Haiku (31.8s vs zod's 46.8s), but the
  Sonnet/Haiku spread widens because the per-call reasoning overhead is
  closer to fixed cost than to per-token cost — when the absolute latency
  shrinks, the fixed reasoning tax dominates the ratio. Either way, both
  numbers are far below Anthropic's published 4–5× throughput delta; agent
  loops live in reasoning, not raw tokens-per-second.
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
