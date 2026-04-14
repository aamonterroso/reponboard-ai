# 🧭 reponboard-ai

> **AI-powered onboarding agent** — Reponboard any codebase in 5 minutes

The codebase tour you never got.

[![Demo](https://img.shields.io/badge/Live_Demo-Visit-blue?style=for-the-badge)](https://reponboard.vercel.app)
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

Then ask follow-up questions: *"How does auth work?"* *"Where are API routes defined?"*

---

## 🚀 Quick Start

```bash
# Clone the repo
git clone https://github.com/aamonterroso/reponboard-ai.git
cd reponboard-ai

# Install dependencies
pnpm install

# Set up environment
cp .env.example .env.local
# Add your ANTHROPIC_API_KEY

# Run locally
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) and paste any public GitHub URL.

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
    │
    ▼
┌─────────────────────┐
│  4. INTERACTIVE Q&A │  Ask anything about the codebase
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

## 📁 Project Structure

```
reponboard-ai/
├── apps/
│   └── web/                 # Next.js application
│       ├── app/             # App Router pages + API routes
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

## ⚙️ Environment Variables

```bash
# .env.local
ANTHROPIC_API_KEY=sk-ant-...   # Required for AI analysis
GITHUB_TOKEN=ghp_...           # Optional: increases rate limit 60 → 5000/hr
LLM_MODE=development           # development (Haiku) | production (Sonnet)
```

---

## 🛠️ Development

```bash
pnpm dev          # Start dev server
pnpm build        # Production build
pnpm typecheck    # Type checking
pnpm lint         # Linting
```

---

## 🤝 Contributing

Contributions welcome! Please read [CONTRIBUTING.md](docs/CONTRIBUTING.md) first.

---

## 📄 License

MIT © [Allan Monterroso](https://github.com/aamonterroso)

---

## 🙏 Acknowledgments

Powered by [Claude](https://anthropic.com). Built because every dev deserves a proper codebase tour.

---

**⭐ If this helped you, consider starring the repo!**
