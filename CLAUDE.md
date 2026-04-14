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
│       │       └── analyze/
│       │           └── route.ts   # Main analysis API (streaming NDJSON)
│       └── components/
│           ├── url-input.tsx      # GitHub URL input + stream consumer
│           ├── analysis-result.tsx # Results display
│           └── mermaid-diagram.tsx # Mermaid renderer
├── packages/
│   └── agent-core/          # Reusable agent logic (TypeScript)
│       └── src/
│           ├── index.ts           # Main exports
│           ├── types.ts           # TypeScript types + streaming events
│           ├── github.ts          # GitHub API client
│           ├── discovery.ts       # Layer 1: Heuristic discovery
│           ├── llm-analysis.ts    # Layer 2: Claude LLM analysis
│           └── full-analysis.ts   # Orchestrator (sync + streaming)
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
- `{ "phase": "discovery", "message": "Scanning repository structure..." }`
- `{ "phase": "fetching", "message": "Fetching 8 key files...", "progress": { "current": 3, "total": 8 } }`
- `{ "phase": "analyzing", "message": "AI is analyzing the codebase..." }`

Terminal events:
- `{ "phase": "complete", "result": { /* FullAnalysisResult */ } }`
- `{ "phase": "error", "error": "Rate limited by GitHub API" }`

## Tech Stack

| Layer | Tech | Notes |
|-------|------|-------|
| Framework | Next.js 15 | App Router, RSC-first |
| Language | TypeScript | Strict mode, no `any` |
| Styling | Tailwind CSS | Dark theme (zinc-950/zinc-100) |
| AI | Claude API | Haiku (dev), Sonnet (prod) |
| Diagrams | Mermaid.js | Client-side rendering |
| Deploy | Vercel | Free tier |
| Monorepo | pnpm workspaces | Simple, efficient |

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

### Completed
- ✅ Two-layer analysis (heuristics + LLM)
- ✅ Dual model support (Haiku dev / Sonnet prod)
- ✅ JSON truncation repair
- ✅ Key files limit (top 12)

### In Progress
- 🔄 Streaming + real loading states

### Backlog
1. UI polish with shadcn (2-3 hrs)
2. Collapsible sections (1 hr)
3. Exploration cache (1-2 hrs)
4. CLI wrapper (2 hrs)

### Tech Debt
- Migrate `llm-analysis.ts` from text parsing to `tool_use` for structured outputs

## Resources

- [Next.js 15 Docs](https://nextjs.org/docs)
- [Claude API Docs](https://docs.anthropic.com)
- [GitHub REST API](https://docs.github.com/en/rest)
- [Mermaid.js Docs](https://mermaid.js.org/intro/)
- [Tailwind CSS](https://tailwindcss.com/docs)
