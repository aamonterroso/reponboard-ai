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
│       │       │   └── route.ts   # Main analysis API (streaming NDJSON)
│       │       ├── qa/
│       │       │   └── route.ts   # Streaming NDJSON Q&A endpoint with
│       │       │                  # classifier pre-flight, validator post-hoc,
│       │       │                  # telemetry emission
│       │       └── remaining/
│       │           └── route.ts   # GET endpoint for daily quota remaining
│       └── components/
│           ├── url-input.tsx      # GitHub URL input + stream consumer
│           ├── analysis-result.tsx # Results display
│           ├── mermaid-diagram.tsx # Mermaid renderer
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
│           ├── qa.ts              # Q&A ReAct agent with system prompt +
│           │                      # tool dispatch
│           ├── qa-classifier.ts   # Pre-flight classifier (Haiku 4.5) with
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
│  STREAMING OUTPUT (NDJSON)                              │
│  - Phase events: discovery → fetching → analyzing       │
│  - Progress updates with counts                         │
│  - Final result or error                                │
└─────────────────────────────────────────────────────────┘
```

### Streaming Event Format

Progress events:
- `{ "phase": "discovery", "message": "..." }`
- `{ "phase": "analyzing", "message": "..." }`
- `{ "phase": "thinking", "message": "...", "toolCall": "...", "toolInput": {...} }`
- `{ "phase": "partial_core", "core": { ...refinedStack, executiveSummary, architectureInsights } }`
- `{ "phase": "partial_guide", "guide": { ...keyFiles, explorationPath, codebaseContext } }`

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
Cheap Haiku 4.5 call classifies each question as on_topic /
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
| AI | Claude API | Haiku 4.5 (dev/classifier), Sonnet 4 (prod) |
| Diagrams | Mermaid.js | Client-side rendering |
| Rate limiting | Upstash Redis | Env-prefixed keys (dev/preview/prod) |
| Streaming | NDJSON over Edge runtime | Progressive UI updates |
| Deploy | Vercel Edge Functions | Free tier (Hobby plan) |
| Monorepo | pnpm workspaces | Simple, efficient |
| Tests | vitest | 21+ tests across agent-core |

## LLM Routing & Benchmark

The pipeline supports two execution intents that map to different
models, balancing cost and quality:

- **Fast intent** → Haiku 4.5 (`claude-haiku-4-5-20251001`)
- **Quality intent** → Sonnet 4 (`claude-sonnet-4-20250514`)

Set via `LLM_MODE` environment variable: `development` uses
Haiku, `production` uses Sonnet. The Q&A classifier always uses
Haiku regardless of LLM_MODE, since classification is a
high-volume, latency-sensitive operation where Sonnet would be
overkill.

### Empirical benchmark (Block G, N=40)

A canonical dataset was produced comparing Haiku and Sonnet on
this exact pipeline across two repos (`colinhacks/zod` and
`pallets/flask`). Findings stored in
`benchmark-results/block-g-final-canonical/` (immutable as of
May 12, 2026). Methodology documented in `BENCHMARK_NOTES.md`
at repo root.

Highlights:
- Sonnet/Haiku speed ratio: **1.5–1.8× in practice** (the
  advertised 4-5× ratio does not hold for this workload)
- Cost ratio: ~3.0× (Sonnet expectedly more expensive)
- Truncation rate: Sonnet truncates at **40%** vs Haiku at
  **20%**, despite Sonnet making fewer tool calls overall.
  Defensive coercion in `coerceCorePartial` /
  `coerceGuidePartial` is therefore a feature, not a workaround.
- The strict `VALID_PATTERNS` coercion array (10-value
  ArchitecturePattern enum) prevents LLM free-form drift on
  both models.

### Why this matters

Premium models are not strictly better. Sonnet's higher
truncation rate means downstream code must handle missing fields
gracefully even (or especially) on the more expensive tier.
Intent-based routing lets the system pick the right tradeoff
per request type rather than committing globally to one model.

## Environment Variables

```bash
# .env.local
ANTHROPIC_API_KEY=sk-ant-...   # Required for LLM analysis
GITHUB_TOKEN=ghp_...           # Optional: 60 → 5000 req/hr
LLM_MODE=development           # development (Haiku) | production (Sonnet)
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

