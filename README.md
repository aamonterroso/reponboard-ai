# 🧭 reponboard-ai

> **Reponboard any codebase in 5 minutes**

After 8+ years onboarding to legacy codebases, I built what I always wished I had.

[![Demo](https://img.shields.io/badge/Live_Demo-Visit-blue?style=for-the-badge)](https://reponboard.vercel.app)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

![Demo GIF](docs/demo.gif)

---

## 🎯 What It Does

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
git clone https://github.com/amonterroso/reponboard-ai.git
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
│  2. DEEP ANALYSIS   │  Map dependencies, identify patterns, find hotspots
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│  3. GUIDE GENERATION│  Summary, diagram, "start here" recommendations
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
| Agent | Claude API with tool use |
| Repo Parsing | GitHub API (tree endpoint) |
| Diagrams | Mermaid.js |
| Deploy | Vercel |

---

## 📁 Project Structure

```
reponboard-ai/
├── apps/
│   └── web/                 # Next.js application
│       ├── app/             # App Router pages
│       ├── components/      # React components
│       └── lib/             # Utilities and API clients
├── packages/
│   └── agent-core/          # Agent logic (reusable)
│       └── src/
│           ├── discovery.ts # Phase 1: Repo discovery
│           ├── analysis.ts  # Phase 2: Deep analysis
│           ├── guide.ts     # Phase 3: Guide generation
│           └── qa.ts        # Phase 4: Q&A
├── docs/
│   └── ARCHITECTURE.md      # System design documentation
└── examples/                # Sample outputs
```

---

## 🛠️ Development

```bash
# Run development server
pnpm dev

# Type checking
pnpm typecheck

# Linting
pnpm lint

# Run tests
pnpm test
```

---

## 🤝 Contributing

Contributions welcome! Please read [CONTRIBUTING.md](docs/CONTRIBUTING.md) first.

---

## 📄 License

MIT © [Allan Monterroso](https://github.com/amonterroso)

---

## 🙏 Acknowledgments

Built with [Claude](https://anthropic.com) by Anthropic. Inspired by the pain of onboarding to every legacy codebase I've touched in 8+ years.

---

**⭐ If this helped you, consider starring the repo!**
