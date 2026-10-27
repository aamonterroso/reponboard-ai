# CLAUDE.md — reponboard-ai

## Project Overview

An AI-powered agent that analyzes any public GitHub repository and generates comprehensive onboarding documentation. Users paste a GitHub URL and receive an architecture breakdown, "start here" recommendations, and can ask follow-up questions about the codebase.

**Tagline:** "Reponboard any codebase in 5 minutes"

## Architecture

### Monorepo Structure

```
reponboard-ai/
├── apps/
│   └── web/                 # Next.js 15 App Router application
│       ├── app/
│       │   ├── page.tsx           # Landing page with URL input
│       │   ├── layout.tsx         # Root layout
│       │   ├── globals.css        # Global styles + Tailwind
│       │   └── api/
│       │       ├── analyze/
│       │       │   └── route.ts   # Main analysis API (SSE) + repo@SHA cache
│       │       ├── qa/
│       │       │   └── route.ts   # Streaming SSE Q&A endpoint with
│       │       │                  # classifier pre-flight, validator post-hoc,
│       │       │                  # telemetry emission
│       │       ├── remaining/
│       │       │   └── route.ts   # GET endpoint for daily quota remaining
│       │       └── keepalive/
│       │           └── route.ts   # Daily Vercel cron (CRON_SECRET) that keeps
│       │                          # the Upstash DB from being archived
│       ├── hooks/
│       │   └── use-analysis-stream.ts # Owns the /api/analyze SSE request
│       ├── lib/
│       │   ├── sse.ts             # Server SSE writer (ids, heartbeat)
│       │   ├── sse-client.ts      # POST-friendly SSE reader (eventsource-parser)
│       │   ├── analysis-stream.ts # Pure reducer: results view + AI Lab state
│       │   ├── analysis-cache.ts  # Upstash cache keyed by repo+SHA+intent
│       │   └── rate-limit.ts      # Upstash rate limits + budget cap (fail closed)
│       └── components/
│           ├── url-input.tsx      # URL input; lazy results + AI Lab split pane
│           ├── analysis-result.tsx # Results display (lazy-loads Q&A)
│           ├── ai-lab/
│           │   └── ai-lab-panel.tsx # Live agent trace: calls, tools, cache, cost
│           └── qa-chat.tsx        # Floating Q&A drawer with markdown
│                                  # rendering, suggestion chips, error
│                                  # fallback UI
├── packages/
│   └── agent-core/          # Reusable agent logic (TypeScript)
│       └── src/
│           ├── index.ts           # Main exports
│           ├── anthropic-retry.ts # Shared retry helper for 529/503/network
│           │                      # errors (3 attempts, exponential backoff)
│           ├── types.ts           # TypeScript types + streaming events
│           ├── github.ts          # GitHub API client
│           ├── discovery.ts       # Layer 1: Heuristic discovery
│           ├── llm-analysis.ts    # Layer 2: Claude LLM analysis
│           ├── full-analysis.ts   # Orchestrator (sync + streaming)
│           ├── file-workers.ts    # Orchestrator–worker fan-out (Haiku 5.5
│           │                      # summarizes secondary key files in parallel)
│           ├── trace.ts           # llm_call trace builder for the AI Lab
│           ├── pricing.ts         # Per-model rates incl. cache read/write
│           ├── qa.ts              # Q&A ReAct agent with system prompt +
│           │                      # tool dispatch
│           ├── qa-classifier.ts   # Pre-flight classifier (Haiku 5.5) with
│           │                      # retry, 12s timeout, and fail-closed
│           │                      # heuristic for degraded mode
│           ├── qa-telemetry.ts    # Structured observability emitter
│           │                      # ([qa-telemetry] JSON logs, FNV-1a hash)
│           └── qa-validator.ts    # Post-hoc validator (hallucinated files
│                                  # + recap pattern detection, 8 regexes)
├── package.json             # Root package.json
├── pnpm-workspace.yaml      # pnpm workspace config
└── CLAUDE.md                # This file
```

### Analysis Pipeline