### Dual Model Support

```typescript
const MODELS = {
  development: 'claude-haiku-4-5-20251001',  // Fast, cheap
  production: 'claude-sonnet-4-20250514',    // Accurate, robust
}
```

Set via `LLM_MODE` env var. Haiku for local dev, Sonnet for prod.

### JSON Repair for Truncated Responses

Haiku sometimes truncates JSON output. `repairTruncatedJson()` handles:
- Unclosed strings/arrays/objects
- Trailing commas
- Missing brackets

### Key Files Limit

`MAX_KEY_FILES_FOR_LLM = 12` — caps files sent to LLM to keep prompt manageable.

## Current Status

### Completed (Production)
- ✅ Two-layer analysis pipeline (heuristic discovery + LLM
  ReAct with tool_use)
- ✅ Dual model support with intent-based routing (Haiku for
  fast/classifier, Sonnet for quality, via LLM_MODE)
- ✅ NDJSON streaming with partial_core / partial_guide events
- ✅ Defensive coercion (coerceCorePartial / coerceGuidePartial)
- ✅ Architecture pattern enum (10 values) + patternDescription
- ✅ Onboarding Journey timeline with checkmarks + progress
- ✅ Empirical benchmark (Block G, N=40) comparing Haiku vs
  Sonnet on this exact pipeline (zod + flask)
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
- ✅ 21+ unit tests across qa-classifier, qa-validator,
  anthropic-retry, qa-telemetry

### Known Issues (P0 — Next Sprint)
- 🐛 Empty answer string when QA tool budget exhausts on large
  repos (e.g., a repo with 19+ files in a single subdirectory).
  Cost can reach ~$0.18 with no useful UI output. Fix: validator
  detects empty answer + force `respond` tool_choice when
  budget hits cap.
- 🐛 QA tool budget exhausted instruction in tool_result is
  text-only, not enforced via tool_choice. Model occasionally
  ignores and keeps fetching until iteration cap.

### Backlog (Tier 1 — Robustness)
- AbortController timeouts on Anthropic SDK + GitHub fetch +
  benchmark wall-clock (no per-request timeout = unbounded wait)
- Migrate llm-analysis.ts from text parsing to tool_use for
  structured outputs (eliminate truncation bugs in guide phase)
- IP hashing (SHA-1 truncated) in Redis keys for IPv6 colon
  collisions + privacy
- Expose qa scope in /api/remaining response
- Validator retry latency UX (stream "retrying" phase event so
  user sees feedback during 40-60s retry; currently dead air)

### Backlog (Tier 2 — Infrastructure)
- Neon Postgres + Drizzle ORM for persistent telemetry storage
  (currently stdout-only via Vercel logs)
- Cache analyses by repo+SHA (Upstash KV)
- Cache GitHub tree across Q&A turns within same session

### Backlog (Tier 3 — Features)
- Shareable links /analysis/{id} with OG previews (requires DB)
- Session persistence (journey progress + analysis result across
  page refreshes)
- CLI hybrid (npx reponboard <url> with browser open for results)
- Model Lab (selector + telemetry visible per request)

### Backlog (Tier 4 — Big Features)
- PR/Commit Timeline Analyzer with durable execution
- Slack delivery of Timeline reports
- "What Changed While You Were Away" narrative

### Tech Debt
- Split llm-analysis.ts (~1033 lines, mixed concerns: schemas,
  prompts, ReAct loop, coercion, streaming)
- aria-expanded + focus management on collapsibles/dialog
- next lint deprecated in Next.js 16 — migrate to ESLint CLI

## Resources

- [Next.js 15 Docs](https://nextjs.org/docs)
- [Claude API Docs](https://docs.anthropic.com)
- [GitHub REST API](https://docs.github.com/en/rest)
- [Mermaid.js Docs](https://mermaid.js.org/intro/)
- [Tailwind CSS](https://tailwindcss.com/docs)
