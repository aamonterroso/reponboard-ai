# 🧭 reponboard-ai

> **AI-powered onboarding agent** — Reponboard any codebase in 5 minutes

The codebase tour you never got.

[![Live Demo](https://img.shields.io/badge/Live_Demo-reponboard--ai.vercel.app-blue?style=for-the-badge)](https://reponboard-ai.vercel.app)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

---

## 🎯 What It Does

An AI agent that analyzes any GitHub repo and generates a complete onboarding guide.

Paste a GitHub URL → Get an instant architecture breakdown:

- **Executive Summary** — What this codebase does in 2 paragraphs
- **Architecture Diagram** — Visual map of how components connect
- **"Start Here" Files** — Exactly where to begin reading
- **Key Patterns** — Conventions and patterns the codebase follows
- **Exploration Path** — Suggested order to understand the system

---

## 🚀 Live Demo

**[https://reponboard-ai.vercel.app](https://reponboard-ai.vercel.app)**

> The demo is rate-limited to **5 analyses/day globally** and **3/day per IP** to keep hosting free. If you hit the limit, check back tomorrow or run it locally with your own API key.

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
│  2. DEEP ANALYSIS   │  AI analyzes patterns, architecture, key files
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│  3. GUIDE OUTPUT    │  Summary, diagram, "start here" recommendations
└─────────────────────┘
```

### Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 15 (App Router), TypeScript, Tailwind CSS |
| AI Agent | Claude API (Haiku for dev, Sonnet for prod) |
| Repo Parsing | GitHub API (tree endpoint) |
| Diagrams | Mermaid.js |
| Deploy | Vercel |

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
│   └── web/                 # Next.js application
│       ├── app/             # App Router pages + API routes
│       │   └── api/
│       │       ├── analyze/     # POST — runs analysis, NDJSON streaming
│       │       └── remaining/   # GET  — returns daily analyses remaining
│       └── components/      # React components
├── packages/
│   └── agent-core/          # Agent logic (reusable)
│       └── src/
│           ├── discovery.ts     # Layer 1: Heuristic discovery
│           ├── llm-analysis.ts  # Layer 2: Claude analysis
│           └── full-analysis.ts # Orchestrator (streaming)
└── CLAUDE.md                # Project documentation
```

---

## ⚙️ Guardrails

| Guardrail | Details |
|-----------|---------|
| URL validation | Only accepts `github.com/<owner>/<repo>` URLs — no deep paths, no other hosts |
| Rate limiting | 5 analyses/day globally, 3/day per IP (in-memory, resets at midnight UTC) |
| Timeout | 60 s code-level cap on the analysis; Edge streams tokens so progress is visible |
| Cost protection | Max 12 key files sent to LLM, binary/lock files excluded, max 4096 tokens |

### Deployment constraint: Vercel free-tier Edge

The production demo runs on Vercel's free (Hobby) plan, where Edge Functions are hard-killed at ~30 s. Haiku occasionally needs longer than that for large repos, which will appear to the user as a truncated stream. To serve larger repos end-to-end, pick one:

- **Upgrade to Vercel Pro** — raises Edge duration to 300 s.
- **Self-host the API route** — move `apps/web/app/api/analyze` to a long-running runtime (Cloudflare Workers w/ paid plan, Fly.io, Railway, a small VPS) and proxy from Vercel. The code is Edge-compatible so the port is mostly mechanical.

---

## 🛠️ Development Commands

```bash
pnpm dev          # Start dev server (http://localhost:3000)
pnpm build        # Production build
pnpm typecheck    # Type checking
pnpm lint         # Linting
```

---

## 📄 License

MIT © [Allan Monterroso](https://github.com/aamonterroso)

---

Powered by [Claude](https://anthropic.com). Built because every dev deserves a proper codebase tour.