```
GitHub URL
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  LAYER 1: DISCOVERY (heuristics, no LLM)                │
│  - Parse URL → fetch repo metadata                      │
│  - Get tree structure (recursive)                       │
│  - Detect stack from config files                       │
│  - Identify entry points + key files                    │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  LAYER 2: LLM ANALYSIS (Claude)                         │
│  - Receives discovery + key file contents               │
│  - Refines stack detection                              │
│  - Generates executive summary                          │
│  - Creates architecture insights                        │
│  - Recommends exploration path                          │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  STREAMING OUTPUT (Server-Sent Events)                  │
│  - Phase events: discovery → fetching → analyzing       │
│  - Progress updates with counts                         │
│  - Final result or error                                │
└─────────────────────────────────────────────────────────┘
```

### Streaming Event Format

Both streaming routes send `text/event-stream`. Each event's `event:`
name is its `phase`, `data:` is the JSON payload below, ids are
monotonic, and a `: ping` comment goes out every 15s.

Progress events:
- `{ "phase": "discovery", "message": "..." }`
- `{ "phase": "analyzing", "message": "..." }`
- `{ "phase": "thinking", "message": "...", "toolCall": "...", "toolInput": {...} }`
- `{ "phase": "partial_core", "core": { ...refinedStack, executiveSummary, architectureInsights } }`
- `{ "phase": "partial_guide", "guide": { ...keyFiles, explorationPath, codebaseContext } }`

Trace events (drive the AI Lab):
- `{ "phase": "llm_call", "call": { step, stage, model, latencyMs, tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, costUsd, toolUses, reasoning } }`
- `{ "phase": "tool_end", "tool": { toolUseId, name, label, durationMs, resultChars, status } }` (paired to the `thinking` event with the same `toolUseId`)
- `{ "phase": "cache_hit", "cachedAt": "..." }` (replayed analysis; followed by the stored trace and `complete`)

Terminal events:
- `{ "phase": "complete", "result": { /* FullAnalysisResult */ } }`
- `{ "phase": "error", "error": "..." }`

Note: 'fetching' is reserved in the AnalysisPhase type but
not currently emitted — it was removed when the ReAct agent
stopped batching file fetches into a discrete phase.

## Q&A Architecture

Beyond initial analysis, users can ask follow-up questions about
any analyzed repo. The Q&A pipeline ships with four layers of
defense against multi-turn guardrail decay (where an LLM operating
on accumulated history weakens its off-topic refusal):

### Layer 1 — Strengthened System Prompt
Re-evaluates SCOPE INVARIANT on every message regardless of
history. Explicit ANTI-PATTERNS list forbids recapping, inventing
file paths, or assuming continuation of intent across turns.

### Layer 2 — Pre-flight Classifier
Cheap Haiku 5.5 call (structured output, effort `low`) classifies each question as on_topic /
off_topic / needs_clarification before invoking the ReAct loop.
Off-topic short-circuits with a canned response and 0 tool calls,
reducing cost from ~$0.023 to ~$0.001 per off-topic query (22x
reduction). Includes retry, 12s timeout, and fail-closed
heuristic for transient classifier failures on suspicious queries.

### Layer 3 — Post-hoc Validator
After the ReAct loop produces an answer, validates that:
- filesReferenced only contains paths actually fetched this turn
  (hallucinated file detection)
