# 🧭 reponboard-ai

> **AI-powered onboarding agent** — Reponboard any codebase in 5 minutes

The codebase tour you never got.

[![Live Demo](https://img.shields.io/badge/Live_Demo-reponboard--ai.vercel.app-blue?style=for-the-badge)](https://reponboard-ai.vercel.app)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

![reponboard-ai screenshot](docs/hero.png)

---

## 🎯 What It Does

An AI agent that analyzes any GitHub repo and turns it into a guided onboarding experience.

Paste a GitHub URL → Get an instant breakdown:

- **Executive Summary** — What this codebase does in 2 paragraphs
- **Architecture Pattern** — Detected pattern (Monolith, Monorepo, MVC, Layered, Event-Driven, Serverless, Jamstack, Library, …) with a rich descriptive subtitle
- **Your Onboarding Journey** — Interactive timeline of stops to follow, with checkmarks, progress bar, time estimates, and clickable file paths
- **Stack & Key Files** — Refined tech stack with reasoning, plus a categorized list of the files that matter and why
- **Interactive Q&A** — Floating chat to ask anything about the analyzed repo

---

## 🚀 Live Demo

**[https://reponboard-ai.vercel.app](https://reponboard-ai.vercel.app)**

> The demo is rate-limited to **5 analyses/day globally** and **3/day per IP** to keep hosting free. If you hit the limit, check back tomorrow or run it locally with your own API key.

---

## ✨ Features

- **Onboarding Journey** — Interactive timeline of stops with progress tracking, time estimates, and clickable GitHub links.
- **Architecture Detection** — Identifies the pattern (monolith, monorepo, microservices, MVC, layered, event-driven, serverless, jamstack, library) with a descriptive subtitle.
- **Intent-based Model Routing** — Pipeline supports `fast` (Haiku 4.5) and `quality` (Sonnet 4) intents per request. Benchmarked across 40 runs on canonical repos with findings on actual speed/cost/quality tradeoffs.
- **Stack Refinement** — Heuristic stack detection refined by Claude with reasoning you can read.
- **Key Files Summary** — Categorized file list annotated with what each file does and why it matters.
- **Interactive Q&A with Defense-in-Depth** — Floating chat drawer where a ReAct agent uses Claude tool_use to fetch files on demand. Four layers of defense (system prompt invariant, pre-flight classifier, post-hoc validator, structured observability) prevent multi-turn guardrail decay and hallucinated file references. Off-topic questions are declined with clickable suggestions for repo-scoped questions instead.
- **Markdown + Syntax Highlighting** — Q&A answers render with full markdown, Prism syntax highlighting for 10 languages, and inline file paths auto-linked to GitHub.
- **Resilient Error Handling** — Anthropic 529/503/network errors retry with exponential backoff; if exhausted, the UI surfaces a friendly fallback with a Retry button instead of raw error JSON.
- **Structured Observability** — Every Q&A request emits one [qa-telemetry] JSON log line with classification, cost, latency, validator outcomes, retries, and fatal errors.

![Q&A drawer with on-topic question](docs/qa-demo.png)

---

## 🏗️ How It Works

```
GitHub URL
    │
    ▼
┌─────────────────────┐
│  1. DISCOVERY       │  Fetch repo tree, detect stack, find entry points
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│  2. LLM ANALYSIS    │  ReAct agent (Claude tool_use) explores files
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│  3. GUIDE OUTPUT    │  Summary, pattern, journey, key files
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│  4. INTERACTIVE Q&A │  On-demand follow-up questions about the repo
└─────────────────────┘
```

### Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 15 (App Router, RSC), TypeScript strict, Tailwind CSS |
| UI primitives | shadcn/ui, lucide-react icons |
| AI Agent | Claude API with tool_use (Haiku for dev, Sonnet for prod) |
| Repo Parsing | GitHub REST API (tree endpoint, no cloning) |
| Streaming | NDJSON over Edge runtime fetch |
| Monorepo | pnpm workspaces |
| Deploy | Vercel (Edge runtime) |

---

## 🏛️ Architecture Highlights

- **Two-layer analysis pipeline** — Layer 1 (`discovery.ts`) does fast heuristic detection without any LLM call. Layer 2 (`llm-analysis.ts`) calls Claude only on the highest-value files, controlling cost and latency.
- **Q&A Defense-in-Depth** — Four layers (system prompt / classifier / validator / observability) reduce off-topic query cost from ~$0.023 to ~$0.001 (22x reduction) and eliminate hallucinated file references.
- **Intent-based LLM routing** — `fast` (Haiku) vs `quality` (Sonnet) intent per request, with empirical benchmark informing the tradeoff. Sonnet is not strictly better: truncation rate is actually higher on Sonnet (40%) than Haiku (20%) on this workload, which is why defensive coercion is a first-class concern.
- **ReAct agent with tool_use** — Both pipelines use Claude's tool_use API with bounded tool calls. `finish_core`, `finish_guide`, and `respond` are themselves tools, so structured output is enforced by the model API.
- **NDJSON streaming** — `/api/analyze` and `/api/qa` both stream progress events so users see perceived progress instead of dead air.
- **Upstash Redis rate limiting with env isolation** — Keys prefixed with environment (`prod:` / `preview:` / `dev:`) let local development share an Upstash DB with production without polluting counters.
- **Structured telemetry** — Every Q&A request emits one [qa-telemetry] JSON line with classification, cost, latency, validator outcomes, retries, and fatal errors. Read from Vercel logs.
- **Reusable agent-core package** — Agent logic lives in `packages/agent-core` independent of Next.js for future CLI, Slack bot, or other surfaces.

---

## 📊 Benchmark

A canonical benchmark (Block G, N=40) compared Haiku 4.5 and Sonnet 4 on this exact pipeline across two reference repos: `colinhacks/zod` and `pallets/flask`. Methodology documented in [BENCHMARK_NOTES.md](BENCHMARK_NOTES.md) at repo root. Results frozen as of May 2026 under `benchmark-results/block-g-final-canonical/`.

Headline findings:
- Sonnet/Haiku speed ratio: **1.5–1.8×** in practice (advertised 4-5× ratio does not hold for this workload)
- Cost ratio: **~3.0×** (Sonnet expectedly more expensive)
- Truncation rate: Sonnet truncates more often (**40%**) than Haiku (**20%**), despite making fewer tool calls overall. Defensive coercion in the codebase is therefore a feature, not a workaround.

The benchmark informed the intent-based routing decision: premium models are not strictly better for this workload, and defensive engineering matters more than model selection.

---

## 📈 Observability

Every Q&A request emits one structured JSON line to stdout:

```json
{
  "requestId": "...",
  "timestamp": "...",
  "repoUrl": "...",
  "questionLength": 41,
  "questionHashPrefix": "66113702",
  "classification": "on_topic",
  "classifierConfidence": 0.95,
  "classifierLatencyMs": 1162,
  "classifierDegradedMode": false,
  "toolCallsUsed": 2,
  "toolBudgetExhausted": false,
  "hallucinatedFileReferences": [],
  "responseRejectedByValidator": false,
  "retryCount": 0,
  "finalCostUsd": 0.013489,
  "finalLatencyMs": 9859,
  "historyLength": 1,
  "fatalError": null
}
```

Grep Vercel logs by `[qa-telemetry]` prefix. Useful queries:
- `classifierDegradedMode: true` → classifier failures
- `responseRejectedByValidator: true` → validator catches
- `finalCostUsd > 0.05` → expensive queries to investigate
- `fatalError != null` → unrecoverable errors

Persistent storage in Neon Postgres planned in Tier 2.

---

## 💻 Run Locally

```bash
# Clone the repo
git clone https://github.com/aamonterroso/reponboard-ai.git
cd reponboard-ai

# Install dependencies (requires pnpm)
pnpm install

# Set up environment variables
cp .env.example .env.local
# Edit .env.local and add your ANTHROPIC_API_KEY

# Start the dev server
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) and paste any public GitHub URL.

### Environment Variables

```bash
# .env.local
ANTHROPIC_API_KEY=sk-ant-...   # Required — get one at console.anthropic.com
GITHUB_TOKEN=ghp_...           # Optional — increases GitHub rate limit 60 → 5000/hr
LLM_MODE=development           # development (Haiku, fast) | production (Sonnet, accurate)
```

---

## 📁 Project Structure

```
reponboard-ai/
├── apps/
│   └── web/                          # Next.js application
│       ├── app/
│       │   ├── api/
│       │   │   ├── analyze/route.ts  # POST — streaming NDJSON analysis
│       │   │   ├── qa/route.ts       # POST — streaming Q&A (classifier
│       │   │   │                     # pre-flight, validator post-hoc,
│       │   │   │                     # telemetry emission)
│       │   │   └── remaining/route.ts # GET — daily quota left
│       │   └── page.tsx              # Landing + result view
│       └── components/
│           ├── analysis-result.tsx     # Result page (Journey, Stack, etc.)
│           ├── url-input.tsx           # Input form + stream consumer
│           ├── mermaid-diagram.tsx     # Mermaid renderer
│           └── qa-chat.tsx             # Floating Q&A drawer (markdown,
│                                      # suggestion chips, error fallback)
├── packages/
│   └── agent-core/                   # Reusable agent logic
│       └── src/
│           ├── anthropic-retry.ts      # 529/503/network retry helper
│           ├── discovery.ts            # Layer 1 — heuristic detection
│           ├── llm-analysis.ts         # Layer 2 — ReAct agent (tool_use)
│           ├── full-analysis.ts        # Orchestrator (generator stream)
│           ├── qa.ts                   # Q&A ReAct agent
│           ├── qa-classifier.ts        # Pre-flight classifier (Haiku 4.5)
│           ├── qa-validator.ts         # Post-hoc validator (hallucination
│           │                           # + recap detection)
│           ├── qa-telemetry.ts         # Structured observability emitter
│           └── types.ts                # Shared types
├── benchmark-results/
│   └── block-g-final-canonical/      # Frozen Haiku vs Sonnet dataset
├── BENCHMARK_NOTES.md                # Benchmark methodology
└── CLAUDE.md                         # Architecture / contribution guide
```

---

## ⚙️ Guardrails

| Guardrail | Details |
|-----------|---------|
| URL validation | Only accepts `github.com/<owner>/<repo>` URLs |
| Rate limiting | Upstash Redis: 5 analyses/day globally, 3/day per IP, daily TTL, env-prefixed keys |
| Q&A guardrail | Four-layer defense-in-depth (system prompt + classifier + validator + observability) |
| Q&A scope | Off-topic questions declined with clickable suggestions; classifier short-circuits before ReAct |
| SDK retry | 3 attempts × exponential backoff on 529/503/network errors |
| Error UI | Friendly fallback with Retry button; never exposes raw error JSON |
| Cost protection | Max 12 key files to LLM in analysis; classifier short-circuits off-topic at ~$0.001 |
| Timeout | 60s code-level cap on analysis; classifier 12s with retry |

### Deployment on Vercel Edge

The production demo runs on Vercel's free (Hobby) plan with Edge Functions. The advertised cap is 300s execution time provided the first byte is sent within 25s, which the NDJSON streaming architecture satisfies (first event within ~1s of request receipt). Empirical measurements have not yet stressed this cap; large repos that historically appeared truncated were likely hitting the 30s Serverless function limit rather than the Edge limit. If you encounter truncation in a forked deploy, verify the runtime is actually Edge in your function config.

For self-hosting:
- **Vercel Pro** — full 300s Edge duration ceiling
- **Cloudflare Workers (paid)**, **Fly.io**, **Railway**, or a small VPS — port is mostly mechanical since the agent code is runtime-agnostic via the agent-core package

---

## 🛠️ Development Commands

```bash
pnpm dev          # Start dev server (http://localhost:3000)
pnpm build        # Production build
pnpm typecheck    # Type checking
pnpm lint         # Linting
```

---

## 🗺️ Roadmap

**Just shipped:**
- Q&A guardrail defense-in-depth (4 layers)
- Markdown rendering + syntax highlighting + GitHub linkification
- Suggestion chips on off-topic refusals
- Anthropic SDK retry with UI error fallback
- Upstash Redis with env-prefixed keys (dev/preview/prod isolated)
- Empirical benchmark (Block G, N=40) for Haiku vs Sonnet on this exact pipeline

**Next sprint (P0 hot-fix):**
- Empty answer fallback for tool-budget-exhausted edge case
- Force `respond` tool_choice in Q&A budget-cap branch

**Shipping next:**
- AbortController timeouts across Anthropic SDK + GitHub fetch
- tool_use migration for analysis (eliminate truncation bugs)
- Validator retry feedback streamed to UI
- Neon Postgres + Drizzle for persistent telemetry
- Shareable analysis links `/analysis/{id}` with OG previews
- Session persistence across page refreshes
- CLI hybrid (`npx reponboard <url>` + browser open)

**Exploring:**
- PR/Commit Timeline Analyzer ("what changed while you were away")
- Slack delivery for engineering channel reports
- Model Lab (model selector + cost/latency telemetry visible per request)

---

## 📄 License

MIT © [Allan Monterroso](https://github.com/aamonterroso)

---

Powered by [Claude](https://anthropic.com). Built because every dev deserves a proper codebase tour.