- The answer does not match recap patterns (8 regex matching
  phrases like "As I mentioned previously", "in my previous
  answer", etc.)
Failed validation triggers one retry with a hardened instruction;
second failure produces a canned fallback.

### Layer 4 — Structured Observability
Every Q&A request emits one [qa-telemetry] JSON line to stdout
with classification, latency, cost, tool counts, validator
outcomes, fatal errors, and a FNV-1a hash prefix for dedup.
Currently read from Vercel logs; persistent storage in Neon
Postgres planned in Tier 2 backlog.

### Streaming Q&A Event Format

Progress events:
- `{ "phase": "thinking", "message": "...", "toolCall": "fetch_file", ... }`
- `{ "phase": "llm_call", "call": { ... } }`
- `{ "phase": "tool_result", "tool": "fetch_file", "summary": "..." }`

Terminal events:
- `{ "phase": "complete", "result": { answer, filesReferenced, costUsd, classification, suggestions?, meta } }`
- `{ "phase": "error", "error": "...", "errorCode": "...", "requestId": "..." }`

## Tech Stack

| Layer | Tech | Notes |
|-------|------|-------|
| Framework | Next.js 15 | App Router, RSC-first |
| Language | TypeScript | Strict mode, no `any` |
| Styling | Tailwind CSS | Dark theme (zinc-950/zinc-100) |
| UI primitives | shadcn/ui, lucide-react | Vercel/Linear-inspired |
| Markdown | react-markdown + remark-gfm | Q&A answer rendering |
| Syntax highlight | react-syntax-highlighter | Prism, 10 langs registered |
| AI | Claude API (`@anthropic-ai/sdk` 1.x) | Haiku 5.5 (fast/classifier/workers), Sonnet 5.5 (quality) |
| Rate limiting + cache | Upstash Redis | Env-prefixed keys (dev/preview/prod) |
| Streaming | SSE on Node.js (Fluid Compute) | eventsource-parser on the client |
| Fonts | next/font (Geist) | Self-hosted |
| Deploy | Vercel Functions, Node runtime | Hobby plan; daily keepalive cron |
| Monorepo | pnpm workspaces | Simple, efficient |
| Tests | vitest | agent-core + apps/web |

## LLM Routing & Benchmark

Intent-based routing (`LLM_MODEL_INTENT`):

- **fast** → Haiku 5.5 (`claude-haiku-5-5`)
- **quality** → Sonnet 5.5 (`claude-sonnet-5-5`) — production default

`LLM_MODE` (development → fast, production → quality) is deprecated but
still read. The Q&A classifier and the file workers always use Haiku 5.5.
The `parity` intent was removed with Sonnet 4's retirement (2026-06-15).

### Agent patterns in the pipeline

- **Prompt caching** — top-level auto `cache_control` on both ReAct
  loops; both analysis phases share one tool list so the guide phase
  reads the core phase's cached prefix.
- **Strict tool use** — `finish_core` / `finish_guide` / `respond` are
  `strict: true` with closed schemas (`withClosedObjects`).
- **Steering without forced tool_choice** — forced `tool_choice` 400s on
  Sonnet 5.5; the tool budget is enforced with an appended
  mid-conversation `role: "system"` message plus budget-exhausted tool
  results. History stays append-only (cache + thinking stay valid).
- **Parallel tool calls** — executed with `Promise.all`, all results in
  one user turn.
- **Orchestrator–worker** — Haiku 5.5 workers summarize 5 secondary key
  files in parallel before the core phase.
- **Adaptive thinking + effort** — `display: "summarized"` feeds the AI
  Lab; effort is set per route (classifier/workers `low`, others `medium`).

### Benchmarks

- **Block G** (May 2026, N=40, Haiku 4.5 vs Sonnet 4.6) —
  `benchmark-results/block-g-final-canonical/`, immutable.
- **Block H** (Oct 2026, N=40, Haiku 5.5 vs Sonnet 5.5, same protocol) —
  `benchmark-results/block-h-2026-10-27/`. Comparison in
  `BENCHMARK_NOTES.md`.

Defensive coercion (`coerceCorePartial` / `coerceGuidePartial`) stays as
a backstop even though strict tools should make it a no-op.

## Environment Variables

```bash
# .env.local
ANTHROPIC_API_KEY=sk-ant-...   # Required for LLM analysis
GITHUB_TOKEN=ghp_...           # Optional: 60 → 5000 req/hr
LLM_MODEL_INTENT=fast          # fast (Haiku 5.5) | quality (Sonnet 5.5)
CRON_SECRET=...                # Vercel cron auth for /api/keepalive (prod)
```

## Development Commands

```bash
pnpm install      # Install dependencies
pnpm dev          # Start dev server
pnpm build        # Production build
pnpm typecheck    # Type checking
pnpm lint         # Linting
```

## Code Style Guidelines

### General
- `async/await` over `.then()` chains
- Named exports: `export function foo()` not `export default`
- TypeScript strict mode — no `any` types
- Explicit return types on functions

### React/Next.js
- Server Components by default
- `'use client'` only when needed
- Use `next/navigation` for routing

### Styling
- Tailwind only — no CSS modules
- Dark theme default: `bg-zinc-950`, `text-zinc-100`
- Accent: `emerald-500` (CTAs), `blue-500` (links)
- Monospace for code: `font-mono`

### Error Handling
- Always try/catch with typed errors
- Return structured errors from API routes
- Graceful degradation when LLM fails

## Key Implementation Details

### Redis is fail-closed for spend, fail-open for display

An archived/throttled Upstash DB answers `200 {error}`; `withRedis` turns
that into `RateLimitUnavailableError`. `/api/analyze` and `/api/qa`
return 503 (the budget cap lives in Redis); `/api/remaining` returns
nulls. The analysis cache treats every failure as a miss.

### Timeouts

GitHub requests 15s (`AbortSignal.timeout`), Anthropic calls 60s (SDK
`timeout`), benchmark runs 180s wall-clock, analysis route 120s.

### Key Files Limit

`MAX_KEY_FILES_FOR_LLM = 12` — caps files sent to LLM to keep prompt manageable.

## Current Status

### Completed (Production)
- ✅ Two-layer analysis pipeline (heuristic discovery + LLM
  ReAct with tool_use)
- ✅ Intent-based routing on Claude 5.5 (Haiku 5.5 fast /
  classifier / workers, Sonnet 5.5 quality), SDK 1.x (Oct 2026)
- ✅ SSE streaming with partial_core / partial_guide and agent
  trace events (llm_call, tool_end)
- ✅ AI Lab split pane: live trace of model calls, tool calls,
  cache-hit %, tokens, cost, reasoning summaries
- ✅ Prompt caching, strict tool use, parallel tool calls,
  orchestrator–worker fan-out, adaptive thinking with effort
- ✅ Analysis cache by repo + HEAD SHA + intent (Upstash, 7d)
- ✅ Code-split results / Lab / Q&A (React.lazy + Suspense);
  `/` first-load JS 189 kB → 123 kB
- ✅ Upstash keepalive cron + fail-closed Redis handling
  (post-mortem: 2026-10-26 outage from inactivity archival)
- ✅ Node.js runtime (Edge removed), request timeouts everywhere
- ✅ Defensive coercion (coerceCorePartial / coerceGuidePartial)
- ✅ Architecture pattern enum (10 values) + patternDescription
- ✅ Onboarding Journey timeline with checkmarks + progress
- ✅ Empirical benchmarks: Block G (N=40, May 2026) and Block H
  (N=40, Oct 2026, Claude 5.5) on this exact pipeline (zod + flask)
- ✅ Q&A pipeline with four-layer defense-in-depth guardrail
  (system prompt + classifier + validator + observability)
- ✅ Q&A markdown rendering (react-markdown + Prism syntax
  highlight + GitHub linkification of inline file paths)
- ✅ Q&A off-topic suggestion chips (clickable, auto-submit)
- ✅ Anthropic SDK retry helper (3 attempts, exp backoff,
  skips 4xx)
- ✅ UI error fallback with Retry button (no raw JSON exposed)
- ✅ Upstash Redis rate limiting with env-prefixed keys
  (prod / preview / dev isolated in same DB)
- ✅ ~107 unit tests (agent-core + apps/web vitest)

### Known Issues
- None open at P0. The QA empty-answer and ignored-budget bugs were
  fixed in Oct 2026 (one corrective retry + canned fallback; post-budget
  tool calls are answered without running).

### Backlog (Tier 1 — Robustness)
- IP hashing (SHA-1 truncated) in Redis keys for IPv6 colon
  collisions + privacy
- Expose qa scope in /api/remaining response
- Validator retry latency UX (stream "retrying" phase event so
  user sees feedback during 40-60s retry; currently dead air)

### Backlog (Tier 2 — Infrastructure)
- Neon Postgres + Drizzle ORM for persistent telemetry storage
  (currently stdout-only via Vercel logs)
- Cache GitHub tree across Q&A turns within same session

### Backlog (Tier 3 — Features)
- Shareable links /analysis/{id} with OG previews (requires DB)
- Session persistence (journey progress + analysis result across
  page refreshes)
- CLI hybrid (npx reponboard <url> with browser open for results)
- Model selector in the AI Lab (pick fast/quality per request;
  the trace view already exists)

### Backlog (Tier 4 — Big Features)
- PR/Commit Timeline Analyzer with durable execution
- Slack delivery of Timeline reports
- "What Changed While You Were Away" narrative

### Tech Debt
- Analysis cancel on client disconnect stops after the in-flight
  step; QA route has no cancel() hook yet
- Split llm-analysis.ts (~1300 lines, mixed concerns: schemas,
  prompts, ReAct loop, coercion, streaming)
- aria-expanded + focus management on collapsibles/dialog
- next lint deprecated in Next.js 16 — migrate to ESLint CLI

## Resources

- [Next.js 15 Docs](https://nextjs.org/docs)
- [Claude API Docs](https://docs.anthropic.com)
- [GitHub REST API](https://docs.github.com/en/rest)
- [Tailwind CSS](https://tailwindcss.com/docs)
